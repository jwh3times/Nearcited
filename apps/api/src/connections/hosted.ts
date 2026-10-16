import { type AnswerRecord, INDEXNOW_KEY, PAGES_DOMAIN, recordTarget } from "@nearcited/shared";

/**
 * An answer subdomain from outside: what its name points at in public DNS, and Cloudflare's
 * interface for the custom hostnames hosted pages are served on (issue #141,
 * `docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md`).
 */

export interface HostedDeps {
  /** How the outside is reached. The tests put a made-up DNS and Cloudflare here. */
  fetch?: typeof fetch;
}

/** Cloudflare's resolver, asked over HTTPS, which answers the same for anyone. */
const RESOLVER = "https://cloudflare-dns.com/dns-query";

/** What the resolver answers. Only the parts read here. */
interface Resolved {
  Status: number;
  Answer?: { type: number; data: string }[];
}

/** The answers of one type for a name: a CNAME's target, or an A record's address. */
async function resolve(
  name: string,
  type: "CNAME" | "A",
  { fetch: get = fetch }: HostedDeps,
): Promise<string[]> {
  const url = new URL(RESOLVER);
  url.searchParams.set("name", name);
  url.searchParams.set("type", type);
  const response = await get(url, { headers: { Accept: "application/dns-json" } });
  if (!response.ok) throw new Error(`The resolver answered ${response.status}.`);
  const resolved = (await response.json()) as Resolved;
  const wanted = type === "CNAME" ? 5 : 1;
  return (resolved.Answer ?? [])
    .filter((answer) => answer.type === wanted)
    .map((answer) => answer.data.toLowerCase().replace(/\.$/, ""));
}

/**
 * Cloudflare's IPv4 ranges, which a proxied record answers with in place of where it points.
 * From cloudflare.com/ips-v4, read 2026-10-16.
 */
const CLOUDFLARE_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

/** An IPv4 address as a number, or null where it is not one. */
function ipv4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

/** Whether an address is one of Cloudflare's own. */
export function atCloudflare(address: string): boolean {
  const value = ipv4(address);
  if (value === null) return false;
  return CLOUDFLARE_RANGES.some((range) => {
    const [base = "", bits = "32"] = range.split("/");
    const size = 2 ** (32 - Number(bits));
    const start = ipv4(base) ?? -1;
    return value >= start && value < start + size;
  });
}

/**
 * What a name points at now: `ours` where its CNAME is the connection's own target, `proxied`
 * where it answers with Cloudflare's addresses and no CNAME (a proxied record, which hides where it
 * points), `elsewhere` for anything else it answers, and `missing` for nothing. `target` is null
 * when the name has no target yet, and then anything it answers is somewhere else.
 */
export async function lookUp(
  hostname: string,
  target: string | null,
  deps: HostedDeps = {},
): Promise<AnswerRecord> {
  const [cname] = await resolve(hostname, "CNAME", deps);
  if (cname !== undefined) {
    return target !== null && cname === recordTarget(target) ? "ours" : "elsewhere";
  }
  const addresses = await resolve(hostname, "A", deps);
  if (addresses.length === 0) return "missing";
  return addresses.every(atCloudflare) ? "proxied" : "elsewhere";
}

/**
 * Whether a name points somewhere already, so that setting it up would break what uses it. A name
 * still pointing at one of Nearcited's own targets, from an attempt that was let go, does not
 * count: its owner only has to change the target.
 */
export async function inUse(hostname: string, deps: HostedDeps = {}): Promise<boolean> {
  const [cname] = await resolve(hostname, "CNAME", deps);
  if (cname !== undefined) return !cname.endsWith(`.${PAGES_DOMAIN}`);
  return (await resolve(hostname, "A", deps)).length > 0;
}

/** A connection's own target: twelve letters and digits, drawn at random. */
export function newTarget(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  // 252 is the largest multiple of 36 under 256, so every character is equally likely.
  const out: string[] = [];
  while (out.length < 12) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 252 && out.length < 12) out.push(alphabet[byte % 36] ?? "a");
    }
  }
  return out.join("");
}

/** Where hosted pages are registered: Cloudflare's zone, and a token for its custom hostnames. */
export interface Cloudflare {
  token: string;
  zone: string;
}

/** What Cloudflare's interface answers. Only the parts read here. */
interface Answered {
  success: boolean;
  errors?: { code: number; message?: string }[];
  result?: { id: string; status?: string; ssl?: { status?: string } } | { id: string }[];
}

