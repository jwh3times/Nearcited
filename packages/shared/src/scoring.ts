import { type CheckOutcome, SURFACES, type Surface, type Tier } from "./schemas";
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
  /** The checks that showed something. */
  checks: number;
  mentions: number;
  /** The checks where Google showed nothing. */
  not_shown: number;
}

/** Per-surface totals, in canonical surface order, for surfaces that were checked. */
export function summarizeBySurface(
  results: readonly { surface: Surface; shown?: boolean; mentioned: boolean }[],
): SurfaceSummary[] {
  return SURFACES.map((surface) => {
    const forSurface = results.filter((result) => result.surface === surface);
    const shown = forSurface.filter(isCounted);
    return {
      surface,
      checks: shown.length,
      mentions: shown.filter((result) => result.mentioned).length,
      not_shown: forSurface.length - shown.length,
    };
  }).filter((summary) => summary.checks + summary.not_shown > 0);
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
  /** The model it was asked with. Left out, as on a result kept before tiers, it is Standard. */
  tier?: Tier;
  /** False when Google showed nothing for the search. Left out, it was shown. */
  shown?: boolean;
  mentioned: boolean;
  position: number | null;
}

/**
 * Whether a check counts. One where Google showed nothing is kept, so its column can say so,
 * and counted nowhere: not in a score, a rate, an alert or a recommendation (ADR 0024).
 */
export const isCounted = (check: { shown?: boolean }): boolean => check.shown !== false;

/** One prompt on one surface, counted over the window. */
export interface WindowCell {
  tracked_query_id: string;
  surface: Surface;
  /** The checks that showed something. */
  checks: number;
  mentions: number;
  /** The checks where Google showed nothing. */
  not_shown: number;
  /** What each check found, oldest first. As long as `checks` and `not_shown` together. */
  history: CheckOutcome[];
}

/** What one check found. */
export const outcomeOf = (check: { shown?: boolean; mentioned: boolean }): CheckOutcome =>
  !isCounted(check) ? "not_shown" : check.mentioned ? "named" : "not_named";

/**
 * One prompt on one surface at one tier. A prompt asked of a stronger model is a cell of its
 * own, so a change of tier starts the assistant's count again, as a change of assistant does.
 */
export const cellKey = (check: Pick<WindowCheck, "tracked_query_id" | "surface" | "tier">) =>
  check.tier === "stronger"
    ? `${check.tracked_query_id}|${check.surface}|stronger`
    : `${check.tracked_query_id}|${check.surface}`;

/**
 * Every check in the window, newest scan first, for the cells the newest scan made.
 *
 * The newest scan decides which cells exist, so a prompt that was removed, a surface that is
 * no longer checked, or a tier no longer paid for, drops out of the rate at once instead of
 * lingering for a week.
 */
export function poolWindow<T extends WindowCheck>(scans: readonly (readonly T[])[]): T[] {
  const [newest] = scans;
  if (!newest) return [];
  const current = new Set(newest.map(cellKey));
  return scans.flat().filter((check) => current.has(cellKey(check)));
}

/**
 * How many of the scans the pool draws on. A scan that asked only prompts since retired adds
 * nothing to it, so saying "the last five scans" over two answers would overstate the evidence.
 */
export function scansCounted(scans: readonly (readonly WindowCheck[])[]): number {
  const [newest] = scans;
  if (!newest) return 0;
  const current = new Set(newest.map(cellKey));
  return scans.filter((scan) => scan.some((check) => current.has(cellKey(check)))).length;
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
      not_shown: 0,
      history: [],
    };
    if (!isCounted(check)) cell.not_shown += 1;
    else {
      cell.checks += 1;
      if (check.mentioned) cell.mentions += 1;
    }
    // The pool is newest scan first, so adding at the front leaves the oldest first.
    cell.history.unshift(outcomeOf(check));
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
  // A cell whose checks all showed nothing is left out, so it neither raises nor lowers it.
  for (const check of poolWindow(scans).filter(isCounted)) {
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
