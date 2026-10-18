import { hostOf, hostsMatch, namesMatch, normalizeName } from "./analysis";
import { formatPhone } from "./inputs";
import {
  type Alert,
  type AlertClearReason,
  CITING_SURFACES,
  type CompetitorFacts,
  type DropAlert,
  type DropFacts,
  type PhoneFacts,
  type SiteFacts,
  SURFACE_LABELS,
  SURFACES,
  SURFACES_BY_KIND,
  type Surface,
  type Tier,
} from "./schemas";
import { cellKey, isCounted, SCAN_WINDOW } from "./scoring";
import { belongsTo, summarizeSources } from "./sources";

/**
 * Alerts: telling an owner when something measured changes for the worse (issue #136).
 *
 * An alert is composed by rule from what the scans recorded, never written by a model, and it
 * states the observation it rests on. Unlike a recommendation it cannot be worked out again
 * from the window each time: after seven scans that did not name the business the window holds
 * nothing that says it ever was named, and a rule that looked only there would clear a drop
 * that never ended. So an alert is kept, and what raises one and what clears one are different
 * conditions (`docs/adr/0015-an-alert-is-kept-not-worked-out-again.md`).
 *
 * - A drop, on one prompt and one surface at one tier. Raised when the newest `DROP_MISSES`
 *   checks did not name the business and at least `DROP_NAMED_BEFORE` of the
 *   `DROP_CHECKS_BEFORE` before them did. Cleared when a check made after the alert was raised
 *   names the business, or when the prompt, the surface or the tier is no longer checked. Never
 *   by age. A check where Google showed nothing is passed over: it neither misses nor names, so
 *   it raises, counts toward and clears nothing (ADR 0024).
 * - A first sighting, of a business or of a site. Raised when the written answers of the latest
 *   `FIRST_SEEN_SCANS` scans name the business, or cite the site, in at least
 *   `FIRST_SEEN_ANSWERS` answers across at least `FIRST_SEEN_IN_SCANS` of those scans, and no
 *   written answer of any earlier scan on record did. It is news, not a state, so nothing ends
 *   it: it is cleared once the scan that raised it has left the window, seven scans on.
 * - A phone number that is not the location's. Raised when the written answers of the window
 *   give the same number for the business, other than the one on file, in at least
 *   `PHONE_IN_SCANS` scans, which is at least that many answers. Cleared when no answer in
 *   the window gives it any more, or when it becomes the number on file. A member who dismisses
 *   one is saying the number is theirs, so a dismissed one is never cleared and the number is
 *   never raised again.
 *
 * One answer is a sample, which is why a drop takes three. A prompt that names the business nine
 * times in ten misses three times running by chance about once in a thousand scans, and twice
 * running about once in a hundred: with thirty such cells scanned daily that is a false alert
 * about once a month against one every few days. A first sighting takes three answers in two
 * scans for the same reason: a single answer often names a business no other answer ever does.
 */
export const DROP_MISSES = 3;
export const DROP_CHECKS_BEFORE = 4;
export const DROP_NAMED_BEFORE = 3;

export const FIRST_SEEN_SCANS = 3;
export const FIRST_SEEN_IN_SCANS = 2;
export const FIRST_SEEN_ANSWERS = 3;
/**
 * How many scans a location needs on record before a first sighting is raised: a full window.
 * Its first scans name everyone for the first time.
 */
export const FIRST_SEEN_BASELINE = SCAN_WINDOW;

/**
 * A number is read by where it stands in an answer, which can tie it to the wrong business
 * once. The same number in two scans is not that.
 */
export const PHONE_IN_SCANS = 2;
/** How many of the prompts a business was named for an alert lists. */
const MAX_PLACES = 3;

/** One check, as far as an alert is concerned. */
export interface AlertCheck {
  tracked_query_id: string;
  surface: Surface;
  /** The model it was asked with. Left out, as on a result kept before tiers, it is Standard. */
  tier?: Tier;
  /** False when Google showed nothing for the search. Left out, it was shown. */
  shown?: boolean;
  mentioned: boolean;
  competitors: readonly string[];
  cited_urls: readonly string[];
  /** The phone numbers the answer gave for the business, in international form. */
  phones: readonly string[];
}

/** One scan's checks, and when it asked. `id` is null only where the scan has none to give. */
export interface AlertScan {
  id: string | null;
  at: string;
  checks: readonly AlertCheck[];
}

