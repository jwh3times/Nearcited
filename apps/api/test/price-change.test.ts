import type { Organization, Plan, PriceChange, PriceChangeMessage } from "@nearcited/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  advancePriceChanges,
  type PriceChangeDeps,
  runPriceChangeStep,
} from "../src/billing/price-change";
import type { BilledItem, Payments, ProviderSubscription } from "../src/billing/types";
import { buildPriceChangeEmail } from "../src/email/price-change";
import type { Email } from "../src/email/report";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const operator = "f0000000-0000-4000-8000-000000000006";
const DAY = 86_400_000;
const ANNOUNCED = Date.parse("2026-10-10T12:00:00.000Z");
const EFFECTIVE = "2026-11-20T00:00:00.000Z";
const at = (ms: number) => new Date(ms);

let db: MemoryDb;
let atProvider: Map<string, ProviderSubscription>;
let sent: { to: string[]; email: Email }[];
let repriced: { id: string; items: BilledItem[] }[];
let rescheduled: { id: string; items: BilledItem[] }[];
let queued: PriceChangeMessage[];
let emailFails: boolean;

const payments = {
  async getSubscription(id: string) {
    return atProvider.get(id) ?? null;
  },
  async reprice(id: string, items: BilledItem[]) {
    repriced.push({ id, items });
    const subscription = atProvider.get(id);
    if (subscription) subscription.items = items;
  },
  async changeAtPeriodEnd(id: string, items: BilledItem[]) {
    rescheduled.push({ id, items });
  },
} as unknown as Payments;

const queue = {
  async sendBatch(messages: Iterable<{ body: PriceChangeMessage }>) {
    for (const message of messages) queued.push(message.body);
  },
};

const deps = (now: number): PriceChangeDeps => ({
  store: memoryStore(db, null),
  payments,
  send: async (to, email) => {
    if (emailFails) throw new Error("The mail service is down.");
    sent.push({ to, email });
  },
  appUrl: "https://app.example/",
  now: at(now),
});

const standard: Plan = {
  key: "standard",
  name: "Standard",
  position: 2,
  on_sale: true,
  // What it is sold at now. It was $49 and $15 when the organization below subscribed.
  price_cents: 5900,
  included_locations: 3,
  extra_location_price_cents: 1900,
  max_queries_per_location: 10,
  assistants: 2,
  scan_every_days: 2,
  max_manual_scans_per_month: 10,
  emails_report: true,
  stronger_models: false,
};

const OLD = [
  { price_id: "price_old", quantity: 1 },
  { price_id: "price_old_location", quantity: 2 },
];
const NEW = [
  { price_id: "price_new", quantity: 1 },
  { price_id: "price_new_location", quantity: 2 },
];

let organization: Organization;
let change: PriceChange;

const step = (kind: PriceChangeMessage["step"], now: number) =>
  runPriceChangeStep(
    { price_change_id: change.id, organization_id: organization.id, step: kind },
    deps(now),
  );
const notice = () => db.priceChangeNotices.find((n) => n.organization_id === organization.id);

beforeEach(async () => {
  db = createMemoryDb();
  db.now = at(ANNOUNCED).toISOString();
  atProvider = new Map();
  sent = [];
  repriced = [];
  rescheduled = [];
  queued = [];
  emailFails = false;

  db.plans.push(
    { ...standard },
    { ...standard, key: "free", name: "Free", position: 0, price_cents: 0 },
  );
  db.planPrices.set("standard", { base: "price_new", extra: "price_new_location" });
  db.pastPrices.push({
    plan_key: "standard",
    price_cents: 4900,
    extra_location_price_cents: 1500,
    stripe_price_id: "price_old",
    stripe_extra_location_price_id: "price_old_location",
  });
  db.emails.set(alice, "alice@example.com");
  organization = await memoryStore(db, alice).createOrganization("Raleigh Pizza Group");
  await memoryStore(db, null).applyPlan(organization.id, "standard", 5);
  db.subscriptions.set(organization.id, {
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    status: "active",
  });
  atProvider.set("sub_1", {
    id: "sub_1",
    customer_id: "cus_1",
    status: "active",
    organization_id: organization.id,
    items: OLD,
    period_end: "2026-11-25T00:00:00.000Z",
    pending: null,
  });
  db.operators.add(operator);
  const announced = await memoryStore(db, operator).announcePriceChange("standard", EFFECTIVE);
  if (!announced) throw new Error("The change was not announced.");
  change = announced;
});

