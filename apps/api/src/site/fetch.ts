import type { SiteSnapshot } from "@nearcited/shared";

/**
 * Fetches a business's home page and robots.txt for the on-page check. Like a provider, this only
 * fetches: `analyzeSite` in the shared package decides what the page means.
 *
 * The address comes from a user, so it is treated as hostile: web addresses on the default ports
 * only, no IP addresses or internal names, every redirect checked the same way, and the body cut
 * off at a fixed size. It never throws; a page that cannot be fetched is a snapshot without HTML.
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

/** Follows redirects by hand so each hop is checked before it is called. */
async function get(start: URL, fetchImpl: Fetch): Promise<{ url: URL; response: Response } | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(url.href, {
      redirect: "manual",
      headers: { "User-Agent": SITE_USER_AGENT, Accept: "text/html,*/*;q=0.5" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const location = response.headers.get("Location");
    if (response.status < 300 || response.status >= 400 || !location) return { url, response };
    await response.body?.cancel().catch(() => {});
    const next = safeSiteUrl(location, url);
    if (!next) return null;
    url = next;
  }
  return null;
}

/** A status that often clears by itself: the server was busy, or faulted. */
const passing = (status: number) => status === 429 || status >= 500;

/**
 * The home page, asked for a second time when the first try got no answer or a passing fault. One
 * miss from one place is weak evidence about a site, and the check is shown to its owner.
 */
async function getPage(start: URL, fetchImpl: Fetch) {
  try {
    const first = await get(start, fetchImpl);
    if (!first || !passing(first.response.status)) return first;
    await first.response.body?.cancel().catch(() => {});
  } catch {}
  return get(start, fetchImpl);
}

export async function fetchSite(website: string, fetchImpl: Fetch = fetch): Promise<SiteSnapshot> {
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
    const page = await getPage(start, fetchImpl);
    if (!page) return nothing(start.href);
    const { url, response } = page;
    const isHtml = /html/i.test(response.headers.get("Content-Type") ?? "");
    if (response.status !== 200 || !isHtml) {
      await response.body?.cancel().catch(() => {});
      return nothing(url.href, response.status);
    }
    const html = await readCapped(response);

    // A missing or unreadable robots.txt allows everything, which is what crawlers assume too.
    let robots: string | null = null;
    try {
      const found = await get(new URL("/robots.txt", url), fetchImpl);
      if (found?.response.status === 200) robots = await readCapped(found.response);
      else await found?.response.body?.cancel().catch(() => {});
    } catch {}

    return {
      url: url.href,
      status: response.status,
      html,
      robots_txt: robots,
      noindex_header: /\bnoindex\b/i.test(response.headers.get("X-Robots-Tag") ?? ""),
    };
  } catch {
    return nothing(start.href);
  }
}