/** An alert the worker has not cleared, dismissed or not, as far as the rules are concerned. */
export type CurrentAlert =
  | (Pick<DropAlert, "id" | "kind" | "tracked_query_id" | "surface" | "scan_id"> &
      Partial<Pick<DropAlert, "tier">>)
  | Pick<Extract<Alert, { kind: "competitor" }>, "id" | "kind" | "facts" | "scan_id">
  | Pick<Extract<Alert, { kind: "site" }>, "id" | "kind" | "facts" | "scan_id">
  | Pick<Extract<Alert, { kind: "phone" }>, "id" | "kind" | "facts" | "scan_id" | "dismissed_at">;

/** An alert a rule raises. The database adds the location, the scan and when. */
export type NewAlert = {
  /** What it is about, so the same thing is not raised twice while one is current. */
  subject: string;
  since: string;
} & (
  | { kind: "drop"; tracked_query_id: string; surface: Surface; tier: Tier; facts: DropFacts }
  | { kind: "competitor"; facts: CompetitorFacts }
  | { kind: "site"; facts: SiteFacts }
  | { kind: "phone"; facts: PhoneFacts }
);

/** What a finished scan changes: the alerts that have ended, and the new ones. */
export interface AlertChanges {
  clear: { id: string; reason: AlertClearReason }[];
  raise: NewAlert[];
}

/**
 * What the written answers of the scans before the latest ones named and cited: every business
 * as it was written, and every page's address up to its path. Read from the whole record, which
 * the window is only the end of.
 */
export interface SeenBefore {
  competitors: readonly string[];
  origins: readonly string[];
}

export interface AlertInput {
  /** The window, newest first, the scan that just finished at its head. */
  scans: readonly AlertScan[];
  /**
   * Every alert of the location not yet cleared, the dismissed ones among them: a dismissed
   * alert is still current, so the thing it is about is not raised again.
   */
  current: readonly CurrentAlert[];
  /** Each prompt's text, which an alert keeps so that it reads the same wherever it is shown. */
  prompts: readonly { id: string; text: string }[];
  /** The business's own website, which a first sighting of a site tells apart. */
  website: string | null;
  /**
   * The phone number on file, in international form, and the country it is written in. With
   * none on file there is nothing for an answer's number to differ from.
   */
  phone: string | null;
  country_code: string;
  /**
   * What was named and cited before the latest scans. Null when it was not asked for, which
   * `hasNewcomers` says whether it need be, and then no first sighting is raised.
   */
  seen: SeenBefore | null;
}

/** What an alert is about, with its kind, so one of a kind is not mistaken for another's. */
function subjectOf(alert: CurrentAlert | NewAlert): string {
  if ("subject" in alert) return `${alert.kind}:${alert.subject}`;
  switch (alert.kind) {
    case "drop":
      return `drop:${cellKey(alert)}`;
    case "competitor":
      return `competitor:${normalizeName(alert.facts.name)}`;
    case "site":
      return `site:${alert.facts.host}`;
    case "phone":
      return `phone:${alert.facts.number}`;
  }
}

/**
 * What the scan that just finished clears and raises. The newest scan decides which cells
 * exist, as it does for the rates.
 */
export function deriveAlerts(input: AlertInput): AlertChanges {
  const { scans, current, prompts, website, seen, phone } = input;
  const changes: AlertChanges = { clear: [], raise: [] };
  const [newest] = scans;
  if (!newest) return changes;

  // Each cell's checks, newest first, with the scan each came from.
  const cells = new Map<string, { check: AlertCheck; scan: number }[]>(
    newest.checks.map((check) => [cellKey(check), []]),
  );
  scans.forEach((scan, index) => {
    for (const check of scan.checks) cells.get(cellKey(check))?.push({ check, scan: index });
  });

  const text = new Map(prompts.map((prompt) => [prompt.id, prompt.text]));
  const numbers = numbersGiven(scans);

  const stillCurrent = new Set<string>();
  for (const alert of current) {
    // Where the scan that raised it stands in the window, or -1 once it has left.
    const raisedBy = scans.findIndex((scan) => scan.id !== null && scan.id === alert.scan_id);
    let reason: AlertClearReason | null;
    if (alert.kind === "drop") {
      reason = dropEnded(cells.get(cellKey(alert)), raisedBy === -1 ? scans.length : raisedBy);
    } else if (alert.kind === "phone") {
      reason = numberEnded(alert, numbers, phone);
    } else {
      reason = raisedBy === -1 ? "old_news" : null;
    }
    if (reason) changes.clear.push({ id: alert.id, reason });
    else stillCurrent.add(subjectOf(alert));
  }

  const raised = [
    ...drops(cells, scans, text),
    ...(seen ? firstSightings(newcomers(scans, website, text), seen) : []),
    ...otherNumbers(numbers, input, text),
  ];
  changes.raise = raised.filter((alert) => !stillCurrent.has(subjectOf(alert)));
  return changes;
}

