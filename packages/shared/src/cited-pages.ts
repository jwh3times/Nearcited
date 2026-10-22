import {
  containsTokenRun,
  nameMentions,
  namesMatch,
  normalizeName,
  phonesGivenFor,
} from "./analysis";
import { formatPhone, normalizePhone } from "./inputs";
import type { CitedPage, CitedPageNotRead, CitedPhone, Location, SourceSummary } from "./schemas";
import { decodeEntities, type NamedNode, namedNodes, parsePage } from "./site";
import { sourceKind } from "./source-kinds";
import { sourceOfRule } from "./tasks";

/**
 * The cited-page check: what the page an assistant cited for a directory task shows for the
 * business, compared with the location's details (docs/adr/0027).
 *
 * The Worker fetches the page, obeying robots.txt, and returns a `CitedPageSnapshot`. Everything
 * that decides what the page means is here, so it is tested without a network. It is composed by
 * rule: no model reads the page or writes a word of what is said about it.
 */

/** How many directory tasks' pages a scan reads, most cited first. */
export const CITED_PAGES_READ = 3;
/**
 * How many requests a scan's cited-page check makes at most, every robots.txt, redirect and page
 * counted, beside the on-page check's fifteen. Workers cap the requests one invocation makes.
 */
export const CITED_PAGE_REQUESTS = 30;
/**
 * How many characters after the business's name a phone number or an address may stand and
 * still be taken for the business's. A listing gives them under the name; much further down are
 * other businesses ("people also viewed") the page may not name in a way that can be told apart.
 */
const DETAILS_WITHIN = 400;
/** How many of the page's own spellings of the business's name are looked for. */
const MAX_SPELLINGS = 10;

/** A page to read: a directory task's site and the page of it the answers cited most. */
export interface CitedPageTarget {
  host: string;
  url: string;
}

/** What was fetched, before anything is decided about it. */
export interface CitedPageSnapshot {
  host: string;
  /** The address that answered, after redirects, or the one asked for. */
  url: string;
  status: number | null;
  /** The page, when it answered 200 with HTML and was read. */
  html: string | null;
  /** Why it was not read, or null when it was. */
  not_read: CitedPageNotRead | null;
}

/** What the page is compared with: the location's own details. */
export type CitedBusiness = Pick<
  Location,
  "name" | "phone" | "address_line" | "postal_code" | "country_code"
>;

/**
 * The pages to read for a scan: the directory tasks its recommendations leave open and no member
 * dismissed, most cited first as tasks are ordered, each at the page of its site the answers cited
 * most, the one its task links to.
 */
export function citedPagesToRead(
  recommendations: readonly { rule: string }[],
  sources: readonly SourceSummary[],
  dismissed: ReadonlySet<string>,
): CitedPageTarget[] {
  const hosts = new Set(recommendations.map((r) => sourceOfRule(r.rule)));
  return sources
    .filter(
      (source) =>
        hosts.has(source.host) &&
        !dismissed.has(source.host) &&
        sourceKind(source.host) === "directory" &&
        source.urls[0],
    )
    .sort((a, b) => b.answers - a.answers || a.host.localeCompare(b.host))
    .slice(0, CITED_PAGES_READ)
    .map((source) => ({ host: source.host, url: source.urls[0] ?? "" }));
}

/** The business's node in the page's structured details: one that names it and gives a detail. */
function businessNode(nodes: readonly NamedNode[], name: string): NamedNode | undefined {
  return nodes.find(
    (node) => namesMatch(node.name, name) && (node.telephone !== undefined || !!node.address),
  );
}

const stringsIn = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];

/** An address in structured details, as one line: a string, or a `PostalAddress`'s parts. */
function addressText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(addressText).join(" ");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [record.streetAddress, record.postalCode].flatMap(stringsIn).join(" ");
  }
  return "";
}

const escapeForPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The number an address line starts with ("123" of "123 Main St"), or null when it has none. */
function streetNumber(addressLine: string | null): string | null {
  return /^\s*(\d+[a-z]?)\b/i.exec(addressLine ?? "")?.[1] ?? null;
}

/**
 * How the page writes the business's name, where it does not write it as the location does:
 * "Joe’s" for "Joe's", "&" for "and", in any case. Each spelling is a run of the name's words with
 * anything but letters and digits between them, so that a number after it is found to follow it.
 */
function spellingsOf(text: string, name: string): string[] {
  const words = normalizeName(name).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const word = (token: string) =>
    token === "and" ? "(?:and|&)" : [...token].map(escapeForPattern).join("['\u2019`]?");
  const pattern = new RegExp(
    `(?<![a-z0-9])${words.map(word).join("[^a-z0-9&]*")}(?![a-z0-9])`,
    "gi",
  );
  return [...new Set(text.match(pattern) ?? [])].slice(0, MAX_SPELLINGS);
}

/**
 * What of the address on file is looked for: the street number, and the postal code (a US one
 * by its five digits, so a ZIP+4 on either side still matches). Each is a pattern that must be
 * found whole, the street number followed by a street name.
 */
function addressPatterns(business: CitedBusiness): RegExp[] {
  const patterns: RegExp[] = [];
  const number = streetNumber(business.address_line);
  if (number) patterns.push(new RegExp(`(?<![\\w-])${escapeForPattern(number)}\\s+[a-z]`, "i"));
  const postal = business.postal_code?.trim().toUpperCase();
  if (postal) {
    const code = business.country_code === "US" ? postal.slice(0, 5) : postal.replace(/\s+/g, "");
    const spaced = [...code].map(escapeForPattern).join("\\s?");
    patterns.push(new RegExp(`(?<![a-z0-9])${spaced}(?![a-z0-9])`, "i"));
  }
  return patterns;
}

