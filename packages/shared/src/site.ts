import { containsTokenRun, namesMatch, normalizeName } from "./analysis";
import { type RobotsRule, robotsGroups, rulesFor } from "./robots";
import type { RobotsNotRead, SiteCheck, SiteCheckId } from "./schemas";

/**
 * The on-page check: can an assistant read the business's own website, and does the page say
 * who and where the business is?
 *
 * The fetch happens in the Worker and returns a `SiteSnapshot`. Everything that decides what the
 * snapshot means is here, so it can be tested without a network. Each check is something a later
 * fetch can check again, which is what lets a recommendation made from one clear itself.
 */

/** What was fetched, before anything is decided about it. */
export interface SiteSnapshot {
  /** The address that answered, after redirects. */
  url: string;
  /** The HTTP status, or null when nothing answered. */
  status: number | null;
  /** The page, when it answered 200 with HTML. */
  html: string | null;
  /** The site's robots.txt, or null when it has none. */
  robots_txt: string | null;
  /** True when the response carried an `X-Robots-Tag` with `noindex`. */
  noindex_header: boolean;
  /** Set when robots.txt kept NearcitedBot from the page, which was then not asked for. */
  not_read?: RobotsNotRead;
}

export interface SiteBusiness {
  name: string;
  city: string | null;
}

/**
 * The crawlers the assistants send when they search the web to answer a question. A site that
 * shuts these out cannot be read for an answer. The crawlers that gather training data are a
 * separate choice and are not checked.
 *
 * Each name is the robots.txt token its vendor publishes, checked on 2026-10-08:
 *
 * - OpenAI, https://developers.openai.com/api/docs/bots: `OAI-SearchBot`.
 * - Anthropic, https://support.claude.com/en/articles/8896518: `Claude-SearchBot`, `Claude-User`.
 * - Perplexity, https://docs.perplexity.ai/guides/bots: `PerplexityBot`.
 *
 * Left out on purpose: `ChatGPT-User` and `Perplexity-User`, the fetchers that act for one user.
 * Their vendors say robots.txt may not apply to them, so a rule naming one does not show the site
 * is shut out. Google has no crawler of its own for AI answers; `Google-Extended` is a control
 * token that does not affect Search, and AI Overviews read what `Googlebot` indexes.
 */
export const ANSWER_CRAWLERS = [
  "OAI-SearchBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
] as const;

/** A page with fewer words than this, before any script runs, has nothing to quote. */
export const MIN_PAGE_WORDS = 50;

interface CheckText {
  /** The check, as a statement that is true when it passes. */
  label: string;
  /** The recommendation's title when it fails. */
  title: string;
  /** What to do about it. */
  fix: string;
}

export const SITE_CHECKS: Record<SiteCheckId, CheckText> = {
  reachable: {
    label: "The website answers",
    title: "Your website could not be read",
    fix: "The home page did not come back as a web page. An assistant that cannot load it cannot use it. Check that the address on file is right and the site is up.",
  },
  crawlers_allowed: {
    label: "Assistants are allowed to read it",
    title: "Your website tells assistants to stay out",
    fix: "The site's robots.txt blocks the crawlers assistants use to look things up, so they will not read it when answering. Remove those rules, or allow the crawlers by name.",
  },
  indexable: {
    label: "The page may be listed in search results",
    title: "Your home page asks not to be indexed",
    fix: "The page carries a noindex instruction. Search engines leave such pages out, and assistants find pages through search. Remove it from the home page.",
  },
  text_content: {
    label: "The page has text without running scripts",
    title: "Your home page has almost no text until scripts run",
    fix: "The crawlers assistants use mostly do not run scripts, so they see this page as nearly empty. Serve the main text in the page itself.",
  },
  names_business: {
    label: "The page states the business name",
    title: "Your home page does not state the business name",
    fix: "The name on file does not appear in the page's text. State it in plain text, spelled the way customers and listings spell it, not only in a logo image.",
  },
  names_city: {
    label: "The page states the city",
    title: "Your home page does not say where the business is",
    fix: "The city on file does not appear in the page's text. Say where the business is and where it serves, in plain text.",
  },
  structured_data: {
    label: "The page describes the business in structured data",
    title: "Your home page has no structured business details",
    fix: "The page has no schema.org block that names the business as it is on file and gives an address. One that does states the details in a form machines read without guessing.",
  },
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? whole;
    const point =
      code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : " ";
  });
}