/**
 * Why a drop has ended, or null while it goes on. Only a check made after the alert was raised
 * ends it: the scans ahead of the one that raised it, which is all of them once that scan has
 * left the window.
 */
function dropEnded(
  checks: { check: AlertCheck; scan: number }[] | undefined,
  raisedBy: number,
): AlertClearReason | null {
  if (!checks) return "not_tracked";
  return checks.some(({ check, scan }) => scan < raisedBy && check.mentioned)
    ? "named_again"
    : null;
}

function drops(
  cells: ReadonlyMap<string, { check: AlertCheck; scan: number }[]>,
  scans: readonly AlertScan[],
  text: ReadonlyMap<string, string>,
): NewAlert[] {
  const raised: NewAlert[] = [];
  for (const [cell, checks] of cells) {
    const [first] = checks;
    if (!first) continue;
    // The cell must have been checked in enough scans; of those, only the checks that showed
    // something can miss or name.
    const checked = checks.slice(0, DROP_MISSES + DROP_CHECKS_BEFORE);
    if (checked.length < DROP_MISSES + DROP_CHECKS_BEFORE) continue;
    const recent = checked.filter(({ check }) => isCounted(check));
    if (recent.length < DROP_MISSES + DROP_NAMED_BEFORE) continue;
    if (recent.slice(0, DROP_MISSES).some(({ check }) => check.mentioned)) continue;
    const namedBefore = recent.slice(DROP_MISSES).filter(({ check }) => check.mentioned).length;
    if (namedBefore < DROP_NAMED_BEFORE) continue;

    // The whole run of misses, which is longer than three when the alert could not be raised
    // at the third: the cell's window was not yet full, or alerts did not exist yet.
    const named = recent.findIndex(({ check }) => check.mentioned);
    const missed = recent.slice(0, named);
    const before = recent.slice(named);
    const began = missed[missed.length - 1];
    raised.push({
      kind: "drop",
      subject: cell,
      tracked_query_id: first.check.tracked_query_id,
      surface: first.check.surface,
      tier: first.check.tier ?? "standard",
      facts: {
        prompt: text.get(first.check.tracked_query_id) ?? "",
        missed: missed.length,
        checks_before: before.length,
        named_before: before.filter(({ check }) => check.mentioned).length,
      },
      since: scans[began?.scan ?? 0]?.at ?? "",
    });
  }
  return raised;
}

/** Where something was seen: how many answers for each prompt, and on which surfaces. */
type Places = Map<string, { answers: number; surfaces: Set<Surface> }>;

function seenAt(places: Places, answer: Pick<AlertCheck, "tracked_query_id" | "surface">) {
  const place = places.get(answer.tracked_query_id) ?? { answers: 0, surfaces: new Set() };
  place.answers += 1;
  place.surfaces.add(answer.surface);
  places.set(answer.tracked_query_id, place);
}

/** A few of the places, the prompt with the most answers first, and how many there were. */
function listPlaces(places: Places, text: ReadonlyMap<string, string>) {
  const sorted = [...places].sort((a, b) => b[1].answers - a[1].answers);
  return {
    places: sorted.slice(0, MAX_PLACES).map(([query, place]) => ({
      prompt: text.get(query) ?? "",
      surfaces: SURFACES.filter((surface) => place.surfaces.has(surface)),
    })),
    prompts: sorted.length,
  };
}

/** A phone number the window's answers gave for the business, and where. */
interface NumberGiven {
  answers: number;
  /** The scans that gave it, by their place in the window. */
  scans: Set<number>;
  places: Places;
}

