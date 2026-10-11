import { describe, expect, it } from "vitest";
import { deriveRecommendations } from "../src/recommendations";
import { LocationInputSchema } from "../src/schemas";
import {
  poolWindow,
  positionWeight,
  scansCounted,
  summarizeBySurface,
  summarizeWindow,
  visibilityScore,
  windowScore,
} from "../src/scoring";

describe("visibilityScore", () => {
  it("is null with nothing to score", () => {
    expect(visibilityScore([])).toBeNull();
  });

  it("is 100 when first everywhere and 0 when absent everywhere", () => {
    expect(visibilityScore([{ mentioned: true, position: 1 }])).toBe(100);
    expect(visibilityScore([{ mentioned: false, position: null }])).toBe(0);
  });

  it("averages weighted checks", () => {
    expect(
      visibilityScore([
        { mentioned: true, position: 1 },
        { mentioned: true, position: null },
        { mentioned: false, position: null },
      ]),
    ).toBe(53.3);
  });

  it("never rewards a lower rank more than a higher one", () => {
    const weights = Array.from({ length: 20 }, (_, i) => positionWeight(i + 1));
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);
  });
});

describe("summarizeBySurface", () => {
  it("skips surfaces that were not checked and keeps canonical order", () => {
    expect(
      summarizeBySurface([
        { surface: "google_local_pack", mentioned: true },
        { surface: "chatgpt", mentioned: false },
        { surface: "chatgpt", mentioned: true },
      ]),
    ).toEqual([
      { surface: "chatgpt", checks: 2, mentions: 1 },
      { surface: "google_local_pack", checks: 1, mentions: 1 },
    ]);
  });
});

describe("deriveRecommendations", () => {
  const complete = {
    name: "Joe's Pizza",
    website: "https://joes.example",
    google_place_id: "p1",
  };

  it("says nothing when the profile is complete and every surface names the business", () => {
    expect(
      deriveRecommendations(complete, [{ surface: "chatgpt", mentioned: true, competitors: [] }]),
    ).toEqual([]);
  });

  it("flags missing profile data", () => {
    const rules = deriveRecommendations({ ...complete, website: null, google_place_id: null }, [
      { surface: "google_local_pack", mentioned: true, competitors: [] },
    ]).map((recommendation) => recommendation.rule);
    expect(rules).toEqual(["add_website", "link_google_profile"]);
  });

  it("does not ask for the Google profile when nothing was checked on Google", () => {
    const rules = deriveRecommendations({ ...complete, google_place_id: null }, [
      { surface: "chatgpt", mentioned: true, competitors: [] },
    ]).map((recommendation) => recommendation.rule);
    expect(rules).toEqual([]);
  });

  it("counts one check as one check", () => {
    const [recommendation] = deriveRecommendations(complete, [
      { surface: "claude", mentioned: false, competitors: [] },
    ]);
    expect(recommendation?.detail).toBe("Joe's Pizza did not appear in the 1 check on Claude.");
  });

  it("names who appeared instead on a surface with no mentions", () => {
    const [recommendation] = deriveRecommendations(complete, [
      { surface: "gemini", mentioned: false, competitors: ["Tony's", "Crust & Co"] },
      { surface: "gemini", mentioned: false, competitors: ["Tony's"] },
      { surface: "chatgpt", mentioned: true, competitors: ["Tony's"] },
    ]);
    expect(recommendation?.rule).toBe("absent:gemini");
    expect(recommendation?.detail).toContain("any of 2 checks");
    expect(recommendation?.detail).toContain("Tony's, Crust & Co");
  });
});

describe("LocationInputSchema", () => {
  it("applies defaults and turns blank optional text into null", () => {
    const parsed = LocationInputSchema.parse({
      name: "  Joe's Pizza ",
      city: "Raleigh",
      website: "   ",
      country_code: "us",
    });
    expect(parsed).toMatchObject({
      name: "Joe's Pizza",
      website: null,
      phone: null,
      country_code: "US",
    });
  });

  it("rejects a website that is not http or https", () => {
    const result = LocationInputSchema.safeParse({
      name: "Joe's",
      city: "Raleigh",
      website: "javascript:alert(1)",
    });
    expect(result.success).toBe(false);
  });
});

