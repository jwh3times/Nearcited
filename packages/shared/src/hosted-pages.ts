/**
 * Hosted pages: pages the product serves on a subdomain of a business's own domain, for sites
 * built on something that offers no way in (issue #141,
 * `docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md`).
 *
 * The owner points one name at the product with one DNS record, once: the **answer subdomain**.
 * Its target is the connection's own name under `PAGES_DOMAIN`, so the record says which
 * connection it is for, and nobody else's account can claim the subdomain by registering it first.
 */

/** The kind of allowance a plan has when it includes hosted pages. */
export const HOSTED_PAGES_ALLOWANCE = "hosted_pages";

/** The Cloudflare zone the app and every answer subdomain are served on. */
export const ZONE_DOMAIN = "nearcited.com";

/** Where an answer subdomain's record points: a name of the connection's own under this. */
export const PAGES_DOMAIN = `pages.${ZONE_DOMAIN}`;

/** The subdomain's name an owner is offered first. */
export const SUGGESTED_LABEL = "answers";

/** How long the worker waits for an owner's record before it stops and frees the name. */
export const RECORD_WAIT_DAYS = 30;

/**
 * The key that shows IndexNow (indexnow.org) a notice of a new or removed hosted page is ours. It
 * is public by design: every answer subdomain serves it at `/<key>.txt`, which is how a search
 * engine checks the notice came from whoever runs the host.
 */
export const INDEXNOW_KEY = "c0a8136c47991b6c15f6dfe1029dfc14";

/** One word of a host name: letters, digits and hyphens, not starting or ending with a hyphen. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A subdomain's name as an owner typed it, tidied, or null where it is not one word of a name. */
export function subdomainLabel(typed: string): string | null {
  const label = typed.trim().toLowerCase();
  return LABEL.test(label) ? label : null;
}

/**
 * The host a website's address is at, lower case and without `www.`: the domain an answer
 * subdomain goes under. Null where the address is not a site's.
 */
export function websiteDomain(website: string | null): string | null {
  if (!website) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(website) ? website : `https://${website}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

/**
 * The answer subdomain a name makes under a location's website, such as `answers.joesplumbing.com`
 * for `answers` and `https://www.joesplumbing.com`. Null where either is not usable. The database
 * works out the same in `create_answer_subdomain()`.
 */
export function answerHostname(label: string, website: string | null): string | null {
  const word = subdomainLabel(label);
  const domain = websiteDomain(website);
  if (!word || !domain) return null;
  const host = `${word}.${domain}`;
  return host.length <= 253 ? host : null;
}

/**
 * Suffixes of two labels under which a domain someone registers has three, such as `co.uk`. Only
 * the common ones: a domain under another is taken to be its last two labels.
 */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "co.nz",
  "org.nz",
  "com.au",
  "net.au",
  "org.au",
  "co.za",
  "com.br",
  "com.mx",
  "co.jp",
  "co.in",
  "com.sg",
  "com.hk",
  "co.ie",
]);

/** The part of a host its owner registered: `joespizza.com` for `shop.joespizza.com`. */
export function registeredDomain(host: string): string {
  const labels = host.toLowerCase().split(".");
  const kept = TWO_LABEL_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-kept).join(".");
}

/**
 * The site builders whose own address a business's site can be at, such as
 * `joespizza.wixsite.com`. A site there has no domain of its owner's to add a record to.
 */
export const BUILDER_DOMAINS: readonly string[] = [
  "wixsite.com",
  "wix.com",
  "squarespace.com",
  "godaddysites.com",
  "weebly.com",
  "wordpress.com",
  "webflow.io",
  "square.site",
  "business.site",
  "sites.google.com",
  "blogspot.com",
  "carrd.co",
  "myshopify.com",
  "framer.website",
  "jimdosite.com",
  "strikingly.com",
];

/** Whether a website is at a site builder's own address rather than on a domain of its owner's. */
export function onBuilderDomain(website: string | null): boolean {
  const domain = websiteDomain(website);
  return (
    domain !== null &&
    BUILDER_DOMAINS.some((builder) => domain === builder || domain.endsWith(`.${builder}`))
  );
}

/**
 * Whether an answer subdomain still sits under the domain of a location's website, as it must for
 * new pages to go there. A website that moved within the same domain still matches.
 */
export const underWebsite = (hostname: string, website: string | null): boolean => {
  const domain = websiteDomain(website);
  return domain !== null && hostname.endsWith(`.${registeredDomain(domain)}`);
};

/** The name a connection's record points at, from the target the database keeps for it. */
export const recordTarget = (target: string): string => `${target}.${PAGES_DOMAIN}`;

