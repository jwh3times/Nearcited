/**
 * Turns what a surface returned into a finding about one business.
 *
 * Providers only fetch. Deciding whether the business was named, where it ranked, and who was
 * named instead happens here, so every surface is judged by the same rules and the rules can be
 * tested without network access.
 */

export interface RankedEntry {
  name: string;
  website?: string | null;
  place_id?: string | null;
}

export type Observation =
  /** A written answer from an assistant or an AI Overview. */
  | {
      kind: "answer";
      text: string;
      /** Businesses the answer named, in the order it named them. */
      businesses: string[];
      cited_urls: string[];
    }
  /** An ordered result list such as the map pack or organic results. */
  | { kind: "ranking"; entries: RankedEntry[] };

export interface BusinessIdentity {
  name: string;
  website: string | null;
  google_place_id: string | null;
}

export interface Finding {
  mentioned: boolean;
  /** 1-based rank among the businesses the surface listed, when the surface gives an order. */
  position: number | null;
  competitors: string[];
  cited_urls: string[];
  answer_excerpt: string | null;
}

const LEGAL_SUFFIXES = new Set(["llc", "inc", "ltd", "corp", "co", "pllc", "llp"]);
const MAX_COMPETITORS = 10;
const MAX_CITED_URLS = 20;
const EXCERPT_LENGTH = 280;

export function normalizeName(name: string): string {
  const tokens = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1] ?? "")) {
    tokens.pop();
  }
  return tokens.join(" ");
}

/** Whether `needle` appears in `haystack` as whole words in a row. Both already normalised. */
export function containsTokenRun(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/**
 * Whether two names refer to the same business. Exact after normalising, or one name is a whole
 * run of words inside the other ("Joe's Pizza" inside "Joe's Pizza & Pasta - Raleigh").
 * Single short words never match by containment, so "Art" does not match "Art of Shaving".
 */
export function namesMatch(a: string, b: string): boolean {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  const distinctive = shorter.includes(" ") || shorter.length >= 6;
  return distinctive && containsTokenRun(longer, shorter);
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export function hostsMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function unique(values: string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function excerptAround(text: string, name: string): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const at = clean.toLowerCase().indexOf(name.toLowerCase());
  if (at === -1 || clean.length <= EXCERPT_LENGTH) {
    return clean.length <= EXCERPT_LENGTH ? clean : `${clean.slice(0, EXCERPT_LENGTH - 1)}…`;
  }
  const start = Math.max(0, at - Math.floor((EXCERPT_LENGTH - name.length) / 2));
  const end = Math.min(clean.length, start + EXCERPT_LENGTH);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}

export function analyzeObservation(observation: Observation, business: BusinessIdentity): Finding {
  const businessHost = hostOf(business.website);

  if (observation.kind === "ranking") {
    const index = observation.entries.findIndex(
      (entry) =>
        (business.google_place_id !== null && entry.place_id === business.google_place_id) ||
        hostsMatch(hostOf(entry.website), businessHost) ||
        namesMatch(entry.name, business.name),
    );
    return {
      mentioned: index !== -1,
      position: index === -1 ? null : index + 1,
      competitors: unique(
        observation.entries.filter((_, i) => i !== index).map((entry) => entry.name),
        MAX_COMPETITORS,
      ),
      cited_urls: [],
      answer_excerpt: null,
    };
  }

  const listedIndex = observation.businesses.findIndex((name) => namesMatch(name, business.name));
  const namedInText = containsTokenRun(
    normalizeName(observation.text),
    normalizeName(business.name),
  );
  const cited = observation.cited_urls.some((url) => hostsMatch(hostOf(url), businessHost));

  return {
    mentioned: listedIndex !== -1 || namedInText || cited,
    position: listedIndex === -1 ? null : listedIndex + 1,
    competitors: unique(
      observation.businesses.filter((name) => !namesMatch(name, business.name)),
      MAX_COMPETITORS,
    ),
    cited_urls: unique(observation.cited_urls, MAX_CITED_URLS),
    answer_excerpt: excerptAround(observation.text, business.name),
  };
}
