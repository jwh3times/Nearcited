import type { Scan } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import { buildTrend, plotTrend } from "../src/lib/trend";

let made = 0;
const scan = (day: number, score: number | null, change: Partial<Scan> = {}): Scan => ({
  id: `00000000-0000-4000-8000-${String(++made).padStart(12, "0")}`,
  location_id: "00000000-0000-4000-8000-0000000000aa",
  status: "succeeded",
  trigger: "scheduled",
  visibility_score: score,
  error: null,
  sample_data: false,
  created_at: `2026-10-${String(day).padStart(2, "0")}T09:00:00Z`,
  started_at: `2026-10-${String(day).padStart(2, "0")}T09:00:01Z`,
  finished_at: `2026-10-${String(day).padStart(2, "0")}T09:00:30Z`,
  ...change,
});

describe("buildTrend", () => {
  it("is empty with no scored scans", () => {
    expect(buildTrend([])).toEqual([]);
    expect(buildTrend([scan(1, null, { status: "failed" }), scan(2, null)])).toEqual([]);
  });

  it("orders scans oldest first, whatever order they arrive in", () => {
    // The API returns the newest first.
    const trend = buildTrend([scan(3, 60), scan(2, 40), scan(1, 20)]);
    expect(trend.map((point) => point.score)).toEqual([20, 40, 60]);
    expect(trend[0]?.at).toBe("2026-10-01T09:00:30Z");
  });

  it("leaves out scans that failed or are still under way", () => {
    const trend = buildTrend([
      scan(1, 20),
      scan(2, null, { status: "failed" }),
      scan(3, null, { status: "running", finished_at: null }),
      scan(4, 50),
    ]);
    expect(trend.map((point) => point.score)).toEqual([20, 50]);
  });

  it("never mixes sample scans with real ones: the latest scan decides which kind is drawn", () => {
    const scans = [scan(1, 90, { sample_data: true }), scan(2, 10), scan(3, 20)];
    expect(buildTrend(scans).map((point) => point.score)).toEqual([10, 20]);
    expect(buildTrend([...scans, scan(4, 80, { sample_data: true })]).map((p) => p.score)).toEqual([
      90, 80,
    ]);
  });

  it("keeps a score of zero", () => {
    expect(buildTrend([scan(1, 0), scan(2, 0)])).toHaveLength(2);
  });
});

describe("plotTrend", () => {
  it("puts 100 at the top and 0 at the bottom, on a fixed scale", () => {
    const [low, high] = plotTrend(buildTrend([scan(1, 0), scan(2, 100)]), 600, 100);
    expect([low?.y, high?.y]).toEqual([100, 0]);
    // A wobble between 40 and 45 stays a wobble.
    const [a, b] = plotTrend(buildTrend([scan(1, 40), scan(2, 45)]), 600, 100);
    expect(Math.abs((a?.y ?? 0) - (b?.y ?? 0))).toBe(5);
  });

  it("spaces points by time, so a gap between scans shows as a gap", () => {
    const xs = plotTrend(buildTrend([scan(1, 10), scan(2, 10), scan(11, 10)]), 600, 100).map(
      (point) => point.x,
    );
    expect(xs[0]).toBe(0);
    expect(xs[1]).toBeCloseTo(60, 0);
    expect(xs[2]).toBe(600);
  });

  it("centres a single point", () => {
    expect(plotTrend(buildTrend([scan(1, 30)]), 600, 100)[0]).toMatchObject({ x: 300, y: 70 });
  });
});
