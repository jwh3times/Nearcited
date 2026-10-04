import { SURFACES, type Surface } from "./schemas";

/**
 * How much one check counts toward the visibility score.
 *
 * These weights are a starting guess, not a measured model: nobody has yet shown what a rank on
 * one of these surfaces is worth in calls or visits. Replace them once there is outcome data.
 */
export function positionWeight(position: number | null): number {
  if (position === null) return 0.6; // named, but the surface gave no order
  if (position <= 1) return 1;
  if (position === 2) return 0.8;
  if (position === 3) return 0.65;
  if (position <= 5) return 0.5;
  if (position <= 10) return 0.3;
  return 0.15;
}

export interface ScoredCheck {
  mentioned: boolean;
  position: number | null;
}

/** 0–100, one decimal. Null when there was nothing to score. */
export function visibilityScore(checks: readonly ScoredCheck[]): number | null {
  if (checks.length === 0) return null;
  const total = checks.reduce(
    (sum, check) => sum + (check.mentioned ? positionWeight(check.position) : 0),
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
