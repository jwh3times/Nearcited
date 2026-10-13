import {
  buildTasks,
  CITING_SURFACES,
  type Draft,
  type Location,
  poolWindow,
  SCAN_WINDOW,
  type ScanResult,
  type SourceSummary,
  summarizeSources,
  type Task,
} from "@nearcited/shared";
import type { Store } from "./store/types";

/** The answers in a window that list their sources, and every site they cited. */
export function citedIn(
  recent: readonly (readonly ScanResult[])[],
  website: string | null,
): { answers: ScanResult[]; sources: SourceSummary[] } {
  // The same pool the rates are counted over, narrowed to the answers that list their sources.
  const answers = poolWindow(recent).filter((result) => CITING_SURFACES.includes(result.surface));
  // Every site, so nothing is called uncited because a list was cut.
  return { answers, sources: summarizeSources(answers, website, Number.POSITIVE_INFINITY) };
}

/**
 * A location's tasks as they stand now, without the counts either side of a mark: what a draft
 * is asked for against, and what the worker writes one from. `sample` says which scans to read,
 * since generated and real results never share a window. They carry no listing: a draft is
 * written from nothing a listing holds.
 */
export async function currentTasks(
  store: Store,
  location: Location,
  sample: boolean,
  drafts: readonly Draft[] = [],
): Promise<Task[]> {
  const [recommendations, recent] = await Promise.all([
    store.listRecommendations(location.id),
    store.listRecentResults(location.id, SCAN_WINDOW, sample),
  ]);
  const { answers, sources } = citedIn(recent, location.website);
  return buildTasks({
    name: location.name,
    recommendations,
    sources,
    answers: answers.length,
    evidence: new Map(),
    drafts,
    listings: [],
  });
}
