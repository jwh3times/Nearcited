import {
  FETCHES_SHOWN_DAYS,
  type FetcherGroup,
  type LocationFetches,
  PAGE_FETCHERS,
  type PageFetcher,
} from "@nearcited/shared";

/** The cache key of a location's fetches, added up. */
export const fetchesKey = (locationId: string) => ["fetches", locationId] as const;

/** Where a Cloudflare API token is made. */
export const CLOUDFLARE_TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

const known = (fetcher: string): fetcher is PageFetcher => Object.hasOwn(PAGE_FETCHERS, fetcher);

/** One fetcher's reads of a site, as the page lays them out. */
export interface FetcherShown {
  fetcher: PageFetcher;
  name: string;
  maker: string;
  total: number;
  /** By day, the newest first. */
  days: { day: string; count: number }[];
  /** The pages it fetched most, the most first. */
  pages: { path: string; count: number }[];
  /** Its fetches of pages past the fiftieth of their day, counted together. */
  other: number;
}

/** A location's fetches, the assistants' fetchers and the search engines' crawlers apart. */
export type FetchesShown = Record<FetcherGroup, { total: number; fetchers: FetcherShown[] }>;

/**
 * Lays a location's fetches out by fetcher, each in its group, the one with the most first. A
 * fetcher this build does not know is left out: it has no name or group to show it under.
 */
export function fetchesShown(
  fetches: Pick<LocationFetches, "days" | "pages" | "other_pages">,
): FetchesShown {
  const by = new Map<PageFetcher, FetcherShown>();
  const of = (fetcher: PageFetcher): FetcherShown => {
    let shown = by.get(fetcher);
    if (!shown) {
      const { name, maker } = PAGE_FETCHERS[fetcher];
      shown = { fetcher, name, maker, total: 0, days: [], pages: [], other: 0 };
      by.set(fetcher, shown);
    }
    return shown;
  };
  for (const { day, fetcher, count } of fetches.days) {
    if (!known(fetcher)) continue;
    const shown = of(fetcher);
    shown.total += count;
    shown.days.push({ day, count });
  }
  for (const { fetcher, path, count } of fetches.pages) {
    if (known(fetcher)) of(fetcher).pages.push({ path, count });
  }
  for (const { fetcher, count } of fetches.other_pages) {
    if (known(fetcher)) of(fetcher).other += count;
  }
  const group = (which: FetcherGroup) => {
    const fetchers = [...by.values()]
      .filter((shown) => PAGE_FETCHERS[shown.fetcher].group === which)
      .map((shown) => ({
        ...shown,
        days: [...shown.days].sort((a, b) => b.day.localeCompare(a.day)),
        pages: [...shown.pages].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)),
      }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    return { total: fetchers.reduce((sum, shown) => sum + shown.total, 0), fetchers };
  };
  return { assistant: group("assistant"), search: group("search") };
}

/** A count as Cloudflare's estimate is said: "about 1,240". */
export const about = (count: number) => `about ${count.toLocaleString("en-US")}`;

/** What the page says the counts add up to over the days shown. */
export function fetchesLede(shown: FetchesShown): string {
  const { assistant, search } = shown;
  if (assistant.total + search.total === 0) {
    return `No fetcher of an assistant or a search engine read your website in the last ${FETCHES_SHOWN_DAYS} days.`;
  }
  return `In the last ${FETCHES_SHOWN_DAYS} days assistants' fetchers read your website ${about(
    assistant.total,
  )} times, and search engines' crawlers ${about(search.total)} times.`;
}

export const FETCH_WORDS = {
  title: "Fetches of your website",
  about:
    "Assistants and search engines send fetchers to read a site's pages: to learn from, to index, or to answer someone asking right now. A fetcher does not run a page's scripts, so the line that counts visits never sees one. Where your site is served through Cloudflare, Nearcited reads how often each fetcher read each page from your Cloudflare account, once a day.",
  assistants: "Assistants' fetchers",
  search: "Search engines' crawlers",
  notConnected:
    "Connect your Cloudflare account to see how often assistants such as ChatGPT and Claude, and search engines, read your website.",
  connect: "Connect Cloudflare on the Connections page",
  notBehindCloudflare:
    "This works only for a site served through Cloudflare. A site that is not cannot be counted this way.",
  noWebsite:
    "There is no website on file for this location. Fetches are counted only for the website on file, so add it first.",
  notInZone: (host: string) =>
    `None of the zones your Cloudflare token reaches holds ${host}. If the site is not served through Cloudflare, its fetches cannot be counted here.`,
  waiting:
    "Your website is matched to its Cloudflare zone at the next read, within a day of connecting or changing the website.",
  reading: "Reading the last days from Cloudflare now. This page fills in once that is done.",
  broken:
    "The Cloudflare connection is not working, so nothing new is read. What was read is below.",
  elsewhere: (zone: string, name: string) =>
    `${zone} is matched to ${name}, so this website's fetches are counted on that location's page.`,
  elsewhereOtherSite: (zone: string, name: string, host: string) =>
    `${zone} is matched to ${name}, and a zone is counted for one location only, for its own website. So ${host} is not counted.`,
  brokenUnread: "The Cloudflare connection is not working, so nothing is read from it.",
  notOnPlan: "Your plan no longer counts fetches. What was counted while it did is below.",
  sample: "These are sample counts, made up. Nothing was read from Cloudflare.",
  byDay: "By day",
  pages: "Pages fetched most",
  otherPages: "Other pages",
  otherPagesAbout: "Fetches of pages past the fiftieth of their day are counted together.",
  notCounted:
    "Only your website's own address, with or without www, is counted, and only while it is served through Cloudflare: a page served anywhere else is not. Each figure is Cloudflare's estimate, so it is about that many. Anyone can claim to be one of these fetchers, so this shows your site is being read, not who read it, and nothing else here is worked out from it. A day here is a day in UTC.",
} as const;

/** What the Connections page says to someone connecting Cloudflare, in Cloudflare's own words. */
export const CLOUDFLARE_WORDS = {
  title: "Connect Cloudflare",
  about:
    "Where a location's website is served through Cloudflare, Nearcited can count how often assistants' fetchers read it. It needs a token that can only read: it cannot change anything in your Cloudflare account.",
  steps: [
    "In Cloudflare, open My Profile, then API Tokens, and choose Create Token.",
    "Choose Create Custom Token, and give it these two permissions: Zone, Analytics, Read; and Zone, Zone, Read. Nothing else.",
    "Under Zone Resources, include the zone your website is on, or all zones.",
    "Create the token and copy it. Cloudflare shows it only once.",
  ],
  open: "Open Cloudflare's API Tokens page",
  field: "Cloudflare API token",
  button: "Connect",
  matched:
    "Each location is matched to the zone that holds its website. Where several locations share a website, the first made is.",
  remove: (label: string) =>
    `Removing ${label} stops Nearcited reading from it and deletes the token here. Delete the token at Cloudflare too, under My Profile, API Tokens. What was counted stays on each location's page.`,
} as const;
