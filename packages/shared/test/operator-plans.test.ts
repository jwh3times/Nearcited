import { describe, expect, it } from "vitest";
import { buildOperatorPlans, planImpact } from "../src/operator";
import type { Location, Organization, Plan } from "../src/schemas";

const plan = (key: string, position: number, change: Partial<Plan> = {}): Plan => ({
  key,
  name: key,
  position,
  on_sale: true,
  price_cents: 5000,
  included_locations: 3,
  extra_location_price_cents: 1500,
  max_queries_per_location: 10,
  assistants: 2,
  scan_every_days: 2,
  max_manual_scans_per_month: 10,
  emails_report: true,
  stronger_models: false,
  ...change,
});

const org = (id: string, change: Partial<Organization> = {}): Organization => ({
  id,
  name: `Org ${id}`,
  max_locations: 3,
  max_queries_per_location: 10,
  max_manual_scans_per_month: 10,
  scan_every_days: 2,
  surfaces: null,
  is_test: false,
  emails_report: true,
  plan_key: "standard",
  created_at: "2026-10-01T00:00:00.000Z",
  ...change,
});

const location = (id: string, organizationId: string) =>
  ({ id, organization_id: organizationId }) as Location;

describe("buildOperatorPlans", () => {
  const plans = [plan("standard", 2), plan("free", 0, { price_cents: 0 })];

  it("lists the plans cheapest first, each with who is on it", () => {
    const built = buildOperatorPlans({
      plans,
      organizations: [
        org("a"),
        org("b"),
        org("c", { plan_key: "free" }),
        org("d", { plan_key: null }),
      ],
      subscriptions: [{ organization_id: "a", subscribed: true }],
    });
    expect(built.map((p) => [p.key, p.organizations, p.subscribers])).toEqual([
      ["free", 1, 0],
      ["standard", 2, 1],
    ]);
  });

  it("adds up what subscribers pay: the plan, and each location beyond those it includes", () => {
    const [, standard] = buildOperatorPlans({
      plans,
      organizations: [org("a"), org("b", { max_locations: 5 }), org("c", { max_locations: 9 })],
      subscriptions: [
        { organization_id: "a", subscribed: true },
        { organization_id: "b", subscribed: true },
        // Once subscribed, since ended: on the plan's limits no longer, and paying nothing.
        { organization_id: "c", subscribed: false },
      ],
    });
    expect(standard?.monthly_cents).toBe(5000 + 5000 + 2 * 1500);
    expect(standard?.subscribers).toBe(2);
  });

  it("leaves test organizations out", () => {
    const [, standard] = buildOperatorPlans({
      plans,
      organizations: [org("a", { is_test: true })],
      subscriptions: [{ organization_id: "a", subscribed: true }],
    });
    expect(standard).toMatchObject({ organizations: 0, subscribers: 0, monthly_cents: 0 });
  });
});

describe("planImpact", () => {
  const facts = {
    organizations: [org("a"), org("b"), org("c", { plan_key: "free" })],
    locations: [location("a1", "a"), location("a2", "a"), location("b1", "b"), location("c1", "c")],
    activePrompts: { a1: 8, a2: 9, b1: 4, c1: 10 },
  };

  it("counts the organizations on the plan with a location over the new prompt limit", () => {
    expect(planImpact("standard", 5, facts)).toEqual({ organizations: 2, prompts_set_aside: 1 });
    expect(planImpact("standard", 3, facts)).toEqual({ organizations: 2, prompts_set_aside: 2 });
  });

  it("finds nobody over a limit that covers what they have", () => {
    expect(planImpact("standard", 9, facts)).toEqual({ organizations: 2, prompts_set_aside: 0 });
  });
});
