import {
  buildPageTasks,
  buildTasks,
  CITING_SURFACES,
  type Draft,
  type DraftKind,
  isCounted,
  type Location,
  pageDraftSubject,
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
  const answers = poolWindow(recent).filter(
    (result) => CITING_SURFACES.includes(result.surface) && isCounted(result),
  );
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

/** A task a draft can be asked for, of either sort: what the draft is written for. */
export interface DraftSubject {
  id: string;
  draft_kind: DraftKind | null;
  host: string;
  url: string | null;
  prompt: string | null;
}

/**
 * Every task a draft can be asked for at a location as things stand now: the sources' tasks and
 * the pages' (`pages.ts`), each reduced to what its draft is written for. What a draft is asked
 * for against, and what the worker writes one from.
 */
export async function currentDraftSubjects(
  store: Store,
  location: Location,
  sample: boolean,
): Promise<DraftSubject[]> {
  const [tasks, recommendations, queries, recent] = await Promise.all([
    currentTasks(store, location, sample),
    store.listRecommendations(location.id),
    store.listQueries(location.id),
    store.listRecentResults(location.id, SCAN_WINDOW, sample),
  ]);
  const pages = buildPageTasks({
    name: location.name,
    recommendations,
    queries,
    results: poolWindow(recent),
    evidence: new Map(),
    drafts: [],
    pages: [],
  });
  return [
    ...tasks.map(({ id, draft_kind, host, url }) => ({ id, draft_kind, host, url, prompt: null })),
    ...pages.map((page) => pageDraftSubject(page, location.website)),
  ];
}
