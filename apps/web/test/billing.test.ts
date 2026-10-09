import type { Organization, OrganizationAccount, Plan } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import { billingWarning, formatPrice, monthlyCents, planOffer } from "../src/lib/billing";

const plan = (key: string, extra: Partial<Plan> = {}): Plan => ({
  key,
  name: key,
  position: 1,
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
  ...extra,
});
const free = plan("free", {
  price_cents: 0,
  included_locations: 1,
  extra_location_price_cents: null,
});

const organization = (extra: Partial<Organization> = {}): Organization => ({
  id: "0a000000-0000-4000-8000-000000000001",
  name: "Raleigh Pizza Group",
  max_locations: 1,
  max_queries_per_location: 2,
  max_manual_scans_per_month: 0,
  scan_every_days: 14,
  surfaces: ["chatgpt"],
  is_test: false,
  emails_report: false,
  plan_key: "free",
  created_at: "2026-10-01T00:00:00.000Z",
  ...extra,
});

const owner = (billing: Partial<NonNullable<OrganizationAccount["billing"]>> = {}) => ({
  manual_scans_used: 0,
  billing: { available: true, subscribed: false, status: null, has_customer: false, ...billing },
});
const member: OrganizationAccount = { manual_scans_used: 0, billing: null };

describe("monthlyCents", () => {
  it("is the plan's price up to the locations it includes", () => {
    expect(monthlyCents(plan("standard"), 1)).toBe(4900);
    expect(monthlyCents(plan("standard"), 3)).toBe(4900);
  });

  it("adds each location beyond those", () => {
    expect(monthlyCents(plan("standard"), 5)).toBe(4900 + 2 * 1500);
  });
});

describe("formatPrice", () => {
  it("drops the cents from a whole number of dollars", () => {
    expect(formatPrice(2900)).toBe("$29");
    expect(formatPrice(0)).toBe("$0");
    expect(formatPrice(1250)).toBe("$12.50");
  });
});

describe("planOffer", () => {
  it("asks a visitor to sign in, whatever the plan", () => {
    expect(planOffer(plan("standard"), null)).toBe("sign-in");
    expect(planOffer(free, null)).toBe("sign-in");
  });

  it("sends an account with no organization to finish setting up", () => {
    expect(planOffer(plan("standard"), { organization: null, account: null })).toBe("finish-setup");
  });

  it("marks the plan the organization is on", () => {
    expect(planOffer(free, { organization: organization(), account: owner() })).toBe("current");
  });

  it("offers an owner with no subscription a paid plan, and not the free one", () => {
    const viewer = { organization: organization({ plan_key: null }), account: owner() };
    expect(planOffer(plan("standard"), viewer)).toBe("subscribe");
    expect(planOffer(free, viewer)).toBe("none");
  });

  it("sends a subscriber to the account pages for every other plan", () => {
    const viewer = {
      organization: organization({ plan_key: "starter" }),
      account: owner({ subscribed: true, status: "active", has_customer: true }),
    };
    expect(planOffer(plan("standard"), viewer)).toBe("manage");
    expect(planOffer(free, viewer)).toBe("manage");
  });

  it("shows a member the prices and offers nothing to buy", () => {
    expect(planOffer(plan("standard"), { organization: organization(), account: member })).toBe(
      "owner-only",
    );
  });

  it("offers nothing where nobody can subscribe, to a test organization, or before loading", () => {
    expect(
      planOffer(plan("standard"), {
        organization: organization(),
        account: owner({ available: false }),
      }),
    ).toBe("unavailable");
    expect(
      planOffer(plan("standard"), {
        organization: organization({ is_test: true, plan_key: null }),
        account: owner(),
      }),
    ).toBe("none");
    expect(planOffer(plan("standard"), { organization: organization(), account: null })).toBe(
      "none",
    );
  });
});

describe("billingWarning", () => {
  it("speaks up only when the owner has something to do", () => {
    expect(billingWarning("past_due")).toMatch(/did not go through/);
    expect(billingWarning("canceled")).toMatch(/has ended/);
    expect(billingWarning("unpaid")).toMatch(/has ended/);
    expect(billingWarning("active")).toBeNull();
    expect(billingWarning(null)).toBeNull();
  });
});
