import type { Allowances, AllowanceUse, LoweredAllowances } from "./schemas";

/** One kind of work a plan can include (`docs/adr/0012-a-plans-allowances-are-one-set.md`). */
export interface AllowanceKind {
  /**
   * True when a plan gives a number a month for each location it covers. False when the kind is
   * included or it is not.
   */
  counted: boolean;
  /** What it is, as its line on the price list begins. */
  name: string;
}

/**
 * Every kind of work a plan can include, by key, in the order they are listed. The database
 * holds the same keys in `allowance_kinds` and refuses any other, so a kind is added to both in
 * one change.
 */
export const ALLOWANCE_KINDS: Record<string, AllowanceKind> = {
  // Wording written for a task (`drafts.ts`). `DRAFTS_ALLOWANCE` there is this key.
  drafts: { counted: true, name: "Drafts written for you" },
  // Visits to a business's own site that came from an assistant (`visits.ts`).
  // `VISITS_ALLOWANCE` there is this key.
  visits: { counted: false, name: "Visits from assistants counted" },
  // Changing a business's own WordPress site, on approval (`wordpress.ts`).
  // `WORDPRESS_ALLOWANCE` there is this key.
  wordpress: { counted: false, name: "Publishing to your WordPress site" },
  // Pages the product serves on a subdomain of the business's own domain (`hosted-pages.ts`).
  // `HOSTED_PAGES_ALLOWANCE` there is this key.
  hosted_pages: { counted: false, name: "Pages hosted on your own domain" },
};

/** The most a plan may give of a counted kind, for each location, in a month. */
export const MOST_ALLOWED = 1_000_000;

/**
 * The allowances `to` would lower, each with what it is and what it would become: a kind taken
 * away, written as false, or a smaller number. A kind added or raised takes nothing from anyone.
 * The database works out the same thing in `allowance_reductions()`.
 */
export function allowanceReductions(was: Allowances, to: Allowances): LoweredAllowances {
  const lowered: LoweredAllowances = {};
  for (const [kind, from] of Object.entries(was)) {
    const becomes = to[kind];
    if (becomes === undefined) {
      lowered[kind] = { from, to: false };
    } else if (typeof from === "number" && typeof becomes === "number" && becomes < from) {
      lowered[kind] = { from, to: becomes };
    }
  }
  return lowered;
}

/**
 * How many a month an organization may have of a counted kind: its plan's number for each
 * location the plan covers, shared between them.
 */
export function allowedEachMonth(allowance: number, locations: number): number {
  return allowance * locations;
}

/** A kind's name, or its key in words where this build does not know the kind. */
function nameOf(key: string, kinds: Record<string, AllowanceKind>): string {
  const known = kinds[key]?.name;
  if (known) return known;
  const words = key.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A plan's allowances as lines for a price list, in the order the kinds are listed. A kind this
 * build does not know is left out: it has no words for it.
 */
export function allowanceLines(allowances: Allowances, kinds = ALLOWANCE_KINDS): string[] {
  return Object.entries(kinds).flatMap(([key, kind]) => {
    const allowance = allowances[key];
    if (allowance === undefined) return [];
    return [
      allowance === true ? kind.name : `${kind.name}: ${allowance} a month for each location`,
    ];
  });
}

/**
 * Lowered allowances in words, one line for each, with the words for "before" and "after" the
 * caller is using. Every kind is described, known to this build or not: somebody is being told
 * what they lose.
 */
export function describeLoweredAllowances(
  lowered: LoweredAllowances,
  was: string,
  becomes: string,
  kinds = ALLOWANCE_KINDS,
): string[] {
  return Object.entries(lowered).map(([key, { from, to }]) => {
    const name = nameOf(key, kinds);
    if (from === true) return `${name}: included ${was}, not ${becomes}`;
    return to === false
      ? `${name}: ${from} a month for each location ${was}, none ${becomes}`
      : `${name}, a month for each location: ${from} ${was}, ${to} ${becomes}`;
  });
}

/**
 * What is wrong with a set of allowances the operator typed, by kind. Empty when every kind
 * exists and has a value it takes.
 */
export function allowanceErrors(
  allowances: Record<string, unknown>,
  kinds = ALLOWANCE_KINDS,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [key, value] of Object.entries(allowances)) {
    const kind = kinds[key];
    if (!kind) {
      errors[key] = "This is not a kind of allowance";
    } else if (!kind.counted) {
      if (value !== true) errors[key] = "This is included or it is not";
    } else if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      errors[key] = "Enter a whole number, or leave it empty for none";
    } else if (value > MOST_ALLOWED) {
      errors[key] = `Enter ${MOST_ALLOWED.toLocaleString("en-US")} or fewer`;
    }
  }
  return errors;
}

/**
 * What the operator typed for each kind, as a set of allowances. An empty field and a zero are
 * a kind that is not included; anything that is not a number is kept as it is not, so the check
 * can say so.
 */
export function allowancesFromText(
  text: Record<string, string | boolean>,
  kinds = ALLOWANCE_KINDS,
): Record<string, number | true> {
  const allowances: Record<string, number | true> = {};
  for (const [key, kind] of Object.entries(kinds)) {
    const typed = text[key];
    if (!kind.counted) {
      if (typed === true) allowances[key] = true;
    } else if (typeof typed === "string" && typed.trim() !== "" && Number(typed) !== 0) {
      allowances[key] = Number(typed);
    }
  }
  return allowances;
}

/** A set of allowances as the text the operator's fields start from. */
export function allowancesAsText(
  allowances: Allowances,
  kinds = ALLOWANCE_KINDS,
): Record<string, string | boolean> {
  return Object.fromEntries(
    Object.entries(kinds).map(([key, kind]) => {
      const allowance = allowances[key];
      return [
        key,
        kind.counted ? (allowance === undefined ? "" : String(allowance)) : allowance === true,
      ];
    }),
  );
}

/** The kinds in `kept` that this build has no words for, which an edit must leave alone. */
export function unknownAllowances(kept: Allowances, kinds = ALLOWANCE_KINDS): Allowances {
  return Object.fromEntries(Object.entries(kept).filter(([key]) => !(key in kinds)));
}

/**
 * A set as it is saved after an edit: what the form sent, with the kinds this build does not
 * know put back from the stored set. A form shows and sends only the kinds it knows, so without
 * this the Worker running while a migration adds a kind would drop it at the next save.
 */
export function keepUnknownAllowances(
  stored: Allowances,
  sent: Allowances,
  kinds = ALLOWANCE_KINDS,
): Allowances {
  return { ...unknownAllowances(stored, kinds), ...sent };
}

/** The kinds in `kept` that this build knows, which are the ones its forms show and send. */
export function knownAllowances(kept: Allowances, kinds = ALLOWANCE_KINDS): Allowances {
  return Object.fromEntries(Object.entries(kept).filter(([key]) => key in kinds));
}

/**
 * An organization's allowances as the facts its account page lists: each kind it has, with
 * "Included" or how many it may have this month across the locations its plan covers. `used` is
 * what it has used so far, once that is known.
 */
export function allowanceFacts(
  allowances: Allowances,
  locations: number,
  used: AllowanceUse | null = null,
  kinds = ALLOWANCE_KINDS,
): { key: string; name: string; value: string }[] {
  return Object.entries(kinds).flatMap(([key, kind]) => {
    const allowance = allowances[key];
    if (allowance === undefined) return [];
    const value =
      allowance === true
        ? "Included"
        : `${used ? `${used[key] ?? 0} of ` : ""}${allowedEachMonth(allowance, locations)} this month`;
    return [{ key, name: kind.name, value }];
  });
}
