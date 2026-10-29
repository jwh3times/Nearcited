import { FETCHES_SHOWN_DAYS, PAGE_FETCHERS, type PageFetcher, websiteDomain } from "./hosted-pages";
import type { Allowances, Connection, FetchSource, Location } from "./schemas";

/**
 * Fetches of a business's own site (issue #156,
 * `docs/adr/0028-a-sites-fetches-are-read-from-its-cloudflare-zone.md`).
 *
 * An assistant's fetcher reads a page without running its scripts, so the line on the site never
 * sees it. Where the site is served through Cloudflare, its owner gives the product a token that
 * reads the zone's request counts, and the worker reads, once a day, how many requests each known
 * fetcher made for each page of the location's website. What is kept is a count for a day, a
 * location, a fetcher and a page, and nothing else. Anyone can give a fetcher's name, so nothing
 * is worked out from the count.
 */

/** The kind of allowance a plan has when it counts fetches of the business's own site. */
export const FETCHES_ALLOWANCE = "fetches";

/**
 * The most pages a location's fetches are counted under in a day. The fetches of any page past
 * these, the least fetched, are counted together. `record_site_fetches()` holds the same number.
 */
export const MOST_FETCHED_PAGES_A_DAY = 50;
/** How much of a page's path is kept. `record_site_fetches()` holds the same number. */
export const LONGEST_FETCHED_PATH = 200;
/** How many pages the location's page lists for each fetcher. */
export const FETCHED_PAGES_SHOWN = 5;

/** How many requests a fetcher made for a page on a day (UTC), as Cloudflare estimates them. */
export interface FetchCount {
  day: string;
  fetcher: PageFetcher;
  /** From its first slash, without a query. Empty for the pages past the day's bound. */
  path: string;
  count: number;
}

const DAY_MS = 86_400_000;

/** A day (UTC) `days` after another, both as `YYYY-MM-DD`. */
export const addDays = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The day (UTC) an instant falls on. */
export const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/** Whether a Cloudflare zone, named by its domain, holds a host: the domain or under it. */
export const zoneHolds = (zone: string, host: string): boolean => {
  const name = zone.toLowerCase();
  return host === name || host.endsWith(`.${name}`);
};

/**
 * The hosts a location's site is fetched at: its website's host, with and without `www.`. Null
 * where the website on file is not a site's address.
 */
export function fetchedHosts(website: string | null): [string, string] | null {
  const host = websiteDomain(website);
  return host ? [host, `www.${host}`] : null;
}

/**
 * The days (UTC) to read a location's fetches for, oldest first. The first read takes the last
 * `FETCHES_SHOWN_DAYS` finished days; after that, the last finished day and, again, the day before
 * it, since Cloudflare's figures for a day go on arriving for a while after it. Where a read was
 * missed, the days since the last one read are read as well. Never a day the zone no longer keeps:
 * `keptForSeconds` is how far back it answers, which is about a week on Cloudflare's Free and Pro
 * plans.
 */
export function daysToRead(
  readThrough: string | null,
  now: Date,
  keptForSeconds: number | null = null,
): string[] {
  const today = dayOf(now);
  const last = addDays(today, -1);
  let first = readThrough === null ? addDays(today, -FETCHES_SHOWN_DAYS) : addDays(last, -1);
  if (readThrough !== null && readThrough < first) first = readThrough;
  if (first < addDays(today, -FETCHES_SHOWN_DAYS)) first = addDays(today, -FETCHES_SHOWN_DAYS);
  if (keptForSeconds !== null) {
    // The first whole day the zone still keeps.
    const kept = new Date(now.getTime() - keptForSeconds * 1000);
    const keptFrom = kept.getTime() % DAY_MS === 0 ? dayOf(kept) : addDays(dayOf(kept), 1);
    if (first < keptFrom) first = keptFrom;
  }
  const days: string[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) days.push(day);
  return days;
}

/**
 * A day's counts as they are kept: under at most `MOST_FETCHED_PAGES_A_DAY` pages, the most
 * fetched, with the rest counted together under no page. `record_site_fetches()` does the same.
 */
