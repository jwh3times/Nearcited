import type { ScanWindow } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import { rateTone, scoreChange, sparkline, surfaceRates, windowRate } from "../src/lib/summary";

const cell = (surface: "chatgpt" | "claude", checks: number, mentions: number) => ({
  tracked_query_id: `q-${surface}-${checks}-${mentions}`,
  surface,
  checks,
  mentions,
  history: [],
});
const cells: ScanWindow["cells"] = [
  cell("chatgpt", 7, 5),
  cell("chatgpt", 7, 2),
  cell("claude", 4, 0),
];

describe("surfaceRates", () => {
  it("adds up each assistant's checks across prompts", () => {
    expect(surfaceRates(cells, ["chatgpt", "claude", "gemini"])).toEqual([
      { surface: "chatgpt", checks: 14, mentions: 7, rate: 0.5 },
      { surface: "claude", checks: 4, mentions: 0, rate: 0 },
      // Nothing was asked of it, which is not the same as never being named.
      { surface: "gemini", checks: 0, mentions: 0, rate: null },
    ]);
  });
});

describe("windowRate", () => {
  it("counts every answer in the window", () => {
    expect(windowRate(cells)).toEqual({ checks: 18, mentions: 7, rate: 7 / 18 });
    expect(windowRate([])).toEqual({ checks: 0, mentions: 0, rate: null });
  });
});

describe("rateTone", () => {
  it("shades from 8 to 90 percent, and switches to light text at half", () => {
    expect(rateTone(0)).toEqual({ mix: 8, strong: false });
    expect(rateTone(0.49)).toMatchObject({ strong: false });
    expect(rateTone(0.5)).toEqual({ mix: 49, strong: true });
    expect(rateTone(1)).toEqual({ mix: 90, strong: true });
  });
});

describe("scoreChange", () => {
  const trend = (...scores: number[]) =>
    scores.map((score, index) => ({ at: `2026-10-${String(index + 1).padStart(2, "0")}`, score }));

  it("compares the latest score with the one seven scans back", () => {
    expect(scoreChange(trend(10, 20, 30, 40, 50, 60, 70, 80, 90))).toEqual({ by: 70, scans: 7 });
  });

  it("goes back as far as there is when there are fewer", () => {
    expect(scoreChange(trend(40, 55, 36))).toEqual({ by: -4, scans: 2 });
  });

  it("has nothing to compare with one scan or none", () => {
    expect(scoreChange(trend(40))).toBeNull();
    expect(scoreChange([])).toBeNull();
  });
});

describe("sparkline", () => {
  it("scales to the series' own low and high", () => {
    expect(sparkline([50, 60, 70], 72, 24)).toBe("M0,24 L36,12 L72,0");
  });

  it("draws a flat series through the middle, and nothing for a single point", () => {
    expect(sparkline([40, 40], 72, 24)).toBe("M0,12 L72,12");
    expect(sparkline([40], 72, 24)).toBeNull();
  });
});
