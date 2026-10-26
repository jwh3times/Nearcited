import {
  CITED_PAGE_REQUESTS,
  type CitedPageNotRead,
  type CitedPageSnapshot,
  type CitedPageTarget,
  robotsAllows,
  type SiteSnapshot,
} from "@nearcited/shared";

/**
 * Fetches pages as NearcitedBot: a business's home page and robots.txt for the on-page check, and
 * the pages answers cited for the cited-page check. Like a provider, this only fetches:
 * `analyzeSite` and `analyzeCitedPage` in the shared package decide what a page means.
 *
 * The address comes from a user, so it is treated as hostile: web addresses on the default ports
 * only, no IP addresses or internal names, every redirect checked the same way, and the body cut
 * off at a fixed size. It never throws; a page that cannot be fetched is a snapshot without HTML.
 * The page addresses the cited-page check reads come from answers, and are treated the same way.
 */

/** Names the crawler and the page that explains it to a site's operator. */
export const SITE_USER_AGENT = "NearcitedBot/1.0 (+https://nearcited.com/bot)";
const MAX_REDIRECTS = 4;
const MAX_BYTES = 600_000;
const TIMEOUT_MS = 8_000;

type Fetch = typeof fetch;

/** The address to fetch, or null when it is not one this Worker should call. */
export function safeSiteUrl(address: string, base?: URL): URL | null {
  let url: URL;
  try {
    url = base
      ? new URL(address, base)
      : new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `https://${address}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.port || url.username || url.password) return null;
  // No IP addresses (an IPv6 host has a colon or brackets), and only names with a public suffix.
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.includes("[")) return null;
  if (!host.includes(".") || /\.(local|localhost|internal|lan|home|test|invalid)$/.test(host)) {
    return null;
  }
  url.hash = "";
  return url;
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value.subarray(0, MAX_BYTES - size));
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(Math.min(size, MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** A status that often clears by itself: the server was busy, or faulted. */
const passing = (status: number) => status === 429 || status >= 500;

/** Thrown when a reader has made all the requests it may. */
class OutOfRequests extends Error {}

/** What a host's robots.txt came to: rules, none, or unreadable, which shuts everything. */
type Robots = { kind: "rules"; text: string } | { kind: "none" } | { kind: "unreadable" };

/** A page asked for and what came of it. */
type PageRead =
  | { kind: "answered"; url: URL; response: Response; robots: string | null }
  | {
      kind: "not_read";
      url: URL;
      reason: CitedPageNotRead;
      status: number | null;
      /** The host's robots.txt, when it was what shut NearcitedBot out. */
      robots: string | null;
    };

/** Where a walk of redirects ended: an answer, a hop it was stopped at, or one it would not take. */
type Walk =
  | { kind: "answered"; url: URL; response: Response }
  | { kind: "stopped"; url: URL; reason: CitedPageNotRead }
  | { kind: "refused"; url: URL; status: number }
  | { kind: "too_long"; url: URL };

interface ReaderOptions {
  fetch: Fetch;
  /** How many requests it may make in all, robots.txt and redirects included. */
  budget: number;
  /** Whether the site is the business's own, where only rules naming NearcitedBot count. */
  ownSite: boolean;
}

/**
 * Reads pages as NearcitedBot: robots.txt before anything else on each host, read once and obeyed
 * (docs/adr/0027), every redirect checked before it is called, and no more requests than its
 * budget. Each request is counted, so one reader shared by several pages keeps them all in it.
 */
class Reader {
  private left: number;
  private readonly robots = new Map<string, Promise<Robots>>();

  constructor(private readonly options: ReaderOptions) {
    this.left = options.budget;
  }

  private request(url: URL, accept: string): Promise<Response> {
    if (this.left <= 0) throw new OutOfRequests();
    this.left -= 1;
    return this.options.fetch(url.href, {
      redirect: "manual",
      headers: { "User-Agent": SITE_USER_AGENT, Accept: accept },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  /**
   * Follows redirects by hand so each hop is checked before it is called: it must be an address
   * this Worker would call, and `check`, when given, may stop the walk there with a reason.
   */
  private async follow(
    start: URL,
    accept: string,
    check?: (url: URL) => Promise<CitedPageNotRead | null>,
  ): Promise<Walk> {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const reason = await check?.(url);
      if (reason) return { kind: "stopped", url, reason };
      const response = await this.request(url, accept);
      const location = response.headers.get("Location");
      if (response.status < 300 || response.status >= 400 || !location) {
        return { kind: "answered", url, response };
      }
      await response.body?.cancel().catch(() => {});
      const next = safeSiteUrl(location, url);
      if (!next) return { kind: "refused", url, status: response.status };
      url = next;
    }
    return { kind: "too_long", url };
  }

  /**
   * A host's robots.txt, as RFC 9309 reads a fetch of it: a success is its rules, a 4xx is none,
   * and a fault, a refusal to answer for now or no answer at all shut everything.
   */
  private rulesOf(url: URL): Promise<Robots> {
    const known = this.robots.get(url.origin);
    if (known) return known;
    const found = (async (): Promise<Robots> => {
      try {
        const answer = await this.follow(new URL("/robots.txt", url), "text/plain,*/*;q=0.5");
        if (answer.kind !== "answered") return { kind: "unreadable" };
        const { status } = answer.response;
        if (status >= 200 && status < 300) {
          return { kind: "rules", text: await readCapped(answer.response) };
        }
        await answer.response.body?.cancel().catch(() => {});
        return status >= 400 && status < 500 && status !== 429
          ? { kind: "none" }
          : { kind: "unreadable" };
      } catch (error) {
        if (error instanceof OutOfRequests) throw error;
        return { kind: "unreadable" };
      }
    })();
    this.robots.set(url.origin, found);
    return found;
  }

  /**
   * A page, with robots.txt asked first at each host it passes through. `onSite`, when given, is
   * what a hop must stay on; a redirect anywhere else is not followed.
   */
  async read(start: URL, onSite?: (url: URL) => boolean): Promise<PageRead> {
    // The robots.txt of the last hop checked, which is the one a page that answered came from.
    let text: string | null = null;
    const walk = await this.follow(start, "text/html,*/*;q=0.5", async (url) => {
      if (onSite && !onSite(url)) return "left_site";
      const robots = await this.rulesOf(url);
      if (robots.kind === "unreadable") return "robots_unreadable";
      text = robots.kind === "rules" ? robots.text : null;
      const path = url.pathname + url.search;
      if (text && !robotsAllows(text, path, { ownSite: this.options.ownSite })) return "shut_out";
      return null;
    });
    const { url } = walk;
    switch (walk.kind) {
      case "answered":
        return { kind: "answered", url, response: walk.response, robots: text };
      case "stopped": {
        const robots = walk.reason === "shut_out" ? text : null;
        return { kind: "not_read", url, reason: walk.reason, status: null, robots };
      }
      case "refused":
        // A redirect to an address it would refuse leads off the site as surely as one elsewhere.
        return { kind: "not_read", url, reason: "left_site", status: walk.status, robots: null };
      case "too_long":
        return { kind: "not_read", url, reason: "unreachable", status: null, robots: null };
    }
  }
}

const isHtml = (response: Response) => /html/i.test(response.headers.get("Content-Type") ?? "");

/** The requests the on-page check may make: the page twice and robots.txt, with redirects. */
const SITE_REQUESTS = 15;

/**
 * The home page, asked for a second time when the first try got no answer or a passing fault. One
 * miss from one place is weak evidence about a site, and the check is shown to its owner.
 */
async function readHome(reader: Reader, start: URL): Promise<PageRead> {
  try {
    const first = await reader.read(start);
    if (first.kind === "not_read" || !passing(first.response.status)) return first;
    await first.response.body?.cancel().catch(() => {});
  } catch (error) {
    if (error instanceof OutOfRequests) throw error;
  }
  return reader.read(start);
}

/**
 * The business's home page and its robots.txt, for the on-page check. `ownSite` is whether the
 * site's owner asked to have it checked: then only rules that name NearcitedBot stop it. An audit
 * reads a site nobody who runs it asked about, so it reads it as anyone else's.
 */
export async function fetchSite(
  website: string,
  fetchImpl: Fetch = fetch,
  { ownSite = true }: { ownSite?: boolean } = {},
): Promise<SiteSnapshot> {
  const start = safeSiteUrl(website);
  const nothing = (url: string, status: number | null = null): SiteSnapshot => ({
    url,
    status,
    html: null,
    robots_txt: null,
    noindex_header: false,
  });
  if (!start) return nothing(website);

  try {
    const reader = new Reader({ fetch: fetchImpl, budget: SITE_REQUESTS, ownSite });
    const page = await readHome(reader, start);
    if (page.kind === "not_read") {
      if (page.reason === "shut_out" || page.reason === "robots_unreadable") {
        return { ...nothing(page.url.href), robots_txt: page.robots, not_read: page.reason };
      }
      return nothing(page.url.href, page.status);
    }
    const { url, response } = page;
    if (response.status !== 200 || !isHtml(response)) {
      await response.body?.cancel().catch(() => {});
      return nothing(url.href, response.status);
    }
    return {
      url: url.href,
      status: response.status,
      html: await readCapped(response),
      robots_txt: page.robots,
      noindex_header: /\bnoindex\b/i.test(response.headers.get("X-Robots-Tag") ?? ""),
    };
  } catch {
    return nothing(start.href);
  }
}

/** Whether an address is on a cited site: its host, or a subdomain of it. */
function onSiteOf(host: string) {
  return (url: URL) => {
    const name = url.hostname.toLowerCase().replace(/^www\./, "");
    return name === host || name.endsWith(`.${host}`);
  };
}

/**
 * The pages the cited-page check reads, one after another, within one budget of requests for them
 * all. Nothing a page does fails the others or the scan: each comes back read, or with the reason
 * it was not. A page is asked for once; a miss is reported as one.
 */
export async function fetchCitedPages(
  targets: readonly CitedPageTarget[],
  fetchImpl: Fetch = fetch,
): Promise<CitedPageSnapshot[]> {
  const reader = new Reader({ fetch: fetchImpl, budget: CITED_PAGE_REQUESTS, ownSite: false });
  const snapshots: CitedPageSnapshot[] = [];
  for (const { host, url } of targets) {
    const notRead = (
      reason: CitedPageNotRead,
      at = url,
      status: number | null = null,
    ): CitedPageSnapshot => ({ host, url: at, status, html: null, not_read: reason });
    const start = safeSiteUrl(url);
    if (!start) {
      snapshots.push(notRead("unreachable"));
      continue;
    }
    try {
      const page = await reader.read(start, onSiteOf(host));
      if (page.kind === "not_read") {
        snapshots.push(notRead(page.reason, page.url.href, page.status));
        continue;
      }
      const { response } = page;
      const at = page.url.href;
      if (response.status !== 200 || !isHtml(response)) {
        await response.body?.cancel().catch(() => {});
        const reason = response.status === 200 ? "not_html" : "unreachable";
        snapshots.push(notRead(reason, at, response.status));
        continue;
      }
      snapshots.push({
        host,
        url: at,
        status: 200,
        html: await readCapped(response),
        not_read: null,
      });
    } catch (error) {
      snapshots.push(notRead(error instanceof OutOfRequests ? "over_budget" : "unreachable"));
    }
  }
  return snapshots;
}
