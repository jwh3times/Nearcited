import { describe, expect, it } from "vitest";
import { deriveRecommendations } from "../src/recommendations";
import { LocationInputSchema } from "../src/schemas";
import { positionWeight, summarizeBySurface, visibilityScore } from "../src/scoring";

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
    const rules = deriveRecommendations(
      { ...complete, website: null, google_place_id: null },
      [],
    ).map((recommendation) => recommendation.rule);
    expect(rules).toEqual(["add_website", "link_google_profile"]);
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
      scan_frequency: "weekly",
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
