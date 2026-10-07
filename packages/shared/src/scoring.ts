import { SURFACES, type Surface } from "./schemas";
import { defaultTuning, type ScoreWeights } from "./tuning";

/**
 * How much one check counts toward the visibility score.
 *
 * The weights come from the tuning (see ./tuning.ts). The defaults are a starting guess, not a
 * measured model: nobody has yet shown what a rank on one of these surfaces is worth in calls or
 * visits.
 */
export function positionWeight(
  position: number | null,
  weights: ScoreWeights = defaultTuning.score,
): number {
  if (position === null) return weights.unranked;
  const step = weights.by_position.find((candidate) => position <= candidate.through);
  return step ? step.weight : weights.beyond;
}

export interface ScoredCheck {
  mentioned: boolean;
  position: number | null;
}

/** 0–100, one decimal. Null when there was nothing to score. */
export function visibilityScore(
  checks: readonly ScoredCheck[],
  weights: ScoreWeights = defaultTuning.score,
): number | null {
  if (checks.length === 0) return null;
  const total = checks.reduce(
    (sum, check) => sum + (check.mentioned ? positionWeight(check.position, weights) : 0),
    0,
  );
  return Math.round((total / checks.length) * 1000) / 10;
}

export interface SurfaceSummary {
  surface: Surface;
  checks: number;
  mentions: number;
}

/** Per-surface totals, in canonical surface order, for surfaces that were checked. */
export function summarizeBySurface(
  results: readonly { surface: Surface; mentioned: boolean }[],
): SurfaceSummary[] {
  return SURFACES.map((surface) => {
    const forSurface = results.filter((result) => result.surface === surface);
    return {
      surface,
      checks: forSurface.length,
      mentions: forSurface.filter((result) => result.mentioned).length,
    };
  }).filter((summary) => summary.checks > 0);
}

/**
 * How many of a location's most recent scans a rate is counted over.
 *
 * One answer from an assistant is a sample: the same prompt can name different businesses an
 * hour apart. So the product reports "named in x of y" over this many scans, and scores from
 * that, instead of treating the latest answer as the truth.
 */
export const SCAN_WINDOW = 7;

/** One check, as far as the window is concerned. */
export interface WindowCheck {
  tracked_query_id: string;
  surface: Surface;
  mentioned: boolean;
  position: number | null;
}

/** One prompt on one surface, counted over the window. */
export interface WindowCell {
  tracked_query_id: string;
  surface: Surface;
  checks: number;
  mentions: number;
  /** Whether each check named the business, oldest first. As long as `checks`. */
  history: boolean[];
}

const cellKey = (check: Pick<WindowCheck, "tracked_query_id" | "surface">) =>
  `${check.tracked_query_id}|${check.surface}`;

/**
 * Every check in the window, newest scan first, for the cells the newest scan made.
 *
 * The newest scan decides which cells exist, so a prompt that was removed, or a surface that is
 * no longer checked, drops out of the rate at once instead of lingering for a week.
 */
export function poolWindow<T extends WindowCheck>(scans: readonly (readonly T[])[]): T[] {
  const [newest] = scans;
  if (!newest) return [];
  const current = new Set(newest.map(cellKey));
  return scans.flat().filter((check) => current.has(cellKey(check)));
}

/** A count per cell, in the order the newest scan lists them. */
export function summarizeWindow(scans: readonly (readonly WindowCheck[])[]): WindowCell[] {
  const cells = new Map<string, WindowCell>();
  for (const check of poolWindow(scans)) {
    const key = cellKey(check);
    const cell = cells.get(key) ?? {
      tracked_query_id: check.tracked_query_id,
      surface: check.surface,
      checks: 0,
      mentions: 0,
      history: [],
    };
    cell.checks += 1;
    if (check.mentioned) cell.mentions += 1;
    // The pool is newest scan first, so adding at the front leaves the oldest first.
    cell.history.unshift(check.mentioned);
    cells.set(key, cell);
  }
  return [...cells.values()];
}

/**
 * 0–100, one decimal, over the window. Null when there was nothing to score.
 *
 * Each cell is averaged over its own checks first, and the cells are then averaged, so a prompt
 * added yesterday counts as much as one tracked all week.
 */
export function windowScore(
  scans: readonly (readonly WindowCheck[])[],
  weights: ScoreWeights = defaultTuning.score,
): number | null {
  const totals = new Map<string, { sum: number; checks: number }>();
  for (const check of poolWindow(scans)) {
    const key = cellKey(check);
    const total = totals.get(key) ?? { sum: 0, checks: 0 };
    total.sum += check.mentioned ? positionWeight(check.position, weights) : 0;
    total.checks += 1;
    totals.set(key, total);
  }
  if (totals.size === 0) return null;
  const mean =
    [...totals.values()].reduce((sum, total) => sum + total.sum / total.checks, 0) / totals.size;
  return Math.round(mean * 1000) / 10;
}