/** How many headings are kept, and how long one may be, for telling a page's businesses apart. */
const MAX_HEADINGS = 200;
const MAX_HEADING_LENGTH = 300;

/** Elements whose content is not page text. Their bodies are skipped, or kept aside. */
const RAW_ELEMENTS = new Set(["script", "style", "template", "svg", "title"]);

export interface ParsedPage {
  /** The words a reader would see with scripts off. */
  text: string;
  /** As written in the page, entities and all. */
  title: string;
  /** Each short heading's words, with its level: 1 for `<h1>`. */
  headings: { level: number; text: string }[];
  /** Each `<meta>` tag, whole. */
  metas: string[];
  /** The body of each JSON-LD script block. */
  jsonLd: string[];
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

/**
 * Reads the page in one pass, by position. The page comes from a site nobody here controls, so
 * nothing in this function backtracks: a page built to be slow to parse costs only its length.
 */
export function parsePage(html: string): ParsedPage {
  const lower = html.toLowerCase();
  const text: string[] = [];
  const page: ParsedPage = { text: "", title: "", headings: [], metas: [], jsonLd: [] };

  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open === -1) {
      text.push(html.slice(at));
      break;
    }
    text.push(html.slice(at, open), " ");

    if (lower.startsWith("<!--", open)) {
      const end = lower.indexOf("-->", open + 4);
      at = end === -1 ? html.length : end + 3;
      continue;
    }
    const close = html.indexOf(">", open);
    if (close === -1) break;
    const tag = html.slice(open, close + 1);
    at = close + 1;

    let nameEnd = open + 1;
    while (nameEnd < close && /[a-z0-9]/.test(lower.charAt(nameEnd))) nameEnd++;
    const name = lower.slice(open + 1, nameEnd);

    if (name === "meta") page.metas.push(tag);
    if (/^h[1-6]$/.test(name) && page.headings.length < MAX_HEADINGS) {
      // Only a short heading that closes: one left open would be read to the next one, again
      // and again. Its words are read here and again as page text, so it costs twice its length.
      const end = lower.indexOf(`</${name}`, at);
      if (end !== -1 && end - at <= MAX_HEADING_LENGTH) {
        const words = decodeEntities(html.slice(at, end).replace(/<[^>]*>/g, " "))
          .replace(/\s+/g, " ")
          .trim();
        if (words) page.headings.push({ level: Number(name[1]), text: words });
      }
    }
    if (!RAW_ELEMENTS.has(name)) continue;

    const end = lower.indexOf(`</${name}`, at);
    const body = html.slice(at, end === -1 ? html.length : end);
    if (name === "title") page.title = body;
    if (
      name === "script" &&
      attribute(tag, "type")?.trim().toLowerCase() === "application/ld+json"
    ) {
      page.jsonLd.push(body);
    }
    const endClose = end === -1 ? -1 : html.indexOf(">", end);
    at = endClose === -1 ? html.length : endClose + 1;
  }

  page.text = decodeEntities(text.join("")).replace(/\s+/g, " ").trim();
  return page;
}

/** The words a reader would see with scripts off: tags, scripts and styles removed. */
export function visibleText(html: string): string {
  return parsePage(html).text;
}

function hasNoindexMeta(metas: readonly string[]): boolean {
  return metas.some((tag) => {
    const name = attribute(tag, "name")?.toLowerCase();
    return (
      (name === "robots" || name === "googlebot") &&
      (attribute(tag, "content") ?? "").toLowerCase().includes("noindex")
    );
  });
}

/**
 * Whether any JSON-LD block on the page names this business and gives it an address. The name
 * is matched the way answers are matched, so a block for somebody else on the page, such as the
 * agency that built the site, does not count. What the block says beyond that is not compared
 * with what is on file.
 */
function hasBusinessData(blocks: readonly string[], name: string): boolean {
  return namedNodes(blocks).some((node) => namesMatch(node.name, name) && !!node.address);
}

