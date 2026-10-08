import type { ScanWindow, Surface } from "@nearcited/shared";
import type { TrendPoint } from "./trend";

export interface Rate {
  checks: number;
  mentions: number;
  /** Mentions over checks, or null when nothing was asked. */
  rate: number | null;
}

const rateOf = (checks: number, mentions: number): Rate => ({
  checks,
  mentions,
  rate: checks === 0 ? null : mentions / checks,
});

/** How often the business was named across every answer in the window. */
export function windowRate(cells: ScanWindow["cells"]): Rate {
  return rateOf(
    cells.reduce((sum, cell) => sum + cell.checks, 0),
    cells.reduce((sum, cell) => sum + cell.mentions, 0),
  );
}

/** The same, one figure per assistant, in the order given. */
export function surfaceRates(
  cells: ScanWindow["cells"],
  surfaces: readonly Surface[],
): (Rate & { surface: Surface })[] {
  return surfaces.map((surface) => ({
    surface,
    ...windowRate(cells.filter((cell) => cell.surface === surface)),
  }));
}

/**
 * How dark a rate is shaded: the share of green mixed into the cell, and whether the text on it
 * has to switch to the light colour to stay readable.
 */
export function rateTone(rate: number): { mix: number; strong: boolean } {
  return { mix: Math.round(8 + rate * 82), strong: rate >= 0.5 };
}

/** How many scans back the change in score is measured. */
export const CHANGE_OVER_SCANS = 7;

/**
 * The latest score less the score some scans earlier: seven when there are that many, otherwise
 * as far back as the history goes. Null when there is nothing to compare.
 */
export function scoreChange(trend: readonly TrendPoint[]): { by: number; scans: number } | null {
  const latest = trend[trend.length - 1];
  const scans = Math.min(CHANGE_OVER_SCANS, trend.length - 1);
  const earlier = trend[trend.length - 1 - scans];
  if (!latest || !earlier || scans < 1) return null;
  return { by: Math.round((latest.score - earlier.score) * 10) / 10, scans };
}

/** "+7", "−4" or "±0". */
export function signed(by: number): string {
  if (by === 0) return "±0";
  return `${by > 0 ? "+" : "−"}${Math.abs(by)}`;
}

/**
 * A line through the scores, scaled to the series' own low and high so a small movement is
 * visible at this size. Null when there are too few points to draw.
 */
export function sparkline(scores: readonly number[], width: number, height: number): string | null {
  if (scores.length < 2) return null;
  const low = Math.min(...scores);
  const span = Math.max(...scores) - low;
  const round = (value: number) => Math.round(value * 10) / 10;
  return scores
    .map((score, index) => {
      const x = (index / (scores.length - 1)) * width;
      const y = span === 0 ? height / 2 : height - ((score - low) / span) * height;
      return `${index === 0 ? "M" : "L"}${round(x)},${round(y)}`;
    })
    .join(" ");
}