/** Every phone number the written answers of the window gave for the business. */
function numbersGiven(scans: readonly AlertScan[]): Map<string, NumberGiven> {
  const given = new Map<string, NumberGiven>();
  scans.forEach((scan, index) => {
    for (const answer of scan.checks) {
      for (const number of new Set(answer.phones)) {
        const seen = given.get(number) ?? { answers: 0, scans: new Set(), places: new Map() };
        seen.answers += 1;
        seen.scans.add(index);
        seenAt(seen.places, answer);
        given.set(number, seen);
      }
    }
  });
  return given;
}

/**
 * Why an alert about a phone number has ended, or null while it stands. One a member dismissed
 * never ends: they said the number is theirs, and it stays in the way of the number being
 * raised again.
 */
function numberEnded(
  alert: Extract<CurrentAlert, { kind: "phone" }>,
  numbers: ReadonlyMap<string, NumberGiven>,
  onFile: string | null,
): AlertClearReason | null {
  if (alert.dismissed_at !== null) return null;
  if (onFile === null) return "not_tracked";
  if (alert.facts.number === onFile) return "now_on_file";
  return numbers.has(alert.facts.number) ? null : "no_longer_given";
}

/** The numbers the answers gave for the business often enough, other than the one on file. */
function otherNumbers(
  numbers: ReadonlyMap<string, NumberGiven>,
  { scans, phone, country_code }: AlertInput,
  text: ReadonlyMap<string, string>,
): NewAlert[] {
  if (phone === null) return [];
  return [...numbers]
    .filter(([number, given]) => number !== phone && given.scans.size >= PHONE_IN_SCANS)
    .map(([number, given]) => ({
      kind: "phone",
      subject: number,
      facts: {
        number,
        on_file: phone,
        country_code,
        answers: given.answers,
        scans: given.scans.size,
        of_scans: scans.length,
        ...listPlaces(given.places, text),
      },
      // The oldest scan in the window that gave it.
      since: scans[Math.max(...given.scans)]?.at ?? "",
    }));
}

/** A business the latest scans named often enough to be told of, if it proves to be new. */
interface NewBusiness {
  /** Every way the answers wrote it. */
  spellings: string[];
  facts: CompetitorFacts;
  since: string;
}

/** A site the latest scans cited often enough to be told of, if it proves to be new. */
interface NewSite {
  facts: SiteFacts;
  since: string;
}

interface Newcomers {
  businesses: NewBusiness[];
  sites: NewSite[];
}

const often = (answers: number, scans: number) =>
  answers >= FIRST_SEEN_ANSWERS && scans >= FIRST_SEEN_IN_SCANS;

/**
 * The businesses and sites the written answers of the latest scans named or cited often enough
 * to be a first sighting, and that the rest of the window does not hold, before anyone has asked
 * whether the record before the window does. None until the location has a full window of
 * scans. Only written answers count: a results list names ten businesses every time, and its
 * tail changes daily.
 */