/** One call to Cloudflare's custom hostnames on the zone. */
async function customHostnames(
  { token, zone }: Cloudflare,
  method: string,
  path: string,
  { fetch: get = fetch }: HostedDeps,
  body?: unknown,
): Promise<{ status: number; answered: Answered }> {
  const response = await get(
    `https://api.cloudflare.com/client/v4/zones/${zone}/custom_hostnames${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const answered = (await response.json().catch(() => ({ success: false }))) as Answered;
  return { status: response.status, answered };
}

/** Cloudflare's code for a custom hostname that is registered already. */
const DUPLICATE = 1406;

/**
 * Registers a name as a custom hostname to be served, with a certificate Cloudflare validates over
 * HTTP once the name points at it. Returns what Cloudflare calls it. A name registered already,
 * by a try that did not hear back, is found and used.
 */
export async function registerHostname(
  hostname: string,
  cloudflare: Cloudflare,
  deps: HostedDeps = {},
): Promise<string> {
  const made = await customHostnames(cloudflare, "POST", "", deps, {
    hostname,
    ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
  });
  const result = made.answered.result;
  if (made.answered.success && result && !Array.isArray(result)) return result.id;
  if (made.answered.errors?.some((error) => error.code === DUPLICATE)) {
    const found = await customHostnames(
      cloudflare,
      "GET",
      `?hostname=${encodeURIComponent(hostname)}`,
      deps,
    );
    const [kept] = Array.isArray(found.answered.result) ? found.answered.result : [];
    if (kept) return kept.id;
  }
  throw new Error(`Cloudflare did not register ${hostname} (${made.status}).`);
}

/** Whether Cloudflare serves a registered name, with its certificate issued. */
export async function hostnameLive(
  id: string,
  cloudflare: Cloudflare,
  deps: HostedDeps = {},
): Promise<boolean> {
  const read = await customHostnames(cloudflare, "GET", `/${encodeURIComponent(id)}`, deps);
  const result = read.answered.result;
  if (!read.answered.success || !result || Array.isArray(result)) {
    throw new Error(`Cloudflare could not say how ${id} stands (${read.status}).`);
  }
  return result.status === "active" && result.ssl?.status === "active";
}

/** Takes a registered name off Cloudflare. One that is gone already counts as taken off. */
export async function unregisterHostname(
  id: string,
  cloudflare: Cloudflare,
  deps: HostedDeps = {},
): Promise<void> {
  const gone = await customHostnames(cloudflare, "DELETE", `/${encodeURIComponent(id)}`, deps);
  if (!gone.answered.success && gone.status !== 404) {
    throw new Error(`Cloudflare did not take ${id} off (${gone.status}).`);
  }
}

/** What may follow a host in an address: where the host ends. */
const HOST_ENDS = new Set(["/", '"', "'", "?", "#", ":", " ", ">", "<", "\n", "\t", ""]);

/**
 * Whether a page's HTML links to a host: an address on it, with or without its scheme, and not
 * on a longer host that only starts the same.
 */
export function linksTo(html: string, hostname: string): boolean {
  const page = html.toLowerCase();
  const wanted = `//${hostname.toLowerCase()}`;
  for (let at = page.indexOf(wanted); at !== -1; at = page.indexOf(wanted, at + 1)) {
    if (HOST_ENDS.has(page.charAt(at + wanted.length))) return true;
  }
  return false;
}

/**
 * Tells IndexNow (indexnow.org), and through it Bing, that a page on an answer subdomain was
 * published or taken back, so it is read again without waiting for a crawl. The subdomain serves
 * the key, which is how the notice is known to come from whoever serves it. A notice that does
 * not get through is only logged: the page is up or gone all the same, and the sitemap says so.
 */
export async function tellIndexNow(
  hostname: string,
  address: string,
  { fetch: post = fetch }: HostedDeps = {},
): Promise<boolean> {
  try {
    const response = await post("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: hostname,
        key: INDEXNOW_KEY,
        keyLocation: `https://${hostname}/${INDEXNOW_KEY}.txt`,
        urlList: [address],
      }),
    });
    if (!response.ok) console.warn(`IndexNow answered ${response.status} for ${address}`);
    return response.ok;
  } catch (error) {
    console.warn(`IndexNow could not be told of ${address}`, error);
    return false;
  }
}
