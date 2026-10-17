import { type Scan, SURFACES, type TierChange, tierChanges } from "@nearcited/shared";

export interface TrendPoint {
  /** When the scan finished. */
  at: string;
  /** 0 to 100, over the window of scans that one closed. */
  score: number;
  /**
   * The assistants this scan asked on a different tier from the scan before, so a jump in the
   * line has its reason beside it.
   */
  changes: TierChange[];
}

/**
 * The visibility score over time, oldest first.
 *
 * Only successful scans with a score count, and only those of the same kind as the most recent
 * one: scans on generated sample data never share a chart with real ones.
 */
export function buildTrend(scans: readonly Scan[]): TrendPoint[] {
  const scored = scans
    .filter((scan) => scan.status === "succeeded" && scan.visibility_score !== null)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const latest = scored[scored.length - 1];
  if (!latest) return [];
  const drawn = scored.filter((scan) => scan.sample_data === latest.sample_data);
  const changes = tierChanges(
    drawn.map((scan) =>
      SURFACES.flatMap((surface) => {
        const tier = scan.tiers[surface];
        return tier ? [{ surface, tier }] : [];
      }),
    ),
  );
  return drawn.map((scan, index) => ({
    at: scan.finished_at ?? scan.created_at,
    score: scan.visibility_score as number,
    changes: changes[index] ?? [],
  }));
}

export interface PlottedPoint extends TrendPoint {
  x: number;
  y: number;
}

/**
 * Places points in a plot area. X is spaced by time, so a gap between scans shows as a gap. The
 * score axis always runs 0 to 100, so a small wobble is not drawn as a cliff.
 */
export function plotTrend(
  points: readonly TrendPoint[],
  width: number,
  height: number,
): PlottedPoint[] {
  const times = points.map((point) => Date.parse(point.at));
  const first = Math.min(...times);
  const span = Math.max(...times) - first;
  return points.map((point, index) => ({
    ...point,
    // A single point, or several at the same instant, sit in the middle.
    x: span === 0 ? width / 2 : (((times[index] ?? first) - first) / span) * width,
    y: height - (point.score / 100) * height,
  }));
}
