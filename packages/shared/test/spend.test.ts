import { describe, expect, it } from "vitest";
import type { UsageByMonth } from "../src/schemas";
import { OperatorSpendSchema } from "../src/schemas";
import { buildSpend, monthOf, monthStart } from "../src/spend";

const rates = {
  "model-a": {
    input_per_million: 2,
    cached_input_per_million: 0.5,
    output_per_million: 10,
    per_thousand_searches: 10,
  },
};
const PIZZA = "a0000000-0000-4000-8000-000000000001";
const MINE = "a0000000-0000-4000-8000-000000000002";
const TEST = "a0000000-0000-4000-8000-000000000003";
const organizations = [
  { id: PIZZA, name: "Raleigh Pizza Group", is_test: false },
  { id: MINE, name: "The operator's own", is_test: false },
  { id: TEST, name: "Smoke test", is_test: true },
];
/** One million input tokens on model-a: $2. */
const row = (change: Partial<UsageByMonth>): UsageByMonth => ({
  month: "2026-10",
  organization_id: PIZZA,
  is_audit: false,
  model: "model-a",
  calls: 1,
  input_tokens: 1_000_000,
  cached_input_tokens: 0,
  output_tokens: 0,
  searches: 0,
  ...change,
});
const spend = (usage: UsageByMonth[], months = 2) =>
  buildSpend({
    now: new Date("2026-10-08T12:00:00Z"),
    months,
    rates,
    operatorOrganizationIds: [MINE],
    organizations,
    usage,
  });

describe("monthOf", () => {
  it("names the calendar month in UTC, and the ones before it", () => {
    // Still September in UTC, though already October further east.
    expect(monthOf(new Date("2026-09-30T23:59:59Z"))).toBe("2026-09");
    expect(monthOf(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10");
    expect(monthOf(new Date("2026-01-15T00:00:00Z"), 1)).toBe("2025-12");
    // The 31st has no counterpart in a shorter month, and must not skip one.
    expect(monthOf(new Date("2026-03-31T12:00:00Z"), 1)).toBe("2026-02");
    expect(monthStart("2026-09")).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("buildSpend", () => {
  it("shows the months asked for, this one first, even when nothing was spent", () => {
    const result = spend([]);
    expect(OperatorSpendSchema.parse(result)).toEqual(result);
    expect(result.months).toEqual([
      { month: "2026-10", total: 0, organizations: [], audits: 0, deleted: 0, unpriced: [] },
      { month: "2026-09", total: 0, organizations: [], audits: 0, deleted: 0, unpriced: [] },
    ]);
  });

  it("adds up each organization, audits and deleted organizations, and their total", () => {
    const [october, september] = spend([
      row({}),
      row({ model: "model-a-2026-08-01", input_tokens: 500_000 }),
      row({ organization_id: MINE, input_tokens: 4_000_000 }),
      row({ organization_id: null, is_audit: true, input_tokens: 250_000 }),
      row({ organization_id: null, input_tokens: 100_000 }),
      row({ organization_id: "a0000000-0000-4000-8000-00000000dead", input_tokens: 100_000 }),
      row({ month: "2026-09", searches: 100 }),
      // Older than the months shown.
      row({ month: "2026-08" }),
    ]).months;

    expect(october).toEqual({
      month: "2026-10",
      total: 11.9,
      organizations: [
        { organization_id: MINE, name: "The operator's own", is_yours: true, cost: 8 },
        { organization_id: PIZZA, name: "Raleigh Pizza Group", is_yours: false, cost: 3 },
      ],
      audits: 0.5,
      deleted: 0.4,
      unpriced: [],
    });
    expect(september).toMatchObject({ total: 3, organizations: [{ cost: 3 }] });
  });

  it("never counts a test organization", () => {
    const [october] = spend([row({ organization_id: TEST })]).months;
    expect(october).toMatchObject({ total: 0, organizations: [] });
  });

  it("names a model it has no rate for, and leaves it out of the total", () => {
    const [october] = spend([
      row({}),
      row({ model: "model-b", calls: 3 }),
      row({ model: "model-b", calls: 2, organization_id: null, is_audit: true }),
    ]).months;
    expect(october).toMatchObject({
      total: 2,
      audits: 0,
      unpriced: [{ model: "model-b", calls: 5 }],
    });
  });
});
