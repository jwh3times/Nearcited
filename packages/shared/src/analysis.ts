import {
  type CountryCode,
  findPhoneNumbersInText,
  isSupportedCountry,
} from "libphonenumber-js/min";
import { isGoogle } from "./google";
import type { Surface } from "./schemas";

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
  /** Where the business is, which is how a phone number written without its country is read. */
  country_code?: string | null;
}

export interface Finding {
  /**
   * False when Google showed nothing on the surface for the search: no AI Overview, no AI Mode
   * answer, no map or organic results. It is then not named either, and counts nowhere.
   */
  shown: boolean;
  mentioned: boolean;
  /** 1-based rank among the businesses the surface listed, when the surface gives an order. */
  position: number | null;
  competitors: string[];
  cited_urls: string[];
  answer_excerpt: string | null;
  /** The phone numbers a written answer gave for the business, in international form. */
  phones: string[];
}

const LEGAL_SUFFIXES = new Set(["llc", "inc", "ltd", "corp", "co", "pllc", "llp"]);
const MAX_COMPETITORS = 10;
const MAX_CITED_URLS = 20;
const MAX_PHONES = 5;
const EXCERPT_LENGTH = 280;

/** The words of a text folded to plain letters and digits, as `normalizeName` reads them. */
function foldedWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export function normalizeName(name: string): string {
  return withoutEndings(foldedWords(name), LEGAL_SUFFIXES).join(" ");
}

/** The legal endings again, with those written out, dropped only when telling competitors apart. */
const COMPETITOR_SUFFIXES = new Set([
  ...LEGAL_SUFFIXES,
  "company",
  "incorporated",
  "limited",
  "corporation",
]);

/** The words less any of `endings` at the end, keeping the last word when that is all there is. */
function withoutEndings(tokens: string[], endings: ReadonlySet<string>): string[] {
  while (tokens.length > 1 && endings.has(tokens[tokens.length - 1] ?? "")) {
    tokens.pop();
  }
  return tokens;
}

/** A name's words with its dots dropped ("L.L.C." is "LLC"), less any legal ending, written out or not. */
function keyWords(name: string): string[] {
  return withoutEndings(normalizeName(name.replaceAll(".", "")).split(" "), COMPETITOR_SUFFIXES);
}

/**
 * What two spellings of one business share: `keyWords` run together. "North Star Realty" and
 * "Northstar Realty Co" are one business. It groups the businesses named instead, and two names
 * with one key match (`namesMatch`); an alert's subject still goes by `normalizeName`.
 */
export function competitorKey(name: string): string {
  return keyWords(name).join("");
}

