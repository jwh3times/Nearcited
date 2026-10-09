import type { LimitChange, LimitChangeMessage, Organization, Plan } from "@nearcited/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  advanceLimitChanges,
  type LimitChangeDeps,
  runLimitChangeStep,
} from "../src/billing/limit-change";
import { buildLimitChangeEmail } from "../src/email/limit-change";
import type { Email } from "../src/email/report";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const operator = "f0000000-0000-4000-8000-000000000006";
const DAY = 86_400_000;
const ANNOUNCED = Date.parse("2026-10-10T12:00:00.000Z");
const EFFECTIVE = "2026-11-20T00:00:00.000Z";
const at = (ms: number) => new Date(ms);

let db: MemoryDb;
let sent: { to: string[]; email: Email }[];
let queued: LimitChangeMessage[];
let organization: Organization;
let change: LimitChange;

const queue = {
  async sendBatch(messages: Iterable<{ body: LimitChangeMessage }>) {
    for (const message of messages) queued.push(message.body);
  },
};

const deps = (now: number): LimitChangeDeps => ({
  store: memoryStore(db, null),
  send: async (to, email) => {
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
  price_cents: 4900,
  included_locations: 3,
  extra_location_price_cents: 1500,
  max_queries_per_location: 10,
  assistants: 2,
  scan_every_days: 2,
  max_manual_scans_per_month: 10,
  emails_report: true,
  stronger_models: false,
};
const lower = { ...standard, max_queries_per_location: 5, assistants: 1, scan_every_days: 7 };

const step = (kind: LimitChangeMessage["step"], now: number) =>
  runLimitChangeStep(
    { limit_change_id: change.id, organization_id: organization.id, step: kind },
    deps(now),
  );
const notice = () => db.limitChangeNotices.find((n) => n.organization_id === organization.id);
const plan = () => db.plans.find((row) => row.key === "standard");
const mine = () => db.organizations.find((row) => row.id === organization.id);

beforeEach(async () => {
  db = createMemoryDb();
  db.now = at(ANNOUNCED).toISOString();
  sent = [];
  queued = [];
  db.plans.push(
    { ...standard },
    { ...standard, key: "free", name: "Free", position: 0, price_cents: 0 },
  );
  db.emails.set(alice, "alice@example.com");
  organization = await memoryStore(db, alice).createOrganization("Raleigh Pizza Group");
  await memoryStore(db, null).applyPlan(organization.id, "standard");
  db.operators.add(operator);
  const announced = await memoryStore(db, operator).announceLimitChange(
    "standard",
    lower,
    EFFECTIVE,
  );
  if (!announced) throw new Error("The reduction was not announced.");
  change = announced;
});

describe("telling an organization of a reduction", () => {
  it("sends the announcement once, listing what goes down and when", async () => {
    expect(await step("announce", ANNOUNCED)).toBe("told");
    expect(sent[0]?.to).toEqual(["alice@example.com"]);
    expect(sent[0]?.email.subject).toBe(
      "What your Nearcited plan includes is changing on November 20, 2026",
    );
    const text = sent[0]?.email.text ?? "";
    expect(text).toContain("Prompts and keywords for each location: 10 now, 5 after");
    expect(text).toContain("Assistants checked: 2 now, 1 after, and you choose which");
    expect(text).toContain("Scheduled scans: every 2 days now, every 7 days after");
    expect(text).not.toContain("Scans you can run by hand");
    expect(text).toContain("Nothing changes before that day.");
    // It says nothing about the price, which may be changing by an announcement of its own.
    expect(text).not.toContain("price");
    expect(notice()?.announced_at).toBe(at(ANNOUNCED).toISOString());

    expect(await step("announce", ANNOUNCED + DAY)).toBe("nothing to do");
    expect(sent).toHaveLength(1);
  });

  it("reminds those who were told, once, and nobody else", async () => {
    const week = Date.parse(EFFECTIVE) - 7 * DAY;
    expect(await step("remind", week)).toBe("nothing to do");
    await step("announce", ANNOUNCED);
    expect(await step("remind", week)).toBe("reminded");
    expect(sent[1]?.email.subject).toBe(
      "Reminder: your Nearcited plan changes on November 20, 2026",
    );
    expect(await step("remind", week)).toBe("nothing to do");
  });

  it("waits when there is nobody to tell, so the operator is shown them as not told", async () => {
    db.emails.clear();
    expect(await step("announce", ANNOUNCED)).toBe("waiting");
    expect(notice()).toBeUndefined();
  });

  it("says nothing to an organization that has left the plan", async () => {
    await memoryStore(db, null).applyPlan(organization.id, "free");
    expect(await step("announce", ANNOUNCED)).toBe("nothing to do");
    expect(sent).toEqual([]);
  });

  it("tells whoever was told when it is called off, and then says no more", async () => {
    await step("announce", ANNOUNCED);
    await memoryStore(db, operator).callOffLimitChange("standard");
    expect(await step("call_off", ANNOUNCED + DAY)).toBe("told it is off");
    expect(sent[1]?.email.subject).toBe("Your Nearcited plan is not changing");
    expect(await step("call_off", ANNOUNCED + DAY)).toBe("nothing to do");
    expect(await step("remind", Date.parse(EFFECTIVE) - 7 * DAY)).toBe("nothing to do");
    expect(sent).toHaveLength(2);
  });
});

describe("the daily look at announced reductions", () => {
  const run = (now: number) => {
    db.now = at(now).toISOString();
    return advanceLimitChanges(memoryStore(db, null), queue, at(now));
  };

  it("does nothing while the day is more than a week away", async () => {
    expect(await run(Date.parse(EFFECTIVE) - 8 * DAY)).toBe(0);
    expect(queued).toEqual([]);
    expect(plan()?.max_queries_per_location).toBe(10);
  });

  it("queues the reminders a week before, once", async () => {
    await run(Date.parse(EFFECTIVE) - 7 * DAY);
    expect(queued).toEqual([
      { limit_change_id: change.id, organization_id: organization.id, step: "remind" },
    ]);
    await run(Date.parse(EFFECTIVE) - 6 * DAY);
    expect(queued).toHaveLength(1);
  });

  it("makes the reduction on the day, for the plan and everyone on it, and only once", async () => {
    expect(await run(Date.parse(EFFECTIVE) - 1)).toBe(0);
    expect(mine()?.max_queries_per_location).toBe(10);

    expect(await run(Date.parse(EFFECTIVE))).toBe(1);
    expect(plan()).toMatchObject({
      max_queries_per_location: 5,
      assistants: 1,
      scan_every_days: 7,
      // What was not announced as going down is as it was.
      max_manual_scans_per_month: 10,
      emails_report: true,
    });
    expect(mine()).toMatchObject({ max_queries_per_location: 5, scan_every_days: 7 });
    expect(mine()?.surfaces).toHaveLength(1);

    expect(await run(Date.parse(EFFECTIVE) + DAY)).toBe(0);
    expect(await memoryStore(db, null).getOpenLimitChange("standard")).toBeNull();
  });

  it("never makes a reduction that was called off", async () => {
    await memoryStore(db, operator).callOffLimitChange("standard");
    expect(await run(Date.parse(EFFECTIVE) + DAY)).toBe(0);
    expect(plan()?.max_queries_per_location).toBe(10);
  });
});

describe("the email for a cut to the free plan", () => {
  it("says what changed today, in the past, and points at the plans", () => {
    const email = buildLimitChangeEmail({
      kind: "made",
      organization: "Raleigh Pizza Group",
      plan: "Free",
      lowered: {
        max_queries_per_location: { from: 2, to: 1 },
        emails_report: { from: true, to: false },
      },
      effective_at: EFFECTIVE,
      appUrl: "https://app.example",
    });
    expect(email.subject).toBe("What the Nearcited Free plan includes has changed");
    expect(email.text).toContain("Prompts and keywords for each location: 2 before, 1 now");
    expect(email.text).toContain("The report by email after each scan: included before, not now");
    expect(email.text).toContain("https://app.example/pricing");
  });
});
