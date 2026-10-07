import {
  QUERY_KINDS,
  type QueryKind,
  type ScanResult,
  type ScanWindow,
  SURFACES_BY_KIND,
  type Surface,
  type TrackedQuery,
} from "@nearcited/shared";

export interface MatrixCell {
  surface: Surface;
  /** Null when this surface was not checked for this query in the scan. */
  result: ScanResult | null;
  /** How often the business was named over the recent scans. Null before the first one. */
  rate: { checks: number; mentions: number; history: boolean[] } | null;
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

/** One table per query kind: a row per query, a column per surface that kind is checked on. */
export function buildMatrix(
  queries: TrackedQuery[],
  results: ScanResult[],
  window?: ScanWindow,
): MatrixGroup[] {
  const byKey = new Map(
    results.map((result) => [`${result.tracked_query_id}|${result.surface}`, result]),
  );
  const rates = new Map(
    (window?.cells ?? []).map((cell) => [`${cell.tracked_query_id}|${cell.surface}`, cell]),
  );

  return QUERY_KINDS.map((kind) => {
    const surfaces = SURFACES_BY_KIND[kind];
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