describe("the scan window", () => {
  const check = (
    tracked_query_id: string,
    surface: "chatgpt" | "claude",
    position: number | null,
  ) => ({
    tracked_query_id,
    surface,
    mentioned: position !== null,
    position,
  });
  const absent = (tracked_query_id: string, surface: "chatgpt" | "claude") => ({
    tracked_query_id,
    surface,
    mentioned: false,
    position: null,
  });

  it("is empty with no scans", () => {
    expect(poolWindow([])).toEqual([]);
    expect(summarizeWindow([])).toEqual([]);
    expect(windowScore([])).toBeNull();
  });

  it("counts each cell over every scan in the window", () => {
    const scans = [
      [check("q1", "chatgpt", 1), absent("q1", "claude")],
      [absent("q1", "chatgpt"), absent("q1", "claude")],
      [check("q1", "chatgpt", 2), check("q1", "claude", 4)],
    ];
    // The scans are newest first; each cell's history reads oldest first.
    expect(summarizeWindow(scans)).toEqual([
      {
        tracked_query_id: "q1",
        surface: "chatgpt",
        checks: 3,
        mentions: 2,
        history: [true, false, true],
      },
      {
        tracked_query_id: "q1",
        surface: "claude",
        checks: 3,
        mentions: 1,
        history: [true, false, false],
      },
    ]);
  });

  it("lets the newest scan decide which cells exist", () => {
    const scans = [
      [check("q2", "chatgpt", 1)],
      [check("q1", "chatgpt", 1), check("q2", "chatgpt", 1), check("q2", "claude", 1)],
    ];
    // q1 was removed and Claude is no longer checked: neither counts any more.
    expect(summarizeWindow(scans)).toEqual([
      { tracked_query_id: "q2", surface: "chatgpt", checks: 2, mentions: 2, history: [true, true] },
    ]);
    expect(poolWindow(scans)).toHaveLength(2);
  });

  it("counts only the scans that asked something the newest scan asks", () => {
    const scans = [
      [check("q2", "chatgpt", 1)],
      [check("q1", "chatgpt", 1)],
      [check("q1", "chatgpt", 1), check("q2", "chatgpt", 1)],
    ];
    // The middle scan asked only a prompt that has since been retired.
    expect(scansCounted(scans)).toBe(2);
    expect(scansCounted([])).toBe(0);
  });

  it("scores one scan exactly as a single scan was scored before", () => {
    const scan = [check("q1", "chatgpt", 2), absent("q1", "claude")];
    expect(windowScore([scan])).toBe(visibilityScore(scan));
  });

  it("scores from the rate, so one miss in four does not read as absent", () => {
    const hit = [check("q1", "chatgpt", 1)];
    const miss = [absent("q1", "chatgpt")];
    expect(windowScore([miss, hit, hit, hit])).toBe(75);
    expect(windowScore([hit, miss, miss, miss])).toBe(25);
  });

  it("weighs a prompt added yesterday the same as one tracked all week", () => {
    const scans = [
      [absent("old", "chatgpt"), check("new", "chatgpt", 1)],
      [absent("old", "chatgpt")],
      [absent("old", "chatgpt")],
    ];
    // "old" is 0 of 3 and "new" is 1 of 1: the mean of the two cells, not 1 hit in 4 checks.
    expect(windowScore(scans)).toBe(50);
  });

  it("uses the weights it is given", () => {
    const flat = { unranked: 1, by_position: [{ through: 10, weight: 0.5 }], beyond: 0 };
    expect(windowScore([[check("q1", "chatgpt", 3)]], flat)).toBe(50);
  });
});