describe("telling an organization's owners", () => {
  it("sends the announcement once, with what they pay and what they will", async () => {
    expect(await step("announce", ANNOUNCED)).toBe("told");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(["alice@example.com"]);
    expect(sent[0]?.email.subject).toBe(
      "The price of your Nearcited plan is changing on November 20, 2026",
    );
    // $49 and two extra at $15 today; $59 and two at $19 after.
    expect(sent[0]?.email.text).toContain("Raleigh Pizza Group pays $79 a month today.");
    expect(sent[0]?.email.text).toContain("on or after November 20, 2026 it will be $97 a month");
    expect(sent[0]?.email.text).toContain("https://app.example/settings");
    expect(notice()?.announced_at).toBe(at(ANNOUNCED).toISOString());

    expect(await step("announce", ANNOUNCED + DAY)).toBe("nothing to do");
    expect(sent).toHaveLength(1);
  });

  it("does not count an email that could not be sent as notice", async () => {
    emailFails = true;
    await expect(step("announce", ANNOUNCED)).rejects.toThrow();
    expect(notice()?.announced_at ?? null).toBeNull();
    // The queue tries again, and this time it goes.
    emailFails = false;
    expect(await step("announce", ANNOUNCED)).toBe("told");
  });

  it("waits when there is nobody to tell, and so never moves them", async () => {
    db.emails.clear();
    expect(await step("announce", ANNOUNCED)).toBe("waiting");
    expect(await step("move", Date.parse(EFFECTIVE) + DAY)).toBe("not given notice");
    expect(repriced).toEqual([]);
  });

  it("reminds only those who were told, once", async () => {
    const week = Date.parse(EFFECTIVE) - 7 * DAY;
    expect(await step("remind", week)).toBe("nothing to do");
    await step("announce", ANNOUNCED);
    expect(await step("remind", week)).toBe("reminded");
    expect(sent[1]?.email.subject).toBe(
      "Reminder: your Nearcited price changes on November 20, 2026",
    );
    expect(await step("remind", week)).toBe("nothing to do");
    expect(sent).toHaveLength(2);
  });

  it("says nothing to an organization already on the new price, or no longer on the plan", async () => {
    const subscription = atProvider.get("sub_1");
    if (subscription) subscription.items = NEW;
    expect(await step("announce", ANNOUNCED)).toBe("skipped");
    expect(notice()?.skipped).toBe("It already pays the new price.");
    expect(sent).toEqual([]);
    // Once settled, later steps do nothing.
    expect(await step("move", Date.parse(EFFECTIVE) + DAY)).toBe("nothing to do");

    db.priceChangeNotices.length = 0;
    atProvider.delete("sub_1");
    expect(await step("announce", ANNOUNCED)).toBe("skipped");
    expect(notice()?.skipped).toBe("It has no subscription.");
  });
});

