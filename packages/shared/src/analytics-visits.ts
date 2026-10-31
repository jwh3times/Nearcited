import { addDays, dayOf, hashOf } from "./fetches";
import { websiteDomain } from "./hosted-pages";
import {
  type Allowances,
  type AnalyticsSource,
  type Connection,
  type Location,
  VISIT_ASSISTANTS,
  type VisitAssistant,
} from "./schemas";
import { ASSISTANT_REFERRERS, assistantOf, VISITS_ALLOWANCE, VISITS_SHOWN_DAYS } from "./visits";

/**
 * Visits from assistants as a business's Google Analytics property counts them (issue #144,
 * `docs/adr/0029-analytics-counts-are-kept-apart-from-the-lines.md`).
 *
 * An owner or admin signs in with Google once, and the worker reads, once a day, how many sessions
 * each assistant sent to each page. What is kept is a count for a day, a location, an assistant
 * and a page. It is kept apart from what the line reported and never added to it, and nothing is
 * worked out from it.
 */

/** Where Google sends its owner back: a page of the web app, never the API. */
export const GOOGLE_RETURN_PATH = "/google/return";

/** How many finished days are always read again, since Google revises its recent figures. */
const DAYS_READ_AGAIN = 3;

/** How many sessions from an assistant landed on a page on a day. */
export interface AnalyticsVisitCount {
  day: string;
  assistant: VisitAssistant;
  /** From its first slash, without a query. Empty for the pages past the day's bound. */
  path: string;
  count: number;
}

/**
 * The assistant a session came from, by the source Google reports for it, or null for any other.
 * The source is the host the visitor came from or the tag on the address, and only one of them,
 * so it is tried as each. The same list as the line's: `ASSISTANT_REFERRERS`.
 */
export function assistantOfSource(source: string): VisitAssistant | null {
  return (
    assistantOf({ referrer: source, tag: null }) ?? assistantOf({ referrer: null, tag: source })
  );
}

/**
 * Every source a report asks Google for, so that nothing is read about a session that did not come
 * from an assistant. `assistantOfSource` still decides what each row is.
 */
export const ANALYTICS_REPORT_SOURCES: readonly string[] = [
  ...new Set(
    VISIT_ASSISTANTS.flatMap((assistant) => [
      ...ASSISTANT_REFERRERS[assistant].hosts,
      ...ASSISTANT_REFERRERS[assistant].tags,
    ]),
  ),
];

/**
 * The days to read a location's sessions for, oldest first. The first read takes the last
 * `VISITS_SHOWN_DAYS` finished days. After that, the days since the last one read, and always the
 * last three finished days again. Never further back than the days shown.
 */
export function analyticsDaysToRead(readThrough: string | null, now: Date): string[] {
  const today = dayOf(now);
  const last = addDays(today, -1);
  const oldest = addDays(today, -VISITS_SHOWN_DAYS);
  let first = oldest;
  if (readThrough !== null) {
    const next = addDays(readThrough, 1);
    first = addDays(last, -(DAYS_READ_AGAIN - 1));
    if (next < first) first = next;
    if (first < oldest) first = oldest;
  }
  const days: string[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) days.push(day);
  return days;
}

/** The pages a sample site's sessions land on. */
const SAMPLE_PAGES = ["/", "/services", "/contact"] as const;

/**
 * Made-up sessions from assistants for some days, for a test organization and a deployment on
 * sample data. The same location and day always give the same counts, so reading them again
 * changes nothing. Nobody visited anything.
 */
export function sampleAnalyticsVisits(
  locationId: string,
  days: readonly string[],
): AnalyticsVisitCount[] {
  const counts: AnalyticsVisitCount[] = [];
  for (const day of days) {
    for (const assistant of VISIT_ASSISTANTS) {
      for (const path of SAMPLE_PAGES) {
        const count = (hashOf(`analytics|${locationId}|${day}|${assistant}|${path}`) % 6) - 3;
        if (count > 0) counts.push({ day, assistant, path, count });
      }
    }
  }
  return counts;
}

/**
 * Where a location's sessions from assistants come from, for its page to say: counted from a
 * property matched to it, or from one matched to another location with the same website, or why
 * there are none.
 */
export function analyticsSource({
  location,
  locations,
  connections,
  allowances,
  sampleData,
}: {
  location: Pick<Location, "id" | "website">;
  /** The organization's locations, for the one a property is matched to. */
  locations: readonly Pick<Location, "id" | "name" | "website">[];
  /** The organization's connections, of every kind and standing. */
  connections: readonly Pick<
    Connection,
    "id" | "kind" | "status" | "choices" | "matches" | "last_synced_at"
  >[];
  allowances: Allowances;
  sampleData: boolean;
}): AnalyticsSource {
  if (allowances[VISITS_ALLOWANCE] === undefined) return { state: "not_on_plan" };
  if (sampleData) return { state: "sample" };
  const signedIn = connections.filter(
    (connection) =>
      connection.kind === "google_analytics" &&
      (connection.status === "working" || connection.status === "broken"),
  );
  if (signedIn.length === 0) return { state: "not_connected" };
  const host = websiteDomain(location.website);
  if (!host) return { state: "no_website" };
  for (const connection of signedIn) {
    const own = connection.matches.find((match) => match.location_id === location.id);
    if (own) {
      return {
        state: "counted",
        property: own.external_label,
        connection_id: connection.id,
        broken: connection.status === "broken",
      };
    }
  }
  for (const connection of signedIn) {
    for (const match of connection.matches) {
      const holder = locations.find((candidate) => candidate.id === match.location_id);
      if (holder && websiteDomain(holder.website) === host) {
        return {
          state: "elsewhere",
          property: match.external_label,
          location_id: holder.id,
          location_name: holder.name,
        };
      }
    }
  }
  if (signedIn.every((connection) => connection.status === "broken")) return { state: "broken" };
  return {
    state: signedIn.some((connection) => connection.last_synced_at === null)
      ? "waiting"
      : "not_matched",
  };
}