function newcomers(
  scans: readonly AlertScan[],
  website: string | null,
  text: ReadonlyMap<string, string> = new Map(),
): Newcomers {
  if (scans.length < FIRST_SEEN_BASELINE) return { businesses: [], sites: [] };
  const written = (scan: AlertScan) =>
    scan.checks.filter((check) => CITING_SURFACES.includes(check.surface));
  const latest = scans
    .slice(0, FIRST_SEEN_SCANS)
    .map((scan) => ({ at: scan.at, answers: written(scan) }));
  /** When the oldest of the given scans asked: when the newcomer was first seen. */
  const firstSeen = (indexes: Iterable<number>) => latest[Math.max(...indexes)]?.at ?? "";

  // One business may be written several ways, so names are gathered by whether they match.
  interface Gathered {
    spellings: Map<string, number>;
    answers: number;
    scans: Set<number>;
    places: Places;
  }
  const gathered: Gathered[] = [];
  const byName = new Map<string, Gathered>();
  latest.forEach(({ answers }, scan) => {
    for (const answer of answers) {
      const named = new Set<Gathered>();
      for (const name of answer.competitors) {
        const key = normalizeName(name);
        let business = byName.get(key);
        if (!business) {
          business = gathered.find((candidate) =>
            [...candidate.spellings.keys()].some((spelling) => namesMatch(spelling, name)),
          );
          if (!business) {
            business = { spellings: new Map(), answers: 0, scans: new Set(), places: new Map() };
            gathered.push(business);
          }
          byName.set(key, business);
        }
        business.spellings.set(name, (business.spellings.get(name) ?? 0) + 1);
        named.add(business);
      }
      for (const business of named) {
        business.answers += 1;
        business.scans.add(scan);
        seenAt(business.places, answer);
      }
    }
  });

  const businesses = gathered
    .filter((business) => often(business.answers, business.scans.size))
    .map((business): NewBusiness => {
      const spellings = [...business.spellings].sort((a, b) => b[1] - a[1]);
      return {
        spellings: spellings.map(([spelling]) => spelling),
        facts: {
          name: spellings[0]?.[0] ?? "",
          answers: business.answers,
          scans: business.scans.size,
          of_scans: latest.length,
          ...listPlaces(business.places, text),
        },
        since: firstSeen(business.scans),
      };
    });

  // A site counts once for an answer, however many of its pages the answer cited.
  const cited = (answers: readonly AlertCheck[]) =>
    summarizeSources(answers, website, Number.POSITIVE_INFINITY);
  const scansCiting = new Map<string, Set<number>>();
  latest.forEach(({ answers }, scan) => {
    for (const site of cited(answers)) {
      scansCiting.set(site.host, (scansCiting.get(site.host) ?? new Set()).add(scan));
    }
  });
  const everyName = gathered.flatMap((business) => [...business.spellings.keys()]);
  const sites = cited(latest.flatMap(({ answers }) => answers))
    .filter((site) => often(site.answers, scansCiting.get(site.host)?.size ?? 0))
    // A competitor's own website is said by naming the competitor, not a second time as a site.
    .filter((site) => site.own || !everyName.some((name) => belongsTo(site.host, name)))
    .map((site): NewSite => {
      const scansOf = scansCiting.get(site.host) ?? new Set<number>();
      return {
        facts: {
          host: site.host,
          answers: site.answers,
          scans: scansOf.size,
          of_scans: latest.length,
          named: site.named,
          own: site.own,
          url: site.urls[0] ?? null,
        },
        since: firstSeen(scansOf),
      };
    });

  // The rest of the window is in hand, and it rules out nearly every one of them: the businesses
  // and sites the answers name week after week. What is left is rare, and only then is the
  // record before the window worth reading.
  const earlier = scans.slice(FIRST_SEEN_SCANS).flatMap(written);
  return unseen(
    { businesses, sites },
    {
      competitors: earlier.flatMap((answer) => answer.competitors),
      origins: earlier.flatMap((answer) => answer.cited_urls),
    },
  );
}

/** The newcomers that `seen` neither named, however it was written, nor cited. */
function unseen(found: Newcomers, seen: SeenBefore): Newcomers {
  const names = [...new Set(seen.competitors)];
  const hosts = [...new Set(seen.origins.map((origin) => hostOf(origin)))];
  return {
    businesses: found.businesses.filter(
      (business) =>
        !names.some((old) => business.spellings.some((spelling) => namesMatch(spelling, old))),
    ),
    sites: found.sites.filter((site) => !hosts.some((host) => hostsMatch(host, site.facts.host))),
  };
}

/**
 * Whether the latest scans hold anything that might be a first sighting: named or cited often
 * enough, and nowhere in the rest of the window. Only then does the record before the window
 * have to be read, and that read is the whole record.
 */
export function hasNewcomers(scans: readonly AlertScan[], website: string | null): boolean {
  const found = newcomers(scans, website);
  return found.businesses.length + found.sites.length > 0;
}

/** The newcomers that nothing on record before the latest scans named or cited, as alerts. */
function firstSightings(found: Newcomers, seen: SeenBefore): NewAlert[] {
  const fresh = unseen(found, seen);
  return [
    ...fresh.businesses.map(
      ({ facts, since }): NewAlert => ({
        kind: "competitor",
        subject: normalizeName(facts.name),
        facts,
        since,
      }),
    ),
    ...fresh.sites.map(
      ({ facts, since }): NewAlert => ({ kind: "site", subject: facts.host, facts, since }),
    ),
  ];
}

/** "prompt" where the surface is asked prompts, "keyword" where it is searched. */
const asked = (surface: Surface) =>
  SURFACES_BY_KIND.search_keyword.includes(surface) ? "keyword" : "prompt";

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** "A", "A and B", "A, B and C". */
const listed = (items: readonly string[]) =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** What an alert says, in a line. */
export function alertTitle(alert: Alert): string {
  switch (alert.kind) {
    case "drop":
      return `No longer named for "${alert.facts.prompt}" on ${SURFACE_LABELS[alert.surface]}`;
    case "competitor":
      return `${alert.facts.name} is named for the first time`;
    case "site":
      return alert.facts.own
        ? "Your website is read for the first time"
        : `${alert.facts.host} is read for the first time`;
    case "phone":
      return `The answers give a different phone number: ${formatPhone(alert.facts.number, alert.facts.country_code)}`;
  }
}

