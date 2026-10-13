import { allowedEachMonth } from "./allowances";
import type {
  Allowances,
  AllowanceUse,
  DraftKind,
  DraftsStanding,
  Location,
  SourceKind,
  Task,
} from "./schemas";

/**
 * Drafts: the wording written for a task (`docs/adr/0016-the-worker-writes-a-draft.md`).
 *
 * A draft is the one thing in the product a model may write. It is written from what a location
 * holds, what its owner said the business does, and the page the task is about, and it states
 * nothing about the business that is not among those. What is here is the part decided by rule:
 * which tasks have a draft, what one is written from, and the check a draft has to pass before
 * anyone is shown it.
 */

/** The kind of allowance a draft is counted against. */
export const DRAFTS_ALLOWANCE = "drafts";

const DRAFT_FOR: Partial<Record<SourceKind, DraftKind>> = {
  // A page somebody wrote: the work is a note to its author.
  editorial: "note",
};

/** The kind of draft a task about a site of this kind has, or null when it has no wording to write. */
export function draftKindFor(kind: SourceKind): DraftKind | null {
  return DRAFT_FOR[kind] ?? null;
}

/** Everything a draft is written from. A draft states nothing about the business that is not here. */
export interface DraftGiven {
  name: string;
  city: string;
  region: string | null;
  category: string | null;
  website: string | null;
  /** What the business does, in its owner's words. */
  what_we_do: string;
  /** The site the task is about. */
  host: string;
  /** The page of that site an answer cited most, when the window still has one. */
  url: string | null;
}

type DraftLocation = Pick<
  Location,
  "name" | "city" | "region" | "primary_category" | "website" | "what_we_do"
>;

/** Why a task has no draft to write as things stand, in a sentence for whoever asked. */
export const NO_DRAFT = {
  no_draft: "This task has no draft to write.",
  what_we_do_missing: "Say what the business does first. A draft is written from that.",
} as const;
export type NoDraft = keyof typeof NO_DRAFT;

/** A draft to write: its kind, and everything it may be written from. */
export interface DraftRequest {
  kind: DraftKind;
  given: DraftGiven;
}

/**
 * The draft to write for `task`, from what the location holds, or why there is none: the task is
 * gone or has no wording to write, or the owner has not said what the business does. Nothing is
 * written without that.
 */
export function draftRequest(
  location: DraftLocation,
  task: Pick<Task, "host" | "url" | "draft_kind"> | undefined,
): DraftRequest | NoDraft {
  if (!task?.draft_kind) return "no_draft";
  if (!location.what_we_do) return "what_we_do_missing";
  return {
    kind: task.draft_kind,
    given: {
      name: location.name,
      city: location.city,
      region: location.region,
      category: location.primary_category,
      website: location.website,
      what_we_do: location.what_we_do,
      host: task.host,
      url: task.url,
    },
  };
}

// An email address, then a web address: one with a scheme or `www.`, or a bare name ending in
// what looks like a top-level domain, with whatever path follows it.
//
// These read text someone else wrote: a model's draft, and an owner's own words. Every repeat
// that something has to come after is bounded, by the length a name or a label may really have
// (64 before the "@", 63 to a label). An unbounded one is tried again from every character of a
// long run that never finishes, such as a hundred thousand "%" and no "@", and that takes the
// square of the length.
const EMAIL = /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+/gi;
const ADDRESS =
  /(?:https?:\/\/|www\.)[^\s<>"')\]]+|\b[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,8}\.[a-z]{2,24}\b(?:\/[^\s<>"')\]]*)?/gi;
const NUMBER = /\d+(?:[.,]\d+)*/g;

/** What may end a sentence an address stands in, or an address itself, and is not part of it. */
const TRAILING = ".,;:!?/";

/** A web address as it is compared: no scheme, no `www.`, lower case, nothing trailing. */
function plain(address: string): string {
  const bare = address
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "");
  // Counted off from the end by hand, for the reason above: a pattern for "these, to the end"
  // starts over from each of them.
  let end = bare.length;
  while (end > 0 && TRAILING.includes(bare.charAt(end - 1))) end -= 1;
  return bare.slice(0, end);
}

/** A number as it is compared: "1,998" is 1998. */
const digits = (number: string) => number.replaceAll(",", "");

/**
 * The checkable facts in a draft that nobody gave: every number, web address and email address
 * in `text` that is not in what the draft was written from. Empty when the draft passes.
 *
 * A web address passes as one that was given, or as the site of one. A number passes when the
 * same number is anywhere in what was given. This is a rule, so it catches what a rule can: a
 * made-up phone number, year, price, link or address to write to. It does not read meaning.
 */
export function factsNobodyGave(text: string, given: DraftGiven): string[] {
  const said = [
    given.name,
    given.city,
    given.region,
    given.category,
    given.website,
    given.what_we_do,
    given.host,
    given.url,
  ]
    .filter((part) => part !== null)
    .join("\n");

  const addresses = new Set<string>();
  for (const address of said.replace(EMAIL, " ").match(ADDRESS) ?? []) {
    const whole = plain(address);
    addresses.add(whole);
    addresses.add(whole.split("/")[0] ?? whole);
  }
  const emails = new Set((said.match(EMAIL) ?? []).map((email) => email.toLowerCase()));
  const numbers = new Set((said.match(NUMBER) ?? []).map(digits));

  const unknown = new Set<string>();
  for (const email of text.match(EMAIL) ?? []) {
    if (!emails.has(email.toLowerCase())) unknown.add(email);
  }
  const withoutEmails = text.replace(EMAIL, " ");
  for (const address of withoutEmails.match(ADDRESS) ?? []) {
    if (!addresses.has(plain(address))) unknown.add(address);
  }
  // A number inside an address was judged with the address.
  for (const number of withoutEmails.replace(ADDRESS, " ").match(NUMBER) ?? []) {
    if (!numbers.has(digits(number))) unknown.add(number);
  }
  return [...unknown];
}

/**
 * Where an organization's month of drafts stands: its plan's number for each location the plan
 * covers, how many are used, and the day the count starts again.
 */
export function draftsStanding(
  allowances: Allowances,
  locations: number,
  used: AllowanceUse,
  now: Date,
): DraftsStanding {
  const each = allowances[DRAFTS_ALLOWANCE];
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    allowed: typeof each === "number" ? allowedEachMonth(each, locations) : null,
    used: used[DRAFTS_ALLOWANCE] ?? 0,
    resets_on: next.toISOString().slice(0, 10),
  };
}
