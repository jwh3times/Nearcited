import {
  BillingRedirectSchema,
  OperatorPlanSchema,
  type Organization,
  OrganizationAccountSchema,
  type Plan,
  type PriceChangeMessage,
  PriceChangeSchema,
  SubscriptionChangeSchema,
} from "@nearcited/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  type BilledItem,
  type CheckoutRequest,
  PaymentDeclinedError,
  type Payments,
  type ProviderSubscription,
  SignatureError,
} from "../src/billing/types";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const operator = "f0000000-0000-4000-8000-000000000006";

let db: MemoryDb;
let env: Env;
/** What the provider would say about each subscription, by its ID. */
let atProvider: Map<string, ProviderSubscription>;
let checkouts: CheckoutRequest[];
let portals: { customerId: string; returnUrl: string }[];
let configured: boolean;
/** What the stand-in provider was asked to do to a subscription, in order. */
let changes: {
  what: "now" | "at-period-end" | "keep" | "reprice";
  id: string;
  items?: BilledItem[];
}[];
let cardDeclines: boolean;
/** The prices the stand-in provider was asked to make. */
let made: { like: string | null; product_name: string; cents: number }[];
/** The price change steps put on the queue. */
let steps: PriceChangeMessage[];

/** A provider whose webhook body is just the subscription's ID, signed with the word "signed". */
const payments: Payments = {
  async createCheckout(request) {
    checkouts.push(request);
    return "https://checkout.example/session";
  },
  async createPortal(customerId, returnUrl) {
    portals.push({ customerId, returnUrl });
    return "https://portal.example/session";
  },
  async readEvent(body, signature) {
    if (signature !== "signed") throw new SignatureError();
    return body === "something-else" ? null : body;
  },
  async getSubscription(id) {
    return atProvider.get(id) ?? null;
  },
  async previewChange() {
    return 1234;
  },
  async changeNow(id, items) {
    if (cardDeclines) throw new PaymentDeclinedError();
    changes.push({ what: "now", id, items });
  },
  async changeAtPeriodEnd(id, items) {
    changes.push({ what: "at-period-end", id, items });
  },
  async keepCurrent(id) {
    changes.push({ what: "keep", id });
  },
  async reprice(id, items) {
    changes.push({ what: "reprice", id, items });
  },
  async createPrice(price) {
    made.push(price);
    return `price_new_${made.length}`;
  },
};

const app = createApp({
  authenticate: async (request) => {
    const userId = request.headers.get("Authorization")?.replace("Bearer ", "");
    return userId
      ? { user: { id: userId, email: `${userId}@example.com` }, store: memoryStore(db, userId) }
      : null;
  },
  publicStore: () => memoryStore(db, "nobody"),
  workerStore: () => memoryStore(db, null),
  payments: () => (configured ? payments : null),
});