describe("moving a subscription to the new price", () => {
  it("waits for the day, then moves it without charging, and keeps the locations paid for", async () => {
    await step("announce", ANNOUNCED);
    expect(await step("move", Date.parse(EFFECTIVE) - 1)).toBe("waiting");
    expect(repriced).toEqual([]);

    expect(await step("move", Date.parse(EFFECTIVE))).toBe("moved");
    expect(repriced).toEqual([{ id: "sub_1", items: NEW }]);
    expect(notice()?.moved_at).toBe(EFFECTIVE);

    expect(await step("move", Date.parse(EFFECTIVE) + DAY)).toBe("nothing to do");
    expect(repriced).toHaveLength(1);
  });

  it("never puts a price up for someone told less than thirty days before", async () => {
    // The announcement reached them late: twenty days before the move is attempted.
    await step("announce", Date.parse(EFFECTIVE) - 20 * DAY);
    expect(await step("move", Date.parse(EFFECTIVE))).toBe("not given notice");
    expect(repriced).toEqual([]);
    // Thirty days after they were told, they are moved.
    expect(await step("move", Date.parse(EFFECTIVE) + 10 * DAY)).toBe("moved");
  });

  it("moves a price that goes down without any notice", async () => {
    const plan = db.plans.find((row) => row.key === "standard");
    if (plan) Object.assign(plan, { price_cents: 3900, extra_location_price_cents: 1000 });
    expect(await step("move", Date.parse(EFFECTIVE))).toBe("moved");
    expect(repriced).toHaveLength(1);
  });

  it("waits for a payment that is being retried to be settled", async () => {
    await step("announce", ANNOUNCED);
    const subscription = atProvider.get("sub_1");
    if (subscription) subscription.status = "past_due";
    expect(await step("move", Date.parse(EFFECTIVE))).toBe("waiting");
    expect(repriced).toEqual([]);
  });

  it("rewrites a change of their own that was waiting at the old price", async () => {
    await step("announce", ANNOUNCED);
    const subscription = atProvider.get("sub_1");
    if (subscription) {
      subscription.pending = [
        { price_id: "price_old", quantity: 1 },
        { price_id: "price_old_location", quantity: 1 },
      ];
    }
    await step("move", Date.parse(EFFECTIVE));
    expect(rescheduled).toEqual([
      {
        id: "sub_1",
        items: [
          { price_id: "price_new", quantity: 1 },
          { price_id: "price_new_location", quantity: 1 },
        ],
      },
    ]);
  });

  it("does nothing once the change has been called off, and tells whoever was told", async () => {
    await step("announce", ANNOUNCED);
    await memoryStore(db, operator).callOffPriceChange("standard");
    expect(await step("call_off", ANNOUNCED + DAY)).toBe("told it is off");
    expect(sent[1]?.email.subject).toBe("Your Nearcited price is not changing");
    expect(sent[1]?.email.text).toContain("You go on paying $79 a month");
    expect(await step("call_off", ANNOUNCED + DAY)).toBe("nothing to do");

    expect(await step("move", Date.parse(EFFECTIVE))).toBe("nothing to do");
    expect(await step("remind", Date.parse(EFFECTIVE) - 7 * DAY)).toBe("nothing to do");
    expect(repriced).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it("tells nobody a change is off who was never told it was on", async () => {
    await memoryStore(db, operator).callOffPriceChange("standard");
    expect(await step("call_off", ANNOUNCED + DAY)).toBe("nothing to do");
    expect(sent).toEqual([]);
  });
});

describe("the daily look at open price changes", () => {
  const run = (now: number) => advancePriceChanges(memoryStore(db, null), queue, at(now));
  const open = () => db.priceChanges.find((row) => row.id === change.id);

  it("queues nothing while a change is more than a week away", async () => {
    expect(await run(Date.parse(EFFECTIVE) - 8 * DAY)).toBe(0);
    expect(queued).toEqual([]);
  });

  it("queues the reminders a week before, once", async () => {
    expect(await run(Date.parse(EFFECTIVE) - 7 * DAY)).toBe(1);
    expect(queued).toEqual([
      { price_change_id: change.id, organization_id: organization.id, step: "remind" },
    ]);
    expect(await run(Date.parse(EFFECTIVE) - 6 * DAY)).toBe(0);
    expect(queued).toHaveLength(1);
  });

  it("queues a move for each subscription not yet moved, each day, and finishes when none is left", async () => {
    await step("announce", ANNOUNCED);
    expect(await run(Date.parse(EFFECTIVE))).toBe(1);
    expect(queued[0]?.step).toBe("move");
    expect(open()?.completed_at).toBeNull();

    await step("move", Date.parse(EFFECTIVE));
    expect(await run(Date.parse(EFFECTIVE) + DAY)).toBe(0);
    expect(open()?.completed_at).toBe(at(Date.parse(EFFECTIVE) + DAY).toISOString());
    // Finished, the plan's prices can be changed again.
    expect(await memoryStore(db, null).getOpenPriceChange("standard")).toBeNull();
  });

  it("gives up on whoever could not be moved two months on, leaving them on what they pay", async () => {
    expect(await run(Date.parse(EFFECTIVE) + 59 * DAY)).toBe(1);
    expect(open()?.completed_at).toBeNull();
    expect(await run(Date.parse(EFFECTIVE) + 61 * DAY)).toBe(0);
    expect(open()?.completed_at).not.toBeNull();
    expect(repriced).toEqual([]);
  });

  it("leaves a change that was called off alone", async () => {
    await memoryStore(db, operator).callOffPriceChange("standard");
    expect(await run(Date.parse(EFFECTIVE))).toBe(0);
    expect(queued).toEqual([]);
  });
});

describe("the emails", () => {
  const base = {
    organization: "Raleigh Pizza Group",
    plan: "Standard",
    was_cents: 4900,
    now_cents: 5950,
    effective_at: EFFECTIVE,
    appUrl: "https://app.example",
  };

  it("say a price is going down, with nothing to do, when it is", () => {
    const email = buildPriceChangeEmail({ ...base, kind: "announce", now_cents: 3900 });
    expect(email.subject).toBe(
      "The price of your Nearcited plan is going down on November 20, 2026",
    );
    expect(email.text).toContain("There is nothing you need to do.");
    expect(email.text).not.toContain("cancel");
  });

  it("write cents only when there are some", () => {
    const email = buildPriceChangeEmail({ ...base, kind: "announce" });
    expect(email.text).toContain("pays $49 a month today");
    expect(email.text).toContain("it will be $59.50 a month");
  });
});