/**
 * Where each common registrar says how to add a DNS record, for an owner who has never done it.
 * Read 2026-10-16.
 */
export const REGISTRAR_HELP: readonly { name: string; url: string }[] = [
  {
    name: "GoDaddy",
    url: "https://www.godaddy.com/help/add-a-cname-record-19236",
  },
  {
    name: "Namecheap",
    url: "https://www.namecheap.com/support/knowledgebase/article.aspx/9646/2237/how-to-create-a-cname-record-for-your-domain/",
  },
  {
    name: "Squarespace Domains",
    url: "https://support.squarespace.com/hc/en-us/articles/360002101888-Adding-custom-DNS-records-to-your-Squarespace-managed-domain",
  },
  {
    name: "Cloudflare",
    url: "https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/",
  },
  {
    name: "IONOS",
    url: "https://www.ionos.com/help/domains/configuring-cname-records-for-subdomains/configuring-a-cname-record-for-a-subdomain/",
  },
  {
    name: "Wix",
    url: "https://support.wix.com/en/article/adding-or-updating-cname-records-in-your-wix-account",
  },
  {
    name: "Network Solutions",
    url: "https://www.networksolutions.com/help/article/manage-dns-adns-records",
  },
  { name: "Porkbun", url: "https://kb.porkbun.com/article/54-how-to-add-dns-records-on-porkbun" },
];

/** The two groups a hosted page's fetches are counted in, shown apart. */
export type FetcherGroup = "assistant" | "search";

/**
 * The fetchers a hosted page's reads are counted for: the assistants' own, which fetch for
 * training, for a search index or for a person asking, and the search engines' crawlers, whose
 * indexes Google's AI answers and Copilot draw on. Each is known by a word in its user agent, as
 * its maker documents it (read 2026-10-16). Anyone can send that word, so the count can be padded
 * and nothing is worked out from it. The database names the same keys in
 * `hosted_page_fetches.fetcher`: add one in both.
 */
export const PAGE_FETCHERS = {
  gptbot: { name: "GPTBot", maker: "OpenAI", group: "assistant", token: "gptbot" },
  "oai-searchbot": {
    name: "OAI-SearchBot",
    maker: "OpenAI",
    group: "assistant",
    token: "oai-searchbot",
  },
  "chatgpt-user": {
    name: "ChatGPT-User",
    maker: "OpenAI",
    group: "assistant",
    token: "chatgpt-user",
  },
  claudebot: { name: "ClaudeBot", maker: "Anthropic", group: "assistant", token: "claudebot" },
  "claude-searchbot": {
    name: "Claude-SearchBot",
    maker: "Anthropic",
    group: "assistant",
    token: "claude-searchbot",
  },
  "claude-user": {
    name: "Claude-User",
    maker: "Anthropic",
    group: "assistant",
    token: "claude-user",
  },
  perplexitybot: {
    name: "PerplexityBot",
    maker: "Perplexity",
    group: "assistant",
    token: "perplexitybot",
  },
  "perplexity-user": {
    name: "Perplexity-User",
    maker: "Perplexity",
    group: "assistant",
    token: "perplexity-user",
  },
  googlebot: { name: "Googlebot", maker: "Google", group: "search", token: "googlebot" },
  bingbot: { name: "Bingbot", maker: "Microsoft", group: "search", token: "bingbot" },
} as const satisfies Record<
  string,
  { name: string; maker: string; group: FetcherGroup; token: string }
>;

export type PageFetcher = keyof typeof PAGE_FETCHERS;
export const PAGE_FETCHER_KEYS = Object.keys(PAGE_FETCHERS) as PageFetcher[];

/** Which counted fetcher a user agent says it is, or null for anything else. */
export function fetcherOf(userAgent: string | null): PageFetcher | null {
  if (!userAgent) return null;
  const said = userAgent.toLowerCase();
  // No fetcher's word is inside another's, so the first that is there is the one.
  return PAGE_FETCHER_KEYS.find((key) => said.includes(PAGE_FETCHERS[key].token)) ?? null;
}

/** How many days a paused answer subdomain's pages are served as they are. */
export const SERVED_AFTER_PAUSE_DAYS = 30;
/** How many days after that its pages send visitors on, before the subdomain is removed. */
export const REDIRECTED_FOR_DAYS = 90;

/**
 * The most fetches counted for one page, by one fetcher, in a day. Anyone can claim to be a
 * fetcher, so the count stops here rather than grow without end. The database holds the same
 * number in `record_page_fetch()`.
 */
export const MOST_FETCHES_A_DAY = 1000;

/** How many days of fetches a page task shows. */
export const FETCHES_SHOWN_DAYS = 30;