/** A JSON-LD node that gives a name, such as a business, a person or a place. */
export type NamedNode = Record<string, unknown> & { name: string };

/**
 * Every node with a name in a page's JSON-LD blocks, nested ones included. A block that is not
 * valid JSON tells a crawler nothing, so it counts as absent.
 */
export function namedNodes(blocks: readonly string[]): NamedNode[] {
  const found: NamedNode[] = [];
  const walk = (node: unknown, depth: number) => {
    if (depth > 6 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.name === "string") found.push(record as NamedNode);
    for (const value of Object.values(record)) walk(value, depth + 1);
  };
  for (const body of blocks) {
    try {
      walk(JSON.parse(body), 0);
    } catch {}
  }
  return found;
}

/**
 * Which of the given crawlers a robots.txt shuts out of the whole site. A crawler follows the
 * group that names it, and the `*` group only when none does.
 */
export function blockedCrawlers(
  robotsTxt: string,
  crawlers: readonly string[] = ANSWER_CRAWLERS,
): string[] {
  const groups = robotsGroups(robotsTxt);
  const root = (rule: RobotsRule) => rule.path === "/" || rule.path === "/*";
  return crawlers.filter((crawler) => {
    const rules = rulesFor(groups, crawler) ?? rulesFor(groups, "*") ?? [];
    return (
      rules.some((rule) => !rule.allow && root(rule)) && !rules.some((r) => r.allow && root(r))
    );
  });
}

const REACHABLE_FAILED = { id: "reachable", passed: false } as const;

/**
 * Whether a page that did not load is the address's own doing: it answered that there is no such
 * page, or answered with something that is not a web page.
 */
function leadsNowhere(status: number | null): boolean {
  return status === 404 || status === 410 || status === 200;
}

/** Decides what a fetched page means for one business. */
export function analyzeSite(snapshot: SiteSnapshot, business: SiteBusiness): SiteCheck {
  const base = { url: snapshot.url, status: snapshot.status, blocked_crawlers: [], words: 0 };
  if (snapshot.not_read === "shut_out") {
    // The page was not read, so only what robots.txt itself says can be reported.
    const blocked = snapshot.robots_txt ? blockedCrawlers(snapshot.robots_txt) : [];
    return {
      ...base,
      blocked_crawlers: blocked,
      checks: [{ id: "crawlers_allowed", passed: blocked.length === 0 }],
      not_read: "shut_out",
    };
  }
  if (snapshot.not_read === "robots_unreadable") {
    return { ...base, checks: [], not_read: "robots_unreadable" };
  }
  if (snapshot.html === null) {
    // Nothing else can be said about a page that did not load, and only some failures say even
    // that much. One fetch that got no answer, was turned away or hit a server fault does not show
    // the site is down, still less that an assistant cannot read it, so it makes no claim.
    return { ...base, checks: leadsNowhere(snapshot.status) ? [REACHABLE_FAILED] : [] };
  }

  const page = parsePage(snapshot.html);
  const text = page.text;
  const title = decodeEntities(page.title);
  const words = text ? text.split(" ").length : 0;
  const searchable = normalizeName(`${title} ${text}`);
  const blocked = snapshot.robots_txt ? blockedCrawlers(snapshot.robots_txt) : [];
  const says = (value: string | null) =>
    !!value && containsTokenRun(searchable, normalizeName(value));

  const checks: SiteCheck["checks"] = [
    { id: "reachable", passed: true },
    { id: "crawlers_allowed", passed: blocked.length === 0 },
    { id: "indexable", passed: !snapshot.noindex_header && !hasNoindexMeta(page.metas) },
    { id: "text_content", passed: words >= MIN_PAGE_WORDS },
    { id: "names_business", passed: says(business.name) },
    // Without a city on file there is nothing to look for, so the check is left out.
    ...(business.city ? [{ id: "names_city" as const, passed: says(business.city) }] : []),
    { id: "structured_data", passed: hasBusinessData(page.jsonLd, business.name) },
  ];
  return { ...base, blocked_crawlers: blocked, words, checks };
}
