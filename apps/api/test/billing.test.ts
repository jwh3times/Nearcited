import { BillingRedirectSchema, type Organization, type Plan } from "@nearcited/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  type CheckoutRequest,
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
  env = { PROVIDER_MODE: "mock", APP_URL: "https://app.example" } as unknown as Env;
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
