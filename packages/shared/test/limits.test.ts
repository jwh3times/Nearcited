import { describe, expect, it } from "vitest";
import { describeLowered, reductions, withoutReductions } from "../src/limits";

const plan = {
  max_queries_per_location: 10,
  assistants: 2,
  scan_every_days: 2,
  max_manual_scans_per_month: 10,
  emails_report: true,
};
const settings = { name: "Standard", on_sale: true, ...plan };

describe("reductions", () => {
  it("finds nothing in a plan left as it is, or only raised", () => {
    expect(reductions(plan, plan)).toEqual({});
    expect(reductions(plan, { ...plan, max_queries_per_location: 12, scan_every_days: 1 })).toEqual(
      {},
    );
  });

  it("counts fewer of anything, slower scans and a report that stops", () => {
    expect(
      reductions(plan, {
        max_queries_per_location: 5,
        assistants: 1,
        scan_every_days: 7,
        max_manual_scans_per_month: 0,
        emails_report: false,
      }),
    ).toEqual({
      max_queries_per_location: { from: 10, to: 5 },
      assistants: { from: 2, to: 1 },
      scan_every_days: { from: 2, to: 7 },
      max_manual_scans_per_month: { from: 10, to: 0 },
      emails_report: { from: true, to: false },
    });
  });

  it("does not count a report starting on a plan that had none", () => {
    expect(reductions({ ...plan, emails_report: false }, plan)).toEqual({});
  });
});

describe("withoutReductions", () => {
  it("keeps what goes up and the name, and puts back what would go down", () => {
    expect(
      withoutReductions(plan, {
        ...settings,
        name: "Standard Plus",
        max_queries_per_location: 5,
        max_manual_scans_per_month: 20,
        scan_every_days: 7,
      }),
    ).toEqual({
      ...settings,
      name: "Standard Plus",
      max_manual_scans_per_month: 20,
    });
  });
});

describe("describeLowered", () => {
  it("writes a line for each limit, for a change still to come and for one made", () => {
    const lowered = {
      scan_every_days: { from: 1, to: 7 },
      emails_report: { from: true, to: false },
    };
    expect(describeLowered(lowered)).toEqual([
      "Scheduled scans: every day now, every 7 days after",
      "The report by email after each scan: included now, not after",
    ]);
    expect(describeLowered(lowered, true)).toEqual([
      "Scheduled scans: every day before, every 7 days now",
      "The report by email after each scan: included before, not now",
    ]);
  });
});
