import { describe, expect, it } from "vitest";
import { buildOperatorOverview, type OperatorFacts } from "../src/operator";
import type { Location, Organization } from "../src/schemas";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const org = (id: string, change: Partial<Organization> = {}): Organization => ({
  id,
  name: `Org ${id}`,
  max_locations: 5,
  max_queries_per_location: 10,
  max_manual_scans_per_day: 5,
  scan_every_days: 1,
  surfaces: null,
  is_test: false,
  created_at: ago(24 * 30),
  ...change,
});

const location = (
  id: string,
  organizationId: string,
  change: Partial<Location> = {},
): Location => ({
  id,
  organization_id: organizationId,
  name: `Location ${id}`,
  website: "https://example.com",
  phone: null,
  address_line: null,
  city: "Raleigh",
  region: "NC",
  postal_code: null,
  country_code: "US",
  google_place_id: null,
  primary_category: null,
  scan_frequency: "daily",
  last_scanned_at: ago(2),
  created_at: ago(24 * 20),
  ...change,
});

type ScanFact = OperatorFacts["scans"][number];
const scan = (locationId: string, hoursAgo: number, change: Partial<ScanFact> = {}): ScanFact => ({
  id: `scan-${locationId}-${hoursAgo}`,
  location_id: locationId,
  status: "succeeded",
  trigger: "scheduled",
  error: null,
  sample_data: false,
  created_at: ago(hoursAgo),
  site_check: null,
  ...change,
});

/** The facts with their lists open to change, so each test can build its problem. */
type Facts = {
  -readonly [K in keyof OperatorFacts]: OperatorFacts[K] extends readonly (infer Item)[]
    ? Item[]
    : OperatorFacts[K] extends Readonly<Record<string, number>>
      ? Record<string, number>
      : OperatorFacts[K];
};

/** One healthy organization with one healthy location, to build each problem on top of. */
const healthy = (): Facts => ({
  now: NOW,
  operatorOrganizationIds: [],
  organizations: [org("a")],
  locations: [location("l1", "a")],
  activePrompts: { l1: 3 },
  scans: [scan("l1", 2)],
  audits: [],
});
const kinds = (facts: Facts) => buildOperatorOverview(facts).attention.map((item) => item.kind);

describe("needs attention", () => {
  it("is empty when nothing is wrong", () => {
    expect(buildOperatorOverview(healthy()).attention).toEqual([]);
  });

  it("lists a failed scan with its reason, until a later scan of the location succeeds", () => {
    const facts = healthy();
    facts.scans = [scan("l1", 3, { status: "failed", error: "upstream 503" })];
    const [item] = buildOperatorOverview(facts).attention;
    expect(item).toMatchObject({
      kind: "scan_failed",
      organization_id: "a",
      location_id: "l1",
      detail: "upstream 503",
      at: ago(3),
    });

    facts.scans.push(scan("l1", 1));
    expect(kinds(facts)).toEqual([]);
  });

  it("says once when an organization's scans keep failing", () => {
    const facts = healthy();
    facts.locations.push(location("l2", "a"));
    facts.activePrompts.l2 = 1;
    facts.scans = [
      scan("l1", 30, { status: "failed", error: "x" }),
      scan("l2", 5, { status: "failed", error: "y" }),
    ];
    expect(kinds(facts)).toEqual(["organization_failing", "scan_failed", "scan_failed"]);
  });

  it("lists a scan that has been in flight too long, and not one that just started", () => {
    const facts = healthy();
    facts.scans = [scan("l1", 0.5, { status: "running" })];
    expect(kinds(facts)).toEqual(["scan_stuck"]);
    facts.scans = [scan("l1", 0.05, { status: "queued" })];
    expect(kinds(facts)).toEqual([]);
  });

  it("lists a location that was due for a scan and did not get one", () => {
    const facts = healthy();
    facts.scans = [];
    // Daily, and last scanned two days ago.
    facts.locations = [location("l1", "a", { last_scanned_at: ago(50) })];
    expect(kinds(facts)).toEqual(["scan_missed"]);

    // Weekly is not late after two days, and a paused location is never late.
    facts.locations = [location("l1", "a", { last_scanned_at: ago(50), scan_frequency: "weekly" })];
    expect(kinds(facts)).toEqual([]);
    facts.locations = [location("l1", "a", { last_scanned_at: ago(500), scan_frequency: "off" })];
    expect(kinds(facts)).toEqual([]);
    // The plan's pace counts: every three days is not late after two.
    facts.organizations = [org("a", { scan_every_days: 3 })];
    facts.locations = [location("l1", "a", { last_scanned_at: ago(50) })];
    expect(kinds(facts)).toEqual([]);
  });

  it("lists a website that could not be loaded, and one that keeps assistants out", () => {
    const facts = healthy();
    const check = (checks: { id: string; passed: boolean }[]) =>
      ({
        url: "https://example.com/",
        status: 200,
        checks,
        blocked_crawlers: [],
        words: 10,
      }) as never;
    facts.scans = [scan("l1", 2, { site_check: check([]) })];
    expect(kinds(facts)).toEqual(["site_unloaded"]);

    facts.scans = [
      scan("l1", 2, {
        site_check: check([
          { id: "reachable", passed: true },
          { id: "crawlers_allowed", passed: false },
        ]),
      }),
    ];
    expect(kinds(facts)).toEqual(["site_blocked"]);

    // A check that does not stop a crawler reading is the customer's to weigh, not a problem here.
    facts.scans = [
      scan("l1", 2, {
        site_check: check([
          { id: "reachable", passed: true },
          { id: "structured_data", passed: false },
        ]),
      }),
    ];
    expect(kinds(facts)).toEqual([]);
  });

  it("lists a failed audit", () => {
    const facts = healthy();
    facts.audits = [
      {
        id: "au1",
        business_name: "Tony's",
        status: "failed",
        error: "Some prompts could not be checked.",
        created_at: ago(5),
      },
      { id: "au2", business_name: "Done", status: "ready", error: null, created_at: ago(5) },
    ];
    expect(buildOperatorOverview(facts).attention).toEqual([
      expect.objectContaining({
        kind: "audit_failed",
        audit_id: "au1",
        detail: "The audit for Tony's failed: Some prompts could not be checked.",
      }),
    ]);
  });

  it("lists a location with nothing to ask, and an organization that has used up a limit", () => {
    const facts = healthy();
    facts.activePrompts = {};
    expect(kinds(facts)).toEqual(["no_prompts"]);

    const full = healthy();
    full.organizations = [org("a", { max_locations: 1 })];
    expect(kinds(full)).toEqual(["at_limit"]);
    const fullOfPrompts = healthy();
    fullOfPrompts.activePrompts = { l1: 10 };
    expect(kinds(fullOfPrompts)).toEqual(["at_limit"]);
  });

  it("puts what is broken before what a customer is stuck on, newest first within each", () => {
    const facts = healthy();
    facts.locations.push(location("l2", "a"));
    facts.activePrompts = { l1: 3 };
    facts.scans = [
      scan("l1", 9, { status: "failed", error: "older" }),
      scan("l2", 4, { status: "failed", error: "newer" }),
    ];
    const items = buildOperatorOverview(facts).attention;
    expect(items.map((item) => [item.kind, item.detail])).toEqual([
      ["organization_failing", expect.any(String)],
      ["scan_failed", "newer"],
      ["scan_failed", "older"],
      ["no_prompts", expect.any(String)],
    ]);
  });

  it("drops anything older than a week", () => {
    const facts = healthy();
    facts.scans = [scan("l1", 24 * 8, { status: "failed", error: "long ago" })];
    facts.audits = [
      { id: "au1", business_name: "x", status: "failed", error: "e", created_at: ago(24 * 8) },
    ];
    expect(kinds(facts)).toEqual([]);
  });
});