/**
 * The stretches of text that are about the business: from each place its name is written to the
 * next other name, or `DETAILS_WITHIN` characters on, whichever comes first.
 */
function businessStretches(text: string, named: readonly string[], name: string): string[] {
  const mentions = nameMentions(text, named, { name });
  return mentions.flatMap((mention, index) => {
    if (!mention.ours) return [];
    const next = mentions.slice(index + 1).find((later) => !later.ours);
    const end = Math.min(next?.at ?? text.length, mention.at + DETAILS_WITHIN);
    return [text.slice(mention.at, end)];
  });
}

function comparePhone(found: readonly string[], business: CitedBusiness): CitedPhone {
  if (!business.phone) return { found: "none_on_file", shown: found[0] ?? null };
  if (found.includes(business.phone)) return { found: "matches", shown: null };
  return found[0] ? { found: "differs", shown: found[0] } : { found: "not_found", shown: null };
}

/** Decides what a fetched page shows for one business. */
export function analyzeCitedPage(snapshot: CitedPageSnapshot, business: CitedBusiness): CitedPage {
  const base = { host: snapshot.host, url: snapshot.url, status: snapshot.status };
  const nothing = { names_business: null, phone: null, address: null };
  if (snapshot.not_read || snapshot.html === null) {
    return { ...base, not_read: snapshot.not_read ?? "unreachable", ...nothing };
  }

  const page = parsePage(snapshot.html);
  const searchable = normalizeName(`${decodeEntities(page.title)} ${page.text}`);
  if (!containsTokenRun(searchable, normalizeName(business.name))) {
    return { ...base, not_read: null, ...nothing, names_business: false };
  }

  // The names on the page that a list goes through: its structured details', and the headings at
  // the level of the one that names the business. A listing's other headings ("Hours") are not.
  const nodes = namedNodes(page.jsonLd);
  const level = page.headings.find((heading) => namesMatch(heading.text, business.name))?.level;
  const named = [
    ...nodes.map((node) => node.name),
    ...page.headings.filter((heading) => heading.level === level).map((heading) => heading.text),
    // The business's own name as the page writes it, so that what follows it is found to.
    ...spellingsOf(page.text, business.name),
  ];
  const country = business.country_code;
  const node = businessNode(nodes, business.name);

  // Structured details are exact fields, so they are read first.
  const given = stringsIn(node?.telephone).flatMap((typed) => normalizePhone(typed, country) ?? []);
  const phones =
    given.length > 0
      ? given
      : phonesGivenFor(
          page.text,
          named,
          { name: business.name, country_code: country },
          {
            within: DETAILS_WITHIN,
          },
        );

  const patterns = addressPatterns(business);
  const places = [
    addressText(node?.address),
    ...businessStretches(page.text, named, business.name),
  ];
  const address =
    patterns.length === 0
      ? "none_on_file"
      : patterns.every((pattern) => places.some((place) => pattern.test(place)))
        ? "matches"
        : "not_found";

  return {
    ...base,
    not_read: null,
    names_business: true,
    phone: comparePhone(phones, business),
    address,
  };
}

const NOT_READ: Record<CitedPageNotRead, (page: CitedPage) => string> = {
  shut_out: () => "The site's robots.txt asks NearcitedBot not to read this page.",
  robots_unreadable: () => "The site's robots.txt could not be read, so the page was not.",
  unreachable: (page) =>
    page.status === null
      ? "The page did not answer."
      : `The page answered with an error (${page.status}).`,
  not_html: () => "The page is not a web page.",
  left_site: (page) => `The page redirects off ${page.host}, so it was not read.`,
  over_budget: () =>
    "The latest scan used up its requests for reading pages before it reached this one.",
};

const PHONE: Record<CitedPhone["found"], (phone: CitedPhone, business: CitedBusiness) => string> = {
  matches: () => "It shows your phone number.",
  differs: (phone, business) => `It shows ${shown(phone, business)}, not the phone number on file.`,
  not_found: (_, business) => `It shows no phone number for ${business.name}.`,
  none_on_file: (phone, business) =>
    phone.shown
      ? `It shows ${shown(phone, business)}; there is no phone on file.`
      : "No phone on file to compare.",
};

/** The number the page shows, written the way numbers are in the location's country. */
function shown(phone: CitedPhone, business: CitedBusiness): string {
  return phone.shown ? formatPhone(phone.shown, business.country_code) : "";
}

/** What a task says the cited page shows, a sentence at a time. Composed by rule. */
export function citedPageLines(page: CitedPage, business: CitedBusiness): string[] {
  if (page.not_read) return [NOT_READ[page.not_read](page)];
  if (!page.names_business) return [`This page does not name ${business.name}.`];

  const lines = [`The page names ${business.name}.`];
  if (page.phone) lines.push(PHONE[page.phone.found](page.phone, business));
  // Named for what was looked for, which is what the location holds.
  const compared = [
    streetNumber(business.address_line) ? "street number" : null,
    business.postal_code ? "postal code" : null,
  ].filter(Boolean);
  const address = compared.length > 0 ? `your ${compared.join(" and ")}` : "your address";
  if (page.address === "matches") lines.push(`It shows ${address}.`);
  if (page.address === "not_found") lines.push(`It does not show ${address}.`);
  if (page.address === "none_on_file") {
    lines.push(
      business.address_line
        ? "The address on file has no street number or postal code to compare."
        : "No address on file to compare.",
    );
  }
  return lines;
}