export function boundedFetches(counts: readonly FetchCount[]): FetchCount[] {
  const kept: FetchCount[] = [];
  for (const day of new Set(counts.map((counted) => counted.day))) {
    const that = counts.filter((counted) => counted.day === day && counted.count > 0);
    const byPage = new Map<string, number>();
    for (const counted of that) {
      if (counted.path !== "") {
        byPage.set(counted.path, (byPage.get(counted.path) ?? 0) + counted.count);
      }
    }
    const pages = new Set(
      [...byPage]
        // Ties go to the path first in code point order, as `collate "C"` puts it.
        .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, MOST_FETCHED_PAGES_A_DAY)
        .map(([path]) => path),
    );
    const added = new Map<string, FetchCount>();
    for (const counted of that) {
      const path = pages.has(counted.path) ? counted.path : "";
      const key = `${counted.fetcher}|${path}`;
      const soFar = added.get(key);
      added.set(key, {
        day,
        fetcher: counted.fetcher,
        path,
        count: (soFar?.count ?? 0) + counted.count,
      });
    }
    kept.push(...added.values());
  }
  return kept;
}

/** The pages a sample site is fetched at, and the fetchers that fetch it. */
const SAMPLE_PAGES = ["/", "/services", "/contact", "/about", "/reviews"] as const;
const SAMPLE_FETCHERS: readonly PageFetcher[] = [
  "gptbot",
  "oai-searchbot",
  "chatgpt-user",
  "claudebot",
  "perplexitybot",
  "googlebot",
  "bingbot",
];

/** A number from 0 to 2^32 - 1 that a string always gives, and a similar string seldom does. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Made-up fetches of a location's site for some days, for a test organization and a deployment on
 * sample data. The same location and day always give the same counts, so reading them again
 * changes nothing. Nothing here was fetched by anyone.
 */
export function sampleFetches(locationId: string, days: readonly string[]): FetchCount[] {
  const counts: FetchCount[] = [];
  for (const day of days) {
    for (const fetcher of SAMPLE_FETCHERS) {
      // A crawler reads more, and more often, than an assistant fetching for someone.
      const most = PAGE_FETCHERS[fetcher].group === "search" ? 9 : 4;
      for (const path of SAMPLE_PAGES) {
        const count = (hashOf(`${locationId}|${day}|${fetcher}|${path}`) % (most + 3)) - 2;
        if (count > 0) counts.push({ day, fetcher, path, count });
      }
    }
  }
  return counts;
}

/**
 * Where a location's fetches come from, for its page to say: counted from a zone matched to it, or
 * from one matched to another location, or why there are none.
 */
export function fetchSource({
  location,
  locations,
  connections,
  allowances,
  sampleData,
}: {
  location: Pick<Location, "id" | "website">;
  /** The organization's locations, for the one a zone is matched to. */
  locations: readonly Pick<Location, "id" | "name" | "website">[];
  /** The organization's connections, of every kind and standing. */
  connections: readonly Pick<
    Connection,
    "id" | "kind" | "status" | "choices" | "matches" | "last_synced_at"
  >[];
  allowances: Allowances;
  sampleData: boolean;
}): FetchSource {
  if (allowances[FETCHES_ALLOWANCE] === undefined) return { state: "not_on_plan" };
  if (sampleData) return { state: "sample" };
  const host = websiteDomain(location.website);
  if (!host) return { state: "no_website" };
  const zones = connections.filter(
    (connection) =>
      connection.kind === "cloudflare" &&
      (connection.status === "working" || connection.status === "broken"),
  );
  for (const connection of zones) {
    const own = connection.matches.find((match) => match.location_id === location.id);
    if (own) {
      return {
        state: "counted",
        zone: own.external_label,
        connection_id: connection.id,
        broken: connection.status === "broken",
      };
    }
  }
  for (const connection of zones) {
    const other = connection.matches.find(
      (match) => match.location_id !== location.id && zoneHolds(match.external_label, host),
    );
    if (other) {
      const holder = locations.find((candidate) => candidate.id === other.location_id);
      return {
        state: "elsewhere",
        zone: other.external_label,
        location_id: other.location_id,
        location_name: holder?.name ?? "another location",
        // Only the matched location's own website is read, so another one in the same zone is
        // counted nowhere.
        same_website: websiteDomain(holder?.website ?? null) === host,
      };
    }
  }
  if (zones.length === 0) return { state: "not_connected" };
  if (zones.every((connection) => connection.status === "broken")) return { state: "broken" };
  // The worker matches a zone at its next read: one never read yet, or a website changed since.
  const waiting = zones.some(
    (connection) =>
      connection.last_synced_at === null ||
      connection.choices.some((choice) => zoneHolds(choice.label, host)),
  );
  return { state: waiting ? "waiting" : "not_in_zone" };
}
