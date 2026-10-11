import { describe, expect, it } from "vitest";
import {
  ALLOWANCE_KINDS,
  type AllowanceKind,
  allowanceErrors,
  allowanceFacts,
  allowanceLines,
  allowanceReductions,
  allowancesAsText,
  allowancesFromText,
  allowedEachMonth,
  describeLoweredAllowances,
  keepUnknownAllowances,
  knownAllowances,
  unknownAllowances,
} from "../src/allowances";
import { AllowancesSchema, OrganizationLimitsSchema, PlanSettingsSchema } from "../src/schemas";

// No kind exists yet, so these stand in for the first ones.
const KINDS: Record<string, AllowanceKind> = {
  drafts: { counted: true, name: "Drafts written for you" },
  google_profile: { counted: false, name: "Your Google profile kept right" },
};

describe("the kinds of allowance", () => {
  it("have keys the database will take", () => {
    for (const key of Object.keys(ALLOWANCE_KINDS)) {
      expect(key).toMatch(/^[a-z][a-z0-9_]{1,40}$/);
    }
  });
});

describe("AllowancesSchema", () => {
  it("takes true or a whole number of one or more, and keeps a kind it has no words for", () => {
    expect(AllowancesSchema.parse({ drafts: 12, google_profile: true, not_built_yet: 5 })).toEqual({
      drafts: 12,
      google_profile: true,
      not_built_yet: 5,
    });
    for (const bad of [0, -1, 2.5, false, "12", null]) {
      expect(AllowancesSchema.safeParse({ drafts: bad }).success, String(bad)).toBe(false);
    }
  });
});

describe("allowanceReductions", () => {
  it("finds a kind taken away and a smaller number, and nothing in a raise", () => {
    expect(
      allowanceReductions({ drafts: 12, google_profile: true }, { drafts: 5, replies: 8 }),
    ).toEqual({
      drafts: { from: 12, to: 5 },
      google_profile: { from: true, to: false },
    });
    expect(allowanceReductions({ drafts: 12 }, { drafts: 24, google_profile: true })).toEqual({});
    expect(allowanceReductions({}, {})).toEqual({});
  });
});

describe("allowedEachMonth", () => {
  it("is the plan's number for each location it covers, shared between them", () => {
    expect(allowedEachMonth(12, 3)).toBe(36);
    expect(allowedEachMonth(12, 0)).toBe(0);
  });
});

describe("allowanceLines", () => {
  it("lists what a plan includes in the order the kinds are listed, leaving out the rest", () => {
    expect(allowanceLines({ google_profile: true, drafts: 12, not_built_yet: 5 }, KINDS)).toEqual([
      "Drafts written for you: 12 a month for each location",
      "Your Google profile kept right",
    ]);
    expect(allowanceLines({}, KINDS)).toEqual([]);
  });

  it("uses the kinds this build lists when it is given no others", () => {
    expect(allowanceLines({ not_built_yet: 5 })).toEqual([]);
  });
});

describe("describeLoweredAllowances", () => {
  it("uses a kind's own name where there is one", () => {
    expect(
      describeLoweredAllowances(
        { drafts: { from: 12, to: 5 }, google_profile: { from: true, to: false } },
        "now",
        "after",
        KINDS,
      ),
    ).toEqual([
      "Drafts written for you, a month for each location: 12 now, 5 after",
      "Your Google profile kept right: included now, not after",
    ]);
  });
});

describe("allowanceErrors", () => {
  it("accepts a kind that exists with a value it takes", () => {
    expect(allowanceErrors({ drafts: 12, google_profile: true }, KINDS)).toEqual({});
    expect(allowanceErrors({}, KINDS)).toEqual({});
  });

  it("refuses a kind that does not exist and a value its kind does not take", () => {
    expect(
      allowanceErrors({ typo: 5, drafts: 2.5, google_profile: 3 as unknown as true }, KINDS),
    ).toEqual({
      typo: "This is not a kind of allowance",
      drafts: "Enter a whole number, or leave it empty for none",
      google_profile: "This is included or it is not",
    });
    expect(allowanceErrors({ drafts: Number.NaN }, KINDS)).toHaveProperty("drafts");
    expect(allowanceErrors({ drafts: 1_000_001 }, KINDS)).toEqual({
      drafts: "Enter 1,000,000 or fewer",
    });
  });
});

