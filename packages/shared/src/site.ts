import { containsTokenRun, normalizeName } from "./analysis";
import type { SiteCheck, SiteCheckId } from "./schemas";

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
}

export interface SiteBusiness {
  name: string;
  city: string | null;
}

/**
 * The crawlers the assistants send when they search the web to answer a question. A site that
 * shuts these out cannot be read for an answer. The crawlers that gather training data are a
 * separate choice and are not checked.
 */
export const ANSWER_CRAWLERS = [
  "OAI-SearchBot",
  "ChatGPT-User",
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
    fix: "The page has no schema.org block giving the business's name and address. Adding one (LocalBusiness, or the closest type) states the details in a form machines read without guessing.",
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

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? whole;
    const point =
      code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : " ";
  });
}

/** The words a reader would see with scripts off: tags, scripts and styles removed. */
export function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function hasNoindexMeta(html: string): boolean {
  return (html.match(/<meta\b[^>]*>/gi) ?? []).some((tag) => {
    const name = attribute(tag, "name")?.toLowerCase();
    return (
      (name === "robots" || name === "googlebot") &&
      /\bnoindex\b/i.test(attribute(tag, "content") ?? "")
    );
  });
}

/** Whether any JSON-LD block on the page gives something a name and an address. */
function hasBusinessData(html: string): boolean {
  const blocks = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi,
  );
  const describesBusiness = (node: unknown, depth = 0): boolean => {
    if (depth > 6 || node === null || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some((item) => describesBusiness(item, depth + 1));
    const record = node as Record<string, unknown>;
    if (typeof record.name === "string" && record.name.trim() && record.address) return true;
    return Object.values(record).some((value) => describesBusiness(value, depth + 1));
  };
  for (const [, body] of blocks) {
    try {
      if (describesBusiness(JSON.parse(body ?? ""))) return true;
    } catch {
      // A block that is not valid JSON tells a crawler nothing, so it counts as absent.
    }
  }
  return false;
}

/**
 * Which of the given crawlers a robots.txt shuts out of the whole site. A crawler follows the
 * group that names it, and the `*` group only when none does.
 */
export function blockedCrawlers(
  robotsTxt: string,
  crawlers: readonly string[] = ANSWER_CRAWLERS,
): string[] {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      // Agent lines in a row share one group; an agent line after a rule starts the next.
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === "allow" || field === "disallow") && current) {
      current.rules.push({ allow: field === "allow", path: value });
    }
  }

  const shutOut = (agent: string) => {
    const rules = groups.filter((group) => group.agents.includes(agent)).flatMap((g) => g.rules);
    const root = (rule: { path: string }) => rule.path === "/" || rule.path === "/*";
    return (
      rules.some((rule) => !rule.allow && root(rule)) && !rules.some((r) => r.allow && root(r))
    );
  };
  return crawlers.filter((crawler) => {
    const named = groups.some((group) => group.agents.includes(crawler.toLowerCase()));
    return shutOut(named ? crawler.toLowerCase() : "*");
  });
}

/** Decides what a fetched page means for one business. */
export function analyzeSite(snapshot: SiteSnapshot, business: SiteBusiness): SiteCheck {
  const base = { url: snapshot.url, status: snapshot.status, blocked_crawlers: [], words: 0 };
  if (snapshot.html === null) {
    // Nothing else can be said about a page that did not load.
    return { ...base, checks: [{ id: "reachable", passed: false }] };
  }

  const text = visibleText(snapshot.html);
  const title = decodeEntities(
    /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(snapshot.html)?.[1] ?? "",
  );
  const words = text ? text.split(" ").length : 0;
  const searchable = normalizeName(`${title} ${text}`);
  const blocked = snapshot.robots_txt ? blockedCrawlers(snapshot.robots_txt) : [];
  const says = (value: string | null) =>
    !!value && containsTokenRun(searchable, normalizeName(value));

  const checks: SiteCheck["checks"] = [
    { id: "reachable", passed: true },
    { id: "crawlers_allowed", passed: blocked.length === 0 },
    { id: "indexable", passed: !snapshot.noindex_header && !hasNoindexMeta(snapshot.html) },
    { id: "text_content", passed: words >= MIN_PAGE_WORDS },
    { id: "names_business", passed: says(business.name) },
    // Without a city on file there is nothing to look for, so the check is left out.
    ...(business.city ? [{ id: "names_city" as const, passed: says(business.city) }] : []),
    { id: "structured_data", passed: hasBusinessData(snapshot.html) },
  ];
  return { ...base, blocked_crawlers: blocked, words, checks };
}