/** Whether `needle` appears in `haystack` as whole words in a row. Both already normalised. */
export function containsTokenRun(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/** A word of a text, folded, and where the piece of text it came from begins and ends. */
interface PlacedWord {
  word: string;
  at: number;
  end: number;
}

function placedWords(text: string): PlacedWord[] {
  const words: PlacedWord[] = [];
  for (const piece of text.matchAll(/[\p{L}\p{M}\p{N}'’`]+|&/gu)) {
    const at = piece.index;
    const end = at + piece[0].length;
    for (const word of foldedWords(piece[0])) words.push({ word, at, end });
  }
  return words;
}

/**
 * Every run of whole words that, written together, is `key`: "Northstar" and "North Star" both
 * for "northstar", and never the "star" inside "Northstar". As the words of `words` they begin
 * and end at. It reads the words once and looks for the key once from each place it was found,
 * so its time grows with the text, not with the text times itself.
 */
function runsWritingKey(words: readonly string[], key: string): [number, number][] {
  if (!key) return [];
  // Where in the words written together each word begins, and the end of the last.
  const startOf = new Map<number, number>();
  let joined = "";
  words.forEach((word, index) => {
    startOf.set(joined.length, index);
    joined += word;
  });
  startOf.set(joined.length, words.length);
  const runs: [number, number][] = [];
  for (let found = joined.indexOf(key); found !== -1; found = joined.indexOf(key, found + 1)) {
    const first = startOf.get(found);
    const after = startOf.get(found + key.length);
    if (first !== undefined && after !== undefined) runs.push([first, after - 1]);
  }
  return runs;
}

/**
 * Every place a text writes the name as whole words, however it spaces them, cases or punctuates
 * them, and with or without its legal ending: "Northstar Realty" and "North Star Realty, LLC"
 * for "North Star Realty", but not "Star Realty" inside "Northstar Realty".
 */
export function placesNamed(text: string, name: string): { at: number; length: number }[] {
  const words = placedWords(text);
  const runs = runsWritingKey(
    words.map(({ word }) => word),
    competitorKey(name),
  );
  return runs.map(([first, last]) => {
    const at = words[first]?.at ?? 0;
    return { at, length: (words[last]?.end ?? at) - at };
  });
}

/** Whether a text names the business, as `placesNamed` finds it. */
export function textNames(text: string, name: string): boolean {
  return placesNamed(text, name).length > 0;
}

/** Whether a name is distinctive enough to be looked for inside a longer one. */
const distinctive = (words: readonly string[]) => words.length > 1 || (words[0]?.length ?? 0) >= 6;

/**
 * Whether two names refer to the same business. Exact after normalising, the same key
 * (`competitorKey`: "Northstar Realty" and "North Star Realty Co"), or one name is a whole run of
 * words inside the other, however either is spaced ("Joe's Pizza" inside "Joe's Pizza & Pasta -
 * Raleigh", "North Star Realty" inside "Northstar Realty Group"). Single short words never match
 * by containment, so "Art" does not match "Art of Shaving".
 */
export function namesMatch(a: string, b: string): boolean {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return false;
  if (left === right || competitorKey(a) === competitorKey(b)) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (distinctive(shorter.split(" ")) && containsTokenRun(longer, shorter)) return true;
  const inside = (inner: string, outer: string) =>
    distinctive(keyWords(inner)) &&
    runsWritingKey(foldedWords(outer), competitorKey(inner)).length > 0;
  return inside(a, b) || inside(b, a);
}

/** The names that are not a spelling of the business `name` (`namesMatch`). */
export function othersThan(name: string, names: readonly string[]): string[] {
  return names.filter((other) => !namesMatch(other, name));
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
  if (clean.length <= EXCERPT_LENGTH) return clean;
  const [named] = placesNamed(clean, name);
  if (!named) return `${clean.slice(0, EXCERPT_LENGTH - 1)}…`;
  const start = Math.max(0, named.at - Math.floor((EXCERPT_LENGTH - named.length) / 2));
  const end = Math.min(clean.length, start + EXCERPT_LENGTH);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}

/** A place a name is written in a text, and whether that name is the business's. */
export interface NameMention {
  at: number;
  length: number;
  ours: boolean;
}

/**
 * Every place one of the names is written in a text, and the business's own however it is
 * written (`placesNamed`), in order. Where two begin at the same place the longer one is what was
 * written there, so it comes last.
 */
export function nameMentions(
  text: string,
  named: readonly string[],
  business: Pick<BusinessIdentity, "name">,
): NameMention[] {
  const lower = text.toLowerCase();
  const mentions: NameMention[] = placesNamed(text, business.name).map((place) => ({
    ...place,
    ours: true,
  }));
  // The other names are looked for as the answer or the page wrote them, which is how they came.
  for (const name of new Set(named)) {
    const needle = name.trim().toLowerCase();
    if (!needle) continue;
    const ours = namesMatch(name, business.name);
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
      mentions.push({ at, length: needle.length, ours });
    }
  }
  return mentions.sort((a, b) => a.at - b.at || a.length - b.length);
}

/**
 * The phone numbers an answer gives for the business, in international form.
 *
 * An answer goes through the businesses it names one after another, each with its details after
 * its name, so a number is taken to be the business's when the name written nearest before it is
 * the business's. A number written before any name is nobody's. This reads where a number
 * stands and not what the sentence says, so it can be wrong about a number that follows the
 * business's name and belongs to something the answer did not name: whoever uses it should want
 * to see the same number more than once. `within`, when given, is how many characters after the
 * name a number may stand and still be the business's.
 */
export function phonesGivenFor(
  text: string,
  named: readonly string[],
  business: Pick<BusinessIdentity, "name" | "country_code">,
  { within = Number.POSITIVE_INFINITY }: { within?: number } = {},
): string[] {
  const country = business.country_code ?? "US";
  if (!isSupportedCountry(country)) return [];
  const found = findPhoneNumbersInText(text, country as CountryCode);
  if (found.length === 0) return [];

  const mentions = nameMentions(text, named, business);
  const given = found.filter((number) => {
    const before = mentions.filter((mention) => mention.at <= number.startsAt);
    const nearest = before[before.length - 1];
    return nearest?.ours === true && number.startsAt - nearest.at <= within;
  });
  return unique(
    given.map((number) => number.number.number),
    MAX_PHONES,
  );
}

/**
 * Whether the surface showed anything for the search. Only Google can show nothing: an
 * assistant always answers, and an answer that names nobody is still one that left the business
 * out.
 */
function wasShown(observation: Observation, surface: Surface): boolean {
  if (!isGoogle(surface)) return true;
  if (observation.kind === "ranking") return observation.entries.length > 0;
  return (
    observation.text.trim() !== "" ||
    observation.businesses.length > 0 ||
    observation.cited_urls.length > 0
  );
}

/** What a result holds when nothing was shown: not named, and nothing else. */
const EMPTY_FINDING: Finding = {
  shown: false,
  mentioned: false,
  position: null,
  competitors: [],
  cited_urls: [],
  answer_excerpt: null,
  phones: [],
};

export function analyzeObservation(
  observation: Observation,
  business: BusinessIdentity,
  /** The surface it came from, which decides whether it can have shown nothing. */
  surface: Surface,
): Finding {
  const businessHost = hostOf(business.website);
  if (!wasShown(observation, surface)) return { ...EMPTY_FINDING };

  if (observation.kind === "ranking") {
    const index = observation.entries.findIndex(
      (entry) =>
        (business.google_place_id !== null && entry.place_id === business.google_place_id) ||
        hostsMatch(hostOf(entry.website), businessHost) ||
        namesMatch(entry.name, business.name),
    );
    return {
      shown: true,
      mentioned: index !== -1,
      position: index === -1 ? null : index + 1,
      competitors: unique(
        othersThan(
          business.name,
          observation.entries.filter((_, i) => i !== index).map((entry) => entry.name),
        ),
        MAX_COMPETITORS,
      ),
      cited_urls: [],
      answer_excerpt: null,
      phones: [],
    };
  }

  const listedIndex = observation.businesses.findIndex((name) => namesMatch(name, business.name));
  const namedInText = textNames(observation.text, business.name);
  const cited = observation.cited_urls.some((url) => hostsMatch(hostOf(url), businessHost));

  return {
    shown: true,
    mentioned: listedIndex !== -1 || namedInText || cited,
    position: listedIndex === -1 ? null : listedIndex + 1,
    competitors: unique(othersThan(business.name, observation.businesses), MAX_COMPETITORS),
    cited_urls: unique(observation.cited_urls, MAX_CITED_URLS),
    answer_excerpt: excerptAround(observation.text, business.name),
    phones: phonesGivenFor(observation.text, observation.businesses, business),
  };
}