describe("what the operator types", () => {
  it("becomes a set, where an empty field or a zero is a kind that is not included", () => {
    expect(allowancesFromText({ drafts: "12", google_profile: true }, KINDS)).toEqual({
      drafts: 12,
      google_profile: true,
    });
    expect(allowancesFromText({ drafts: " ", google_profile: false }, KINDS)).toEqual({});
    expect(allowancesFromText({ drafts: "0", google_profile: false }, KINDS)).toEqual({});
  });

  it("keeps what is not a number as it is not, so the check can say so", () => {
    const typed = allowancesFromText({ drafts: "lots", google_profile: false }, KINDS);
    expect(allowanceErrors(typed, KINDS)).toHaveProperty("drafts");
  });

  it("starts from a set, with every kind present", () => {
    expect(allowancesAsText({ drafts: 12 }, KINDS)).toEqual({
      drafts: "12",
      google_profile: false,
    });
    expect(allowancesAsText({ google_profile: true }, KINDS)).toEqual({
      drafts: "",
      google_profile: true,
    });
  });
});

describe("unknownAllowances and knownAllowances", () => {
  it("split a set into the kinds this build has no words for and the kinds its forms show", () => {
    const kept = { drafts: 12, not_built_yet: 5 };
    expect(unknownAllowances(kept, KINDS)).toEqual({ not_built_yet: 5 });
    expect(knownAllowances(kept, KINDS)).toEqual({ drafts: 12 });
  });
});

describe("keepUnknownAllowances", () => {
  it("saves what a form sent, with the kinds this build does not know put back", () => {
    const stored = { drafts: 12, google_profile: true as const, not_built_yet: 5 };
    // The form shows drafts and the profile. It raised one and unticked the other.
    expect(keepUnknownAllowances(stored, { drafts: 24 }, KINDS)).toEqual({
      drafts: 24,
      not_built_yet: 5,
    });
    expect(keepUnknownAllowances(stored, {}, KINDS)).toEqual({ not_built_yet: 5 });
    expect(keepUnknownAllowances({}, { drafts: 24 }, KINDS)).toEqual({ drafts: 24 });
  });
});

describe("allowanceFacts", () => {
  it("lists what an organization has, counted across the locations its plan covers", () => {
    expect(
      allowanceFacts({ google_profile: true, drafts: 12, not_built_yet: 5 }, 3, null, KINDS),
    ).toEqual([
      { key: "drafts", name: "Drafts written for you", value: "36 this month" },
      { key: "google_profile", name: "Your Google profile kept right", value: "Included" },
    ]);
    expect(allowanceFacts({}, 3, null, KINDS)).toEqual([]);
  });

  it("says how much of the month is used, once that is known", () => {
    const facts = (used: Record<string, number>) =>
      allowanceFacts({ drafts: 12 }, 3, used, KINDS).map((fact) => fact.value);
    expect(facts({ drafts: 7 })).toEqual(["7 of 36 this month"]);
    expect(facts({})).toEqual(["0 of 36 this month"]);
  });
});

describe("the operator's inputs", () => {
  const limits = {
    max_locations: 3,
    max_queries_per_location: 5,
    max_manual_scans_per_month: 5,
    scan_every_days: 2,
  };
  const settings = {
    name: "Standard",
    on_sale: true,
    max_queries_per_location: 5,
    assistants: 2,
    scan_every_days: 2,
    max_manual_scans_per_month: 5,
    emails_report: true,
  };

  it("need the allowances, so that leaving them out cannot be read as taking them away", () => {
    expect(PlanSettingsSchema.safeParse(settings).success).toBe(false);
    expect(OrganizationLimitsSchema.safeParse(limits).success).toBe(false);
    expect(PlanSettingsSchema.safeParse({ ...settings, allowances: {} }).success).toBe(true);
    expect(OrganizationLimitsSchema.safeParse({ ...limits, allowances: {} }).success).toBe(true);
  });

  it("refuse a kind that does not exist", () => {
    const result = PlanSettingsSchema.safeParse({ ...settings, allowances: { typo: 5 } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["allowances"],
      message: "This is not a kind of allowance",
    });
  });
});
