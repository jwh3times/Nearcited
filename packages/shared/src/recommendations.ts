import { SURFACE_LABELS, type Surface } from "./schemas";
import { summarizeBySurface } from "./scoring";

export interface DerivedRecommendation {
  /** Stable key. One open recommendation per rule per location. */
  rule: string;
  title: string;
  detail: string;
}

interface LocationFacts {
  name: string;
  website: string | null;
  google_place_id: string | null;
}

interface ResultFacts {
  surface: Surface;
  mentioned: boolean;
  competitors: string[];
}

function mostNamed(results: readonly ResultFacts[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const result of results) {
    for (const competitor of result.competitors) {
      counts.set(competitor, (counts.get(competitor) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => name);
}

/**
 * Rule-based next steps from one scan.
 *
 * This is deliberately thin. The rules below are things that are checkable from data the product
 * already holds; they are not evidence that acting on them moves visibility. Add a rule only when
 * you can say what would have to be true in a later scan for it to count as having worked.
 */
export function deriveRecommendations(
  location: LocationFacts,
  results: readonly ResultFacts[],
): DerivedRecommendation[] {
  const recommendations: DerivedRecommendation[] = [];

  if (!location.website) {
    recommendations.push({
      rule: "add_website",
      title: "Add the website for this location",
      detail:
        "Assistants cite pages. Without a website on file, a citation of your own site cannot be detected, and matching falls back to the business name alone.",
    });
  }

  if (!location.google_place_id) {
    recommendations.push({
      rule: "link_google_profile",
      title: "Link the Google Business Profile",
      detail:
        "Map pack results are matched by place ID first. Without one, a listing under a slightly different name can be missed.",
    });
  }

  for (const summary of summarizeBySurface(results)) {
    if (summary.mentions > 0) continue;
    const named = mostNamed(
      results.filter((result) => result.surface === summary.surface),
      3,
    );
    const label = SURFACE_LABELS[summary.surface];
    recommendations.push({
      rule: `absent:${summary.surface}`,
      title: `Not named on ${label}`,
      detail:
        named.length > 0
          ? `${location.name} did not appear in any of ${summary.checks} checks on ${label}. Named instead: ${named.join(", ")}.`
          : `${location.name} did not appear in any of ${summary.checks} checks on ${label}.`,
    });
  }

  return recommendations;
}