/** Where something was seen, in words: `"a" on ChatGPT and Claude; "b" on ChatGPT; and 2 more prompts`. */
function inPlaces(facts: Pick<CompetitorFacts, "places" | "prompts">): string {
  const where = facts.places.map(
    (place) =>
      `"${place.prompt}" on ${listed(place.surfaces.map((surface) => SURFACE_LABELS[surface]))}`,
  );
  const more = facts.prompts - facts.places.length;
  return `${where.join("; ")}${more > 0 ? `; and ${count(more, "more prompt")}` : ""}`;
}

/** How often something was seen: "3 answers across 2 of the last 3 scans". */
const sighted = (facts: { answers: number; scans: number; of_scans: number }) =>
  `${count(facts.answers, "answer")} across ${facts.scans} of the last ${facts.of_scans} scans`;

/** The observation an alert rests on. `day` writes a date the way the reader's page does. */
export function alertDetail(alert: Alert, day: (iso: string) => string): string {
  switch (alert.kind) {
    case "drop": {
      const { missed, checks_before, named_before } = alert.facts;
      return `Since ${day(alert.since)}. It was named in ${named_before} of the ${checks_before} checks before that and in none of the ${missed} since.`;
    }
    case "competitor":
      return `Since ${day(alert.since)}. Named in ${sighted(alert.facts)}, and in no answer before. It was named for ${inPlaces(alert.facts)}.`;
    case "site": {
      const { answers, named, own } = alert.facts;
      const naming = own
        ? ""
        : named === 0
          ? " None of those answers named the business."
          : named === answers
            ? ` All ${answers} of those answers named the business.`
            : ` ${named} of those ${answers} answers named the business.`;
      return `Since ${day(alert.since)}. Cited in ${sighted(alert.facts)}, and in no answer before.${naming}`;
    }
    case "phone": {
      const { on_file, country_code } = alert.facts;
      return `Since ${day(alert.since)}. Given for the business in ${sighted(alert.facts)}. The number on file is ${formatPhone(on_file, country_code)}. It was given for ${inPlaces(alert.facts)}.`;
    }
  }
}

/** What a drop that ended because the business was named again says, in a line. */
export function alertEnded(
  alert: Pick<DropAlert, "facts" | "surface" | "since">,
  day: (iso: string) => string,
): string {
  return `Named again for "${alert.facts.prompt}" on ${SURFACE_LABELS[alert.surface]}. It had not been since ${day(alert.since)}.`;
}

/**
 * What an organization's owners have not been told yet about a location: the alerts raised and
 * still open, and the drops they were told of that have since ended because the business was
 * named again. Each is told once.
 */
export interface AlertsToTell {
  raised: Alert[];
  named_again: Alert[];
}

/** Alerts that are shown as one: the drops one scan raised on one surface. */
export interface AlertGroup {
  key: string;
  /** One line for the whole group. */
  title: string;
  alerts: Alert[];
}

/**
 * Alerts as they are shown, in the order given. A surface that stops naming the business does
 * so for every prompt at once, and fifteen alerts saying so would be read as fifteen problems,
 * so the drops one scan raised on one surface are shown as one. A first sighting stands alone.
 */
export function groupAlerts(alerts: readonly Alert[]): AlertGroup[] {
  const groups = new Map<string, Alert[]>();
  for (const alert of alerts) {
    // An alert whose scan is gone stands alone.
    const key =
      alert.kind === "drop" && alert.scan_id
        ? `drop|${alert.surface}|${alert.scan_id}`
        : `${alert.kind}|${alert.id}`;
    groups.set(key, [...(groups.get(key) ?? []), alert]);
  }
  return [...groups].map(([key, members]) => ({
    key,
    title: groupTitle(members),
    alerts: members,
  }));
}

function groupTitle(members: readonly Alert[]): string {
  const [first] = members;
  if (!first) return "";
  if (members.length === 1 || first.kind !== "drop") return alertTitle(first);
  return `No longer named for ${members.length} ${asked(first.surface)}s on ${SURFACE_LABELS[first.surface]}`;
}
