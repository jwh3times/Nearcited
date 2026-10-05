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