function call(user: string | null, method: string, path: string, body?: unknown) {
  return app.request(
    `/api${path}`,
    {
      method,
      headers: {
        ...(user ? { Authorization: `Bearer ${user}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

const webhook = (body: string, signature: string | null = "signed") =>
  app.request(
    "/api/stripe/webhook",
    {
      method: "POST",
      headers: signature === null ? {} : { "Stripe-Signature": signature },
      body,
    },
    env,
  );

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

const plan = (key: string, position: number, extra: Partial<Plan> = {}): Plan => ({
  key,
  name: key,
  position,
  on_sale: true,
  price_cents: position * 1000,
  included_locations: 1,
  extra_location_price_cents: null,
  max_queries_per_location: 2 + position,
  assistants: 1,
  scan_every_days: 14,
  max_manual_scans_per_month: position,
  emails_report: position > 0,
  stronger_models: false,
  ...extra,
});

async function organizationFor(user: string): Promise<Organization> {
  const response = await call(user, "POST", "/organizations", { name: "Raleigh Pizza Group" });
  const organization = (await response.json()) as Organization;
  // As the database does for a new organization.
  await memoryStore(db, null).applyPlan(organization.id, "free");
  return organization;
}

const subscription = (
  organizationId: string | null,
  extra: Partial<ProviderSubscription> = {},
): ProviderSubscription => ({
  id: "sub_1",
  customer_id: "cus_1",
  status: "active",
  organization_id: organizationId,
  items: [{ price_id: "price_standard", quantity: 1 }],
  period_end: "2026-11-09T00:00:00.000Z",
  pending: null,
  ...extra,
});

const current = (id: string) => db.organizations.find((o) => o.id === id);

beforeEach(() => {
  db = createMemoryDb();
  db.plans.push(
    plan("free", 0),
    plan("starter", 1),
    plan("standard", 2, { included_locations: 3, extra_location_price_cents: 1500, assistants: 2 }),
    plan("retired", 9, { on_sale: false }),
  );
  db.planPrices.set("starter", { base: "price_starter", extra: null });
  db.planPrices.set("standard", { base: "price_standard", extra: "price_standard_location" });
  db.planPrices.set("retired", { base: "price_retired", extra: null });
  atProvider = new Map();
  checkouts = [];
  portals = [];
  configured = true;
  changes = [];
  cardDeclines = false;
  made = [];
  steps = [];
  env = {
    PROVIDER_MODE: "mock",
    APP_URL: "https://app.example",
    RESEND_API_KEY: "re_test",
    SCAN_QUEUE: {
      sendBatch: async (messages: { body: PriceChangeMessage }[]) => {
        steps.push(...messages.map((message) => message.body));
      },
    },
  } as unknown as Env;
});

describe("checkout", () => {
  it("sends the owner to the provider's checkout for the plan they chose", async () => {
    const organization = await organizationFor(alice);
    const response = await call(alice, "POST", `/organizations/${organization.id}/checkout`, {
      plan_key: "starter",
    });
    expect(response.status).toBe(200);
    expect(BillingRedirectSchema.parse(await response.json())).toEqual({
      url: "https://checkout.example/session",
    });
    expect(checkouts).toEqual([
      {
        organization_id: organization.id,
        customer_id: null,
        email: `${alice}@example.com`,
        items: [{ price_id: "price_starter", quantity: 1 }],
        success_url: "https://app.example/settings?billing=subscribed",
        cancel_url: "https://app.example/settings?billing=cancelled",
      },
    ]);
  });

  it("charges for each location beyond those the plan includes", async () => {
    const organization = await organizationFor(alice);
    await call(alice, "POST", `/organizations/${organization.id}/checkout`, {
      plan_key: "standard",
      locations: 5,
    });
    expect(checkouts[0]?.items).toEqual([
      { price_id: "price_standard", quantity: 1 },
      { price_id: "price_standard_location", quantity: 2 },
    ]);
  });

  it("asks for no more than the plan when fewer locations are named than it includes", async () => {
    const organization = await organizationFor(alice);
    await call(alice, "POST", `/organizations/${organization.id}/checkout`, {
      plan_key: "standard",
      locations: 2,
    });
    expect(checkouts[0]?.items).toEqual([{ price_id: "price_standard", quantity: 1 }]);
  });

  it("refuses more locations than a plan can have", async () => {
    const organization = await organizationFor(alice);
    const response = await call(alice, "POST", `/organizations/${organization.id}/checkout`, {
      plan_key: "starter",
      locations: 2,
    });
    expect(response.status).toBe(422);
    expect(checkouts).toEqual([]);
  });

  it("refuses a plan that is free, off sale, unknown or not set up at the provider", async () => {
    const organization = await organizationFor(alice);
    db.plans.push(plan("pro", 3));
    for (const plan_key of ["free", "retired", "nonesuch", "pro"]) {
      const response = await call(alice, "POST", `/organizations/${organization.id}/checkout`, {
        plan_key,
      });
      expect(response.status, plan_key).toBe(422);
      expect(await errorCode(response)).toBe("plan_unavailable");
    }
    expect(checkouts).toEqual([]);
  });

  it("is the owner's alone: not a member's, a stranger's or the operator's", async () => {
    const organization = await organizationFor(alice);
    const member = "c0000000-0000-4000-8000-000000000003";
    db.memberships.push({ organization_id: organization.id, user_id: member, role: "member" });
    db.operators.add(operator);
    for (const user of [member, bob, operator]) {
      const response = await call(user, "POST", `/organizations/${organization.id}/checkout`, {
        plan_key: "starter",
      });
      expect(response.status, user).toBe(404);
    }
    const anonymous = await call(null, "POST", `/organizations/${organization.id}/checkout`, {
      plan_key: "starter",
    });
    expect(anonymous.status).toBe(401);
    expect(checkouts).toEqual([]);
  });

  it("reuses the provider's customer for an organization that has subscribed before", async () => {
    const organization = await organizationFor(alice);
    db.subscriptions.set(organization.id, {
      stripe_customer_id: "cus_1",
      stripe_subscription_id: null,
      status: "canceled",
    });
    await call(alice, "POST", `/organizations/${organization.id}/checkout`, {
      plan_key: "starter",
    });
    expect(checkouts[0]).toMatchObject({ customer_id: "cus_1", email: null });
  });

  it("refuses an organization that already has a subscription", async () => {
    const organization = await organizationFor(alice);
    db.subscriptions.set(organization.id, {
      stripe_customer_id: "cus_1",
      stripe_subscription_id: "sub_1",
      status: "active",
    });
    const response = await call(alice, "POST", `/organizations/${organization.id}/checkout`, {
      plan_key: "standard",
    });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("already_subscribed");
    expect(checkouts).toEqual([]);
  });

  it("refuses a test organization, which pays for nothing", async () => {
    db.testAccounts.add(alice);
    const organization = await organizationFor(alice);
    const response = await call(alice, "POST", `/organizations/${organization.id}/checkout`, {
      plan_key: "starter",
    });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("test_organization");
  });

  it("says so when the deployment has no payment provider set up", async () => {
    const organization = await organizationFor(alice);
    configured = false;
    const response = await call(alice, "POST", `/organizations/${organization.id}/checkout`, {
      plan_key: "starter",
    });
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("billing_unavailable");
  });
});

describe("an organization's account", () => {
  const account = async (user: string, organizationId: string) => {
    const response = await call(user, "GET", `/organizations/${organizationId}/account`);
    return response.status === 200
      ? OrganizationAccountSchema.parse(await response.json())
      : response.status;
  };

  it("tells its owner where billing stands, before and after subscribing", async () => {
    const organization = await organizationFor(alice);
    expect(await account(alice, organization.id)).toEqual({
      manual_scans_used: 0,
      billing: {
        available: true,
        subscribed: false,
        status: null,
        has_customer: false,
        locations: null,
        renews_at: null,
        paying: null,
        price_change: null,
        pending: null,
      },
    });

    atProvider.set("sub_1", subscription(organization.id, { status: "past_due" }));
    await webhook("sub_1");
    expect(await account(alice, organization.id)).toMatchObject({
      billing: { subscribed: true, status: "past_due", has_customer: true },
    });

    atProvider.set("sub_1", subscription(organization.id, { status: "canceled" }));
    await webhook("sub_1");
    expect(await account(alice, organization.id)).toMatchObject({
      billing: { subscribed: false, status: "canceled", has_customer: true },
    });
  });

  it("counts the scans started by hand this month", async () => {
    const organization = await organizationFor(alice);
    await memoryStore(db, null).applyPlan(organization.id, "standard");
    const location = await memoryStore(db, alice).createLocation(organization.id, {
      name: "Joe's Pizza",
      city: "Raleigh",
    } as Parameters<ReturnType<typeof memoryStore>["createLocation"]>[1]);
    const scan = await memoryStore(db, alice).createScan(location.id, "manual", alice);
    await memoryStore(db, null).failScan(scan.id, "not run");
    expect(await account(alice, organization.id)).toMatchObject({ manual_scans_used: 1 });
  });

  it("shows a member and the operator the usage, and nothing about billing", async () => {
    const organization = await organizationFor(alice);
    const member = "c0000000-0000-4000-8000-000000000003";
    db.memberships.push({ organization_id: organization.id, user_id: member, role: "member" });
    db.operators.add(operator);
    for (const user of [member, operator]) {
      expect(await account(user, organization.id), user).toEqual({
        manual_scans_used: 0,
        billing: null,
      });
    }
  });

  it("does not exist for a stranger", async () => {
    const organization = await organizationFor(alice);
    expect(await account(bob, organization.id)).toBe(404);
  });

  it("says when the deployment has no payment provider, so nothing offers a subscription", async () => {
    const organization = await organizationFor(alice);
    configured = false;
    expect(await account(alice, organization.id)).toMatchObject({
      billing: { available: false },
    });
  });
});

describe("changing a subscription", () => {
  /** Alice's organization on Standard with four locations paid for: one more than it includes. */
  async function onStandard() {
    const organization = await organizationFor(alice);
    atProvider.set(
      "sub_1",
      subscription(organization.id, {
        items: [
          { price_id: "price_standard", quantity: 1 },
          { price_id: "price_standard_location", quantity: 1 },
        ],
      }),
    );
    await webhook("sub_1");
    return organization;
  }
  const change = async (
    user: string,
    organizationId: string,
    body: unknown,
    method: "preview" | "apply" = "apply",
  ) => {
    const response =
      method === "preview"
        ? await call(user, "POST", `/organizations/${organizationId}/subscription/preview`, body)
        : await call(user, "PUT", `/organizations/${organizationId}/subscription`, body);
    return response.status === 200
      ? SubscriptionChangeSchema.parse(await response.json())
      : `${response.status} ${await errorCode(response)}`;
  };

  beforeEach(() => {
    db.plans.push(plan("pro", 13, { included_locations: 3, extra_location_price_cents: 3500 }));
    db.planPrices.set("pro", { base: "price_pro", extra: "price_pro_location" });
  });

  it("shows the owner what is paid for, when it renews and what is waiting", async () => {
    const organization = await onStandard();
    atProvider.set(
      "sub_1",
      subscription(organization.id, {
        items: [
          { price_id: "price_standard", quantity: 1 },
          { price_id: "price_standard_location", quantity: 1 },
        ],
        pending: [{ price_id: "price_starter", quantity: 1 }],
      }),
    );
    const response = await call(alice, "GET", `/organizations/${organization.id}/account`);
    expect(OrganizationAccountSchema.parse(await response.json()).billing).toMatchObject({
      locations: 4,
      renews_at: "2026-11-09T00:00:00.000Z",
      pending: {
        plan_key: "starter",
        locations: 1,
        monthly_cents: 1000,
        at: "2026-11-09T00:00:00.000Z",
      },
    });
  });

  it("previews an upgrade with what is charged now, and changes nothing", async () => {
    const organization = await onStandard();
    expect(await change(alice, organization.id, { plan_key: "pro" }, "preview")).toEqual({
      kind: "upgrade",
      plan_key: "pro",
      locations: 3,
      monthly_cents: 13000,
      due_now_cents: 1234,
      effective_at: null,
    });
    expect(changes).toEqual([]);
  });

  it("makes an upgrade at once", async () => {
    const organization = await onStandard();
    expect(await change(alice, organization.id, { plan_key: "pro", locations: 5 })).toMatchObject({
      kind: "upgrade",
      locations: 5,
      monthly_cents: 13000 + 2 * 3500,
    });
    expect(changes).toEqual([
      {
        what: "now",
        id: "sub_1",
        items: [
          { price_id: "price_pro", quantity: 1 },
          { price_id: "price_pro_location", quantity: 2 },
        ],
      },
    ]);
    // The plan itself moves when the provider reports the change, not on the owner's request.
    expect(current(organization.id)?.plan_key).toBe("standard");
  });

  it("counts more locations on the same plan as an upgrade", async () => {
    const organization = await onStandard();
    expect(
      await change(alice, organization.id, { plan_key: "standard", locations: 6 }),
    ).toMatchObject({ kind: "upgrade", locations: 6 });
    expect(changes[0]).toMatchObject({
      what: "now",
      items: [
        { price_id: "price_standard", quantity: 1 },
        { price_id: "price_standard_location", quantity: 3 },
      ],
    });
  });

  it("holds a downgrade until the period paid for ends, and charges nothing", async () => {
    const organization = await onStandard();
    for (const [body, items] of [
      [{ plan_key: "starter" }, [{ price_id: "price_starter", quantity: 1 }]],
      [{ plan_key: "standard", locations: 3 }, [{ price_id: "price_standard", quantity: 1 }]],
    ] as const) {
      changes = [];
      expect(await change(alice, organization.id, body)).toMatchObject({
        kind: "downgrade",
        due_now_cents: null,
        effective_at: "2026-11-09T00:00:00.000Z",
      });
      expect(changes).toEqual([{ what: "at-period-end", id: "sub_1", items }]);
    }
  });

  it("judges a bigger plan with fewer locations by what it costs", async () => {
    const organization = await organizationFor(alice);
    // Standard with eleven locations costs more here than Pro with the three it includes.
    atProvider.set(
      "sub_1",
      subscription(organization.id, {
        items: [
          { price_id: "price_standard", quantity: 1 },
          { price_id: "price_standard_location", quantity: 8 },
        ],
      }),
    );
    await webhook("sub_1");
    expect(await change(alice, organization.id, { plan_key: "pro" })).toMatchObject({
      kind: "downgrade",
    });
  });

  it("refuses the plan it is already on, a plan not for sale and more locations than one takes", async () => {
    const organization = await onStandard();
    expect(await change(alice, organization.id, { plan_key: "standard", locations: 4 })).toBe(
      "422 no_change",
    );
    expect(await change(alice, organization.id, { plan_key: "free" })).toBe("422 plan_unavailable");
    expect(await change(alice, organization.id, { plan_key: "retired" })).toBe(
      "422 plan_unavailable",
    );
    expect(await change(alice, organization.id, { plan_key: "starter", locations: 2 })).toBe(
      "422 plan_unavailable",
    );
    expect(changes).toEqual([]);
  });

  it("says so, having changed nothing, when the card is declined", async () => {
    const organization = await onStandard();
    cardDeclines = true;
    expect(await change(alice, organization.id, { plan_key: "pro" })).toBe("402 payment_declined");
    expect(changes).toEqual([]);
  });

  it("waits for an outstanding payment to be settled", async () => {
    const organization = await onStandard();
    atProvider.set("sub_1", subscription(organization.id, { status: "past_due" }));
    expect(await change(alice, organization.id, { plan_key: "pro" })).toBe("409 payment_due");
    expect(changes).toEqual([]);
  });

  it("lets the owner keep the current plan instead of a change that is waiting", async () => {
    const organization = await onStandard();
    const response = await call(
      alice,
      "DELETE",
      `/organizations/${organization.id}/subscription/pending`,
    );
    expect(response.status).toBe(204);
    expect(changes).toEqual([{ what: "keep", id: "sub_1" }]);
  });

  it("is the owner's alone, and needs a subscription", async () => {
    const organization = await onStandard();
    const member = "c0000000-0000-4000-8000-000000000003";
    db.memberships.push({ organization_id: organization.id, user_id: member, role: "member" });
    db.operators.add(operator);
    for (const user of [member, bob, operator]) {
      expect(await change(user, organization.id, { plan_key: "pro" })).toBe("404 not_found");
      expect(await change(user, organization.id, { plan_key: "pro" }, "preview")).toBe(
        "404 not_found",
      );
      const kept = await call(
        user,
        "DELETE",
        `/organizations/${organization.id}/subscription/pending`,
      );
      expect(kept.status).toBe(404);
    }
    expect(changes).toEqual([]);

    db.subscriptions.clear();
    expect(await change(alice, organization.id, { plan_key: "pro" })).toBe("409 no_subscription");
  });
});

describe("the account pages", () => {
  it("open for the owner of an organization the provider knows", async () => {
    const organization = await organizationFor(alice);
    db.subscriptions.set(organization.id, {
      stripe_customer_id: "cus_1",
      stripe_subscription_id: "sub_1",
      status: "active",
    });
    const response = await call(alice, "POST", `/organizations/${organization.id}/billing-portal`);
    expect(response.status).toBe(200);
    expect(BillingRedirectSchema.parse(await response.json())).toEqual({
      url: "https://portal.example/session",
    });
    expect(portals).toEqual([{ customerId: "cus_1", returnUrl: "https://app.example/settings" }]);
  });

  it("do not open for anyone else, or before the organization has been through checkout", async () => {
    const organization = await organizationFor(alice);
    const before = await call(alice, "POST", `/organizations/${organization.id}/billing-portal`);
    expect(before.status).toBe(409);
    expect(await errorCode(before)).toBe("no_subscription");

    db.subscriptions.set(organization.id, {
      stripe_customer_id: "cus_1",
      stripe_subscription_id: "sub_1",
      status: "active",
    });
    const stranger = await call(bob, "POST", `/organizations/${organization.id}/billing-portal`);
    expect(stranger.status).toBe(404);
    expect(portals).toEqual([]);
  });
});

describe("the provider's webhook", () => {
  it("needs no sign-in, and turns away anything the provider did not sign", async () => {
    const organization = await organizationFor(alice);
    atProvider.set("sub_1", subscription(organization.id));
    for (const signature of ["forged", null]) {
      const response = await webhook("sub_1", signature);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("invalid_signature");
    }
    expect(current(organization.id)?.plan_key).toBe("free");
    expect(db.subscriptions.size).toBe(0);
  });

  it("puts the organization on the plan it subscribed to", async () => {
    const organization = await organizationFor(alice);
    atProvider.set("sub_1", subscription(organization.id));
    const response = await webhook("sub_1");
    expect(response.status).toBe(200);
    expect(current(organization.id)).toMatchObject({
      plan_key: "standard",
      max_locations: 3,
      max_queries_per_location: 4,
    });
    expect(db.subscriptions.get(organization.id)).toEqual({
      stripe_customer_id: "cus_1",
      stripe_subscription_id: "sub_1",
      status: "active",
    });
  });

  it("counts the locations paid for beyond those the plan includes", async () => {
    const organization = await organizationFor(alice);
    atProvider.set(
      "sub_1",
      subscription(organization.id, {
        items: [
          { price_id: "price_standard_location", quantity: 2 },
          { price_id: "price_standard", quantity: 1 },
        ],
      }),
    );
    await webhook("sub_1");
    expect(current(organization.id)).toMatchObject({ plan_key: "standard", max_locations: 5 });
  });

  it("follows a change of plan made on the provider's pages", async () => {
    const organization = await organizationFor(alice);
    atProvider.set("sub_1", subscription(organization.id));
    await webhook("sub_1");
    atProvider.set(
      "sub_1",
      subscription(organization.id, { items: [{ price_id: "price_starter", quantity: 1 }] }),
    );
    await webhook("sub_1");
    expect(current(organization.id)).toMatchObject({ plan_key: "starter", max_locations: 1 });
  });

  it("keeps the plan while a payment is being retried", async () => {
    const organization = await organizationFor(alice);
    atProvider.set("sub_1", subscription(organization.id));
    await webhook("sub_1");
    atProvider.set("sub_1", subscription(organization.id, { status: "past_due" }));
    await webhook("sub_1");
    expect(current(organization.id)?.plan_key).toBe("standard");
    expect(db.subscriptions.get(organization.id)?.status).toBe("past_due");
  });

  it("moves the organization to the free plan when its subscription ends or goes unpaid", async () => {
    for (const status of ["canceled", "unpaid"]) {
      db.organizations.length = 0;
      db.memberships.length = 0;
      db.subscriptions.clear();
      const organization = await organizationFor(alice);
      atProvider.set("sub_1", subscription(organization.id));
      await webhook("sub_1");
      atProvider.set("sub_1", subscription(organization.id, { status }));
      expect((await webhook("sub_1")).status).toBe(200);
      expect(current(organization.id), status).toMatchObject({
        plan_key: "free",
        max_locations: 1,
      });
      // The customer is kept, so subscribing again reuses it.
      expect(db.subscriptions.get(organization.id)).toEqual({
        stripe_customer_id: "cus_1",
        stripe_subscription_id: null,
        status,
      });
    }
  });

  it("is not moved to the free plan by the end of a subscription that is not its current one", async () => {
    const organization = await organizationFor(alice);
    atProvider.set("sub_2", subscription(organization.id, { id: "sub_2" }));
    await webhook("sub_2");
    atProvider.set("sub_1", subscription(organization.id, { status: "canceled" }));
    await webhook("sub_1");
    expect(current(organization.id)?.plan_key).toBe("standard");
    expect(db.subscriptions.get(organization.id)?.stripe_subscription_id).toBe("sub_2");
  });

  it("leaves limits set by hand alone when a checkout is never paid for", async () => {
    const organization = await organizationFor(alice);
    db.operators.add(operator);
    await memoryStore(db, operator).setOrganizationLimits(organization.id, {
      max_locations: 40,
      max_queries_per_location: 40,
      max_manual_scans_per_month: 40,
      scan_every_days: 1,
    });
    for (const status of ["incomplete", "incomplete_expired"]) {
      atProvider.set("sub_1", subscription(organization.id, { status }));
      expect((await webhook("sub_1")).status).toBe(200);
    }
    expect(current(organization.id)).toMatchObject({ plan_key: null, max_locations: 40 });
    expect(db.subscriptions.size).toBe(0);
  });

  it("takes an organization whose limits were set by hand onto a plan once it subscribes", async () => {
    const organization = await organizationFor(alice);
    db.operators.add(operator);
    await memoryStore(db, operator).setOrganizationLimits(organization.id, {
      max_locations: 40,
      max_queries_per_location: 40,
      max_manual_scans_per_month: 40,
      scan_every_days: 1,
    });
    atProvider.set("sub_1", subscription(organization.id));
    await webhook("sub_1");
    expect(current(organization.id)).toMatchObject({ plan_key: "standard", max_locations: 3 });
  });

  it("gives the same answer when the provider sends an event twice", async () => {
    const organization = await organizationFor(alice);
    atProvider.set("sub_1", subscription(organization.id, { status: "canceled" }));
    db.subscriptions.set(organization.id, {
      stripe_customer_id: "cus_1",
      stripe_subscription_id: "sub_1",
      status: "active",
    });
    await webhook("sub_1");
    // The operator then sets its limits by hand. A repeat of the old event must not undo that.
    db.operators.add(operator);
    await memoryStore(db, operator).setOrganizationLimits(organization.id, {
      max_locations: 40,
      max_queries_per_location: 40,
      max_manual_scans_per_month: 40,
      scan_every_days: 1,
    });
    await webhook("sub_1");
    expect(current(organization.id)).toMatchObject({ plan_key: null, max_locations: 40 });
  });

  it("accepts and ignores what is not about one of our subscriptions", async () => {
    const organization = await organizationFor(alice);
    atProvider.set("sub_1", subscription(null));
    atProvider.set("sub_2", subscription("not-an-organization", { id: "sub_2" }));
    atProvider.set("sub_3", subscription(crypto.randomUUID(), { id: "sub_3" }));
    for (const body of ["something-else", "sub_gone", "sub_1", "sub_2", "sub_3"]) {
      expect((await webhook(body)).status, body).toBe(200);
    }
    expect(current(organization.id)?.plan_key).toBe("free");
    expect(db.subscriptions.size).toBe(0);
  });

  it("fails, so the provider tries again, when a subscription is for a price no plan has", async () => {
    const organization = await organizationFor(alice);
    atProvider.set(
      "sub_1",
      subscription(organization.id, { items: [{ price_id: "price_unknown", quantity: 1 }] }),
    );
    expect((await webhook("sub_1")).status).toBe(500);
    expect(current(organization.id)?.plan_key).toBe("free");
  });

  it("says so when the deployment has no payment provider set up", async () => {
    configured = false;
    const response = await webhook("sub_1");
    expect(response.status).toBe(503);
  });
});

describe("a plan's prices", () => {
  const setPrices = (user: string | null, key: string, body: unknown) =>
    call(user, "PUT", `/operator/plans/${key}/prices`, body);
  const dearer = { price_cents: 5900, extra_location_price_cents: 1900 };

  /** Alice subscribed to Standard with one extra location at its first prices; Bob operates. */
  async function subscribedThenRepriced() {
    const organization = await organizationFor(alice);
    const items = [
      { price_id: "price_standard", quantity: 1 },
      { price_id: "price_standard_location", quantity: 1 },
    ];
    atProvider.set("sub_1", subscription(organization.id, { items }));
    await webhook("sub_1");
    db.operators.add(bob);
    expect((await setPrices(bob, "standard", dearer)).status).toBe(200);
    return organization;
  }

  it("are set by the operator: two new prices at the provider, and the plan sold at them", async () => {
    db.operators.add(bob);
    const response = await setPrices(bob, "standard", dearer);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ key: "standard", ...dearer });
    // Each is a price of the product the old one was for.
    expect(made).toEqual([
      { like: "price_standard", product_name: "Nearcited standard", cents: 5900 },
      {
        like: "price_standard_location",
        product_name: "Nearcited standard: extra location",
        cents: 1900,
      },
    ]);
    const plans = await memoryStore(db, null).listPlanPrices();
    expect(plans.find((p) => p.key === "standard")).toMatchObject({
      current: { price_cents: 5900, stripe_price_id: "price_new_1" },
      versions: [{ stripe_price_id: "price_new_1" }, { stripe_price_id: "price_standard" }],
    });
  });

  it("charge a new subscriber the new price at once", async () => {
    await subscribedThenRepriced();
    db.organizations.length = 0;
    db.memberships.length = 0;
    db.subscriptions.clear();
    const organization = await organizationFor(alice);
    await call(alice, "POST", `/organizations/${organization.id}/checkout`, {
      plan_key: "standard",
      locations: 4,
    });
    expect(checkouts[0]?.items).toEqual([
      { price_id: "price_new_1", quantity: 1 },
      { price_id: "price_new_2", quantity: 1 },
    ]);
  });

  it("leave a current subscriber on their plan, at the price they pay", async () => {
    const organization = await subscribedThenRepriced();
    // The provider reports on the subscription again, still billing the old prices.
    expect((await webhook("sub_1")).status).toBe(200);
    expect(current(organization.id)).toMatchObject({ plan_key: "standard", max_locations: 4 });

    const response = await call(alice, "GET", `/organizations/${organization.id}/account`);
    expect(OrganizationAccountSchema.parse(await response.json()).billing).toMatchObject({
      locations: 4,
      paying: { price_cents: 2000, extra_location_price_cents: 1500, monthly_cents: 3500 },
    });
  });

  it("keep a subscriber's own prices when they change locations, and give another plan's as sold now", async () => {
    const organization = await subscribedThenRepriced();
    const change = (body: unknown) =>
      call(alice, "PUT", `/organizations/${organization.id}/subscription`, body);

    expect(
      SubscriptionChangeSchema.parse(
        await (await change({ plan_key: "standard", locations: 6 })).json(),
      ),
    ).toMatchObject({
      kind: "upgrade",
      monthly_cents: 2000 + 3 * 1500,
    });
    expect(changes[0]?.items).toEqual([
      { price_id: "price_standard", quantity: 1 },
      { price_id: "price_standard_location", quantity: 3 },
    ]);

    // A plan they are not on is bought at today's price, here one that has just gone up.
    db.plans.push(plan("pro", 3));
    db.planPrices.set("pro", { base: "price_pro", extra: null });
    expect(
      (await setPrices(bob, "pro", { price_cents: 9900, extra_location_price_cents: null })).status,
    ).toBe(200);
    await change({ plan_key: "pro" });
    expect(changes[1]?.items).toEqual([{ price_id: "price_new_3", quantity: 1 }]);
  });

  it("can stop a plan selling extra locations, and start it again", async () => {
    db.operators.add(bob);
    await setPrices(bob, "standard", { price_cents: 5900, extra_location_price_cents: null });
    expect(made).toHaveLength(1);
    const organization = await organizationFor(alice);
    const refused = await call(alice, "POST", `/organizations/${organization.id}/checkout`, {
      plan_key: "standard",
      locations: 4,
    });
    expect(refused.status).toBe(422);

    // With no extra-location price to copy, a product is made for the new one.
    await setPrices(bob, "standard", dearer);
    expect(made[2]).toEqual({
      like: null,
      product_name: "Nearcited standard: extra location",
      cents: 1900,
    });
  });

  it("are refused when nothing would change, for the free plan, and for amounts that are surely a slip", async () => {
    db.operators.add(bob);
    expect(
      await errorCode(
        await setPrices(bob, "standard", { price_cents: 2000, extra_location_price_cents: 1500 }),
      ),
    ).toBe("no_change");
    expect(await errorCode(await setPrices(bob, "free", dearer))).toBe("free_plan");
    for (const bad of [
      { price_cents: 0, extra_location_price_cents: 1500 },
      { price_cents: 29.5, extra_location_price_cents: 1500 },
      { price_cents: 5900, extra_location_price_cents: 0 },
      { price_cents: 99_000_000, extra_location_price_cents: null },
      { price_cents: 5900 },
    ]) {
      expect((await setPrices(bob, "standard", bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await setPrices(bob, "nonesuch", dearer)).status).toBe(404);
    expect(made).toEqual([]);
  });

  it("are the operator's alone to set, and need a payment provider", async () => {
    await organizationFor(alice);
    expect((await setPrices(alice, "standard", dearer)).status).toBe(404);
    expect((await setPrices(null, "standard", dearer)).status).toBe(401);
    db.operators.add(bob);
    configured = false;
    expect(await errorCode(await setPrices(bob, "standard", dearer))).toBe("billing_unavailable");
    expect(made).toEqual([]);
  });
});

describe("announcing a price change", () => {
  const dearer = { price_cents: 5900, extra_location_price_cents: 1900 };
  const DAY = 86_400_000;
  const dayFrom = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
  const announce = (user: string | null, key: string, effective_on: string) =>
    call(user, "POST", `/operator/plans/${key}/price-change`, { effective_on });
  const callOff = (user: string | null, key: string) =>
    call(user, "DELETE", `/operator/plans/${key}/price-change`);

  /** Alice subscribes to Standard, then Bob, the operator, puts its prices up. */
  async function repriced() {
    const organization = await organizationFor(alice);
    atProvider.set("sub_1", subscription(organization.id));
    await webhook("sub_1");
    db.operators.add(bob);
    await call(bob, "PUT", "/operator/plans/standard/prices", dearer);
    return organization;
  }

  it("records the day, and queues the announcement for each subscriber on the plan", async () => {
    const organization = await repriced();
    const response = await announce(bob, "standard", dayFrom(45));
    expect(response.status).toBe(201);
    const change = PriceChangeSchema.parse(await response.json());
    expect(change).toMatchObject({
      plan_key: "standard",
      stripe_price_id: "price_new_1",
      effective_at: `${dayFrom(45)}T00:00:00.000Z`,
    });
    expect(steps).toEqual([
      { price_change_id: change.id, organization_id: organization.id, step: "announce" },
    ]);
  });

  it("refuses a price rise less than thirty days away, and a second announcement", async () => {
    await repriced();
    const soon = await announce(bob, "standard", dayFrom(29));
    expect(soon.status).toBe(409);
    expect(await errorCode(soon)).toBe("limit_reached");
    expect(steps).toEqual([]);

    expect((await announce(bob, "standard", dayFrom(31))).status).toBe(201);
    expect((await announce(bob, "standard", dayFrom(60))).status).toBe(409);
    expect(steps).toHaveLength(1);
  });

  it("holds the plan's prices as announced until the change is finished or called off", async () => {
    await repriced();
    await announce(bob, "standard", dayFrom(45));
    const again = await call(bob, "PUT", "/operator/plans/standard/prices", {
      price_cents: 6900,
      extra_location_price_cents: 1900,
    });
    expect(again.status).toBe(409);
    expect(db.plans.find((row) => row.key === "standard")?.price_cents).toBe(5900);
  });

  it("shows the operator the open change with how many were told and moved", async () => {
    const organization = await repriced();
    const change = PriceChangeSchema.parse(
      await (await announce(bob, "standard", dayFrom(45))).json(),
    );
    await memoryStore(db, null).recordPriceChangeNotice(change.id, organization.id, {
      announced_at: new Date().toISOString(),
    });
    const plans = OperatorPlanSchema.array().parse(
      await (await call(bob, "GET", "/operator/plans")).json(),
    );
    expect(plans.find((row) => row.key === "standard")?.price_change).toMatchObject({
      id: change.id,
      told: 1,
      moved: 0,
    });
    expect(plans.find((row) => row.key === "starter")?.price_change).toBeNull();
  });

  it("tells a subscriber on Account settings what they will pay, and from when", async () => {
    const organization = await repriced();
    await announce(bob, "standard", dayFrom(45));
    const account = OrganizationAccountSchema.parse(
      await (await call(alice, "GET", `/organizations/${organization.id}/account`)).json(),
    );
    expect(account.billing).toMatchObject({
      paying: { monthly_cents: 2000 },
      price_change: { monthly_cents: 5900, at: `${dayFrom(45)}T00:00:00.000Z` },
    });
  });

  it("can be called off before the day, telling everyone who was told", async () => {
    const organization = await repriced();
    const change = PriceChangeSchema.parse(
      await (await announce(bob, "standard", dayFrom(45))).json(),
    );
    await memoryStore(db, null).recordPriceChangeNotice(change.id, organization.id, {
      announced_at: new Date().toISOString(),
    });
    steps = [];
    const response = await callOff(bob, "standard");
    expect(response.status).toBe(200);
    expect(PriceChangeSchema.parse(await response.json()).called_off_at).not.toBeNull();
    expect(steps).toEqual([
      { price_change_id: change.id, organization_id: organization.id, step: "call_off" },
    ]);
    // There is nothing left to call off, and the prices can be changed again.
    expect((await callOff(bob, "standard")).status).toBe(404);
    const account = OrganizationAccountSchema.parse(
      await (await call(alice, "GET", `/organizations/${organization.id}/account`)).json(),
    );
    expect(account.billing?.price_change).toBeNull();
  });

  it("is the operator's alone, and needs both the payment provider and outgoing email", async () => {
    await repriced();
    expect((await announce(alice, "standard", dayFrom(45))).status).toBe(404);
    expect((await announce(null, "standard", dayFrom(45))).status).toBe(401);
    expect((await callOff(alice, "standard")).status).toBe(404);
    expect((await announce(bob, "standard", "soon")).status).toBe(422);
    expect((await announce(bob, "nonesuch", dayFrom(45))).status).toBe(404);

    env = { ...env, RESEND_API_KEY: undefined } as unknown as Env;
    const noEmail = await announce(bob, "standard", dayFrom(45));
    expect(noEmail.status).toBe(503);
    expect(db.priceChanges).toEqual([]);
    expect(steps).toEqual([]);
  });
});
