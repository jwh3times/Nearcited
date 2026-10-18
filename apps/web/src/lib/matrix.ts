import {
  type CheckOutcome,
  QUERY_KINDS,
  type QueryKind,
  type ScanResult,
  type ScanWindow,
  SURFACES_BY_KIND,
  type Surface,
  type TrackedQuery,
} from "@nearcited/shared";
import { formatDate } from "./format";

export interface MatrixCell {
  surface: Surface;
  /** Null when this surface was not checked for this query in the scan. */
  result: ScanResult | null;
  /**
   * How often the business was named over the recent scans, out of the checks that showed
   * something. Null before the first one.
   */
  rate: { checks: number; mentions: number; not_shown: number; history: CheckOutcome[] } | null;
}

export interface MatrixRow {
  query: TrackedQuery;
  cells: MatrixCell[];
}

export interface MatrixGroup {
  kind: QueryKind;
  surfaces: readonly Surface[];
  rows: MatrixRow[];
}

/**
 * One table per query kind: a row per query, a column per surface that kind is checked on.
 *
 * When `checked` is given, a surface with no provider set up gets no column, unless the latest
 * scan still holds a result for it. A column of "Not checked" down every row says nothing.
 */
export function buildMatrix(
  queries: TrackedQuery[],
  results: ScanResult[],
  window?: ScanWindow,
  checked?: readonly Surface[],
): MatrixGroup[] {
  const byKey = new Map(
    results.map((result) => [`${result.tracked_query_id}|${result.surface}`, result]),
  );
  const rates = new Map(
    (window?.cells ?? []).map((cell) => [`${cell.tracked_query_id}|${cell.surface}`, cell]),
  );

  return QUERY_KINDS.map((kind) => {
    const surfaces = SURFACES_BY_KIND[kind].filter(
      (surface) =>
        !checked ||
        checked.includes(surface) ||
        results.some((result) => result.surface === surface),
    );
    return {
      kind,
      surfaces,
      rows: queries
        .filter((query) => query.kind === kind)
        .map((query) => ({
          query,
          cells: surfaces.map((surface) => ({
            surface,
            result: byKey.get(`${query.id}|${surface}`) ?? null,
            rate: rates.get(`${query.id}|${surface}`) ?? null,
          })),
        })),
    };
  }).filter((group) => group.rows.length > 0);
}

/** What Google left out, in a cell's words, for each surface on which it can show nothing. */
const NOTHING_SHOWN: Partial<Record<Surface, string>> = {
  google_ai_overview: "No AI Overview",
  google_ai_mode: "No AI Mode answer",
  google_local_pack: "No map results",
  google_organic: "No organic results",
};

/** The same, as a sentence says it. */
const NOTHING_SHOWN_SAID: Partial<Record<Surface, string>> = {
  google_ai_overview: "showed no AI Overview",
  google_ai_mode: "gave no AI Mode answer",
  google_local_pack: "showed no map results",
  google_organic: "showed no organic results",
};

export type CellReading =
  | { kind: "not_checked" }
  /** No search in the window showed anything, so there is no rate to give. */
  | { kind: "nothing_shown"; text: string }
  | { kind: "rate"; mentions: number; checks: number; latest: string };

/**
 * What a cell says. A check where Google showed nothing is out of the rate, and the cell says
 * what was missing instead of calling the business not named (ADR 0024).
 */
export function readCell({ surface, result, rate }: MatrixCell): CellReading {
  if (!result) return { kind: "not_checked" };
  const missing = NOTHING_SHOWN[surface] ?? "Nothing shown";
  const checks = rate?.checks ?? (result.shown ? 1 : 0);
  if (checks === 0) {
    const scans = rate?.not_shown ?? 1;
    return {
      kind: "nothing_shown",
      text: `${missing} ${scans === 1 ? "in the latest scan" : `in the last ${scans} scans`}`,
    };
  }
  const latest = !result.shown
    ? `${missing} latest`
    : !result.mentioned
      ? "Not named latest"
      : result.position === null
        ? "Named"
        : `Latest ${ordinal(result.position)}`;
  return { kind: "rate", mentions: rate?.mentions ?? (result.mentioned ? 1 : 0), checks, latest };
}

const OUTCOME_WORDS: Record<CheckOutcome, string> = {
  named: "named",
  not_named: "not named",
  not_shown: "nothing shown",
};

/** A cell's dots read out, for a screen reader. */
export function historyWords(history: readonly CheckOutcome[]): string {
  return `Oldest to latest: ${history.map((outcome) => OUTCOME_WORDS[outcome]).join(", ")}`;
}

/** What the answers say for a search where Google showed nothing. */
export function nothingShownLine(
  result: Pick<ScanResult, "surface" | "sampled_at">,
  query: string | undefined,
): string {
  const said = NOTHING_SHOWN_SAID[result.surface] ?? "showed nothing";
  const searched = query ? ` for “${query}”` : "";
  return `Google ${said}${searched} when it was checked on ${formatDate(result.sampled_at)}. This doesn't count against the business.`;
}

export interface CompetitorTally {
  name: string;
  count: number;
}

/** Who was named across the scan, most often first. */
export function tallyCompetitors(results: ScanResult[], limit = 8): CompetitorTally[] {
  const counts = new Map<string, number>();
  for (const result of results) {
    for (const name of result.competitors) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export interface TextPart {
  text: string;
  marked: boolean;
}

/** Splits text around each occurrence of `name`, ignoring case, so the name can be highlighted. */
export function markName(text: string, name: string): TextPart[] {
  if (!name) return [{ text, marked: false }];
  const parts: TextPart[] = [];
  const haystack = text.toLowerCase();
  const needle = name.toLowerCase();
  let from = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), marked: false });
    parts.push({ text: text.slice(at, at + name.length), marked: true });
    from = at + name.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), marked: false });
  return parts;
}