describe("what is counted", () => {
  it("counts real organizations, their locations and their scans, with failures", () => {
    const facts = healthy();
    facts.organizations.push(org("b"));
    facts.locations.push(location("l2", "b"));
    facts.activePrompts.l2 = 1;
    facts.scans = [
      scan("l1", 2),
      scan("l1", 30),
      scan("l2", 3, { status: "failed", error: "x" }),
      scan("l2", 1),
    ];
    expect(buildOperatorOverview(facts).totals).toEqual({
      organizations: 2,
      locations: 2,
      scans_24h: { total: 3, failed: 1 },
      scans_7d: { total: 4, failed: 1 },
    });
  });

  it("keeps test organizations apart: listed, never counted, never a problem", () => {
    const facts = healthy();
    facts.organizations.push(org("t", { is_test: true, name: "Smoke test" }));
    facts.locations.push(location("lt", "t", { last_scanned_at: null }));
    facts.scans.push(scan("lt", 1, { status: "failed", error: "x", sample_data: true }));

    const overview = buildOperatorOverview(facts);
    expect(overview.totals.organizations).toBe(1);
    expect(overview.totals.locations).toBe(1);
    expect(overview.totals.scans_7d).toEqual({ total: 1, failed: 0 });
    expect(overview.attention).toEqual([]);
    expect(overview.organizations.map((row) => row.id)).toEqual(["a"]);
    expect(overview.test_organizations.map((row) => row.name)).toEqual(["Smoke test"]);
  });
});

describe("the organizations list", () => {
  it("says how each is doing, with trouble first, and marks the operator's own", () => {
    const facts = healthy();
    facts.operatorOrganizationIds = ["a"];
    facts.organizations.push(org("b", { name: "Broken" }));
    facts.locations.push(location("l2", "b"));
    facts.activePrompts.l2 = 2;
    facts.scans = [scan("l1", 2), scan("l2", 3, { status: "failed", error: "x" })];

    const [first, second] = buildOperatorOverview(facts).organizations;
    expect(first).toMatchObject({
      id: "b",
      name: "Broken",
      is_yours: false,
      locations: 1,
      max_locations: 5,
      last_scan: { status: "failed", at: ago(3) },
      failed_7d: 1,
      scan_every_days: 1,
    });
    expect(second).toMatchObject({
      id: "a",
      is_yours: true,
      failed_7d: 0,
      last_scan: { status: "succeeded" },
    });
  });
});
