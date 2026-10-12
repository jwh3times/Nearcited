import { hostOf, hostsMatch, namesMatch, normalizeName } from "./analysis";
import {
  type Alert,
  type AlertClearReason,
  CITING_SURFACES,
  type CompetitorFacts,
  type DropAlert,
  type DropFacts,
  type SiteFacts,
  SURFACE_LABELS,
  SURFACES,
  SURFACES_BY_KIND,
  type Surface,
} from "./schemas";
import { SCAN_WINDOW } from "./scoring";
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
 * - A drop, on one prompt and one surface. Raised when the newest `DROP_MISSES` checks did not
 *   name the business and at least `DROP_NAMED_BEFORE` of the `DROP_CHECKS_BEFORE` before them
 *   did. Cleared when a check made after the alert was raised names the business, or when the
 *   prompt or the surface is no longer checked. Never by age.
 * - A first sighting, of a business or of a site. Raised when the written answers of the latest
 *   `FIRST_SEEN_SCANS` scans name the business, or cite the site, in at least
 *   `FIRST_SEEN_ANSWERS` answers across at least `FIRST_SEEN_IN_SCANS` of those scans, and no
 *   written answer of any earlier scan on record did. It is news, not a state, so nothing ends
 *   it: it is cleared once the scan that raised it has left the window, seven scans on.
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
/** How many of the prompts a business was named for an alert lists. */
const MAX_PLACES = 3;

/** One check, as far as an alert is concerned. */
export interface AlertCheck {
  tracked_query_id: string;
  surface: Surface;
  mentioned: boolean;
  competitors: readonly string[];
  cited_urls: readonly string[];
}

/** One scan's checks, and when it asked. `id` is null only where the scan has none to give. */
export interface AlertScan {
  id: string | null;
  at: string;
  checks: readonly AlertCheck[];
}

/** An alert the worker has not cleared, dismissed or not, as far as the rules are concerned. */
export type CurrentAlert =
  | Pick<DropAlert, "id" | "kind" | "tracked_query_id" | "surface" | "scan_id">
  | Pick<Extract<Alert, { kind: "competitor" }>, "id" | "kind" | "facts" | "scan_id">
  | Pick<Extract<Alert, { kind: "site" }>, "id" | "kind" | "facts" | "scan_id">;

/** An alert a rule raises. The database adds the location, the scan and when. */
export type NewAlert = {
  /** What it is about, so the same thing is not raised twice while one is current. */
  subject: string;
  since: string;
} & (
  | { kind: "drop"; tracked_query_id: string; surface: Surface; facts: DropFacts }
  | { kind: "competitor"; facts: CompetitorFacts }
  | { kind: "site"; facts: SiteFacts }
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
   * What was named and cited before the latest scans. Null when it was not asked for, which
   * `hasNewcomers` says whether it need be, and then no first sighting is raised.
   */
  seen: SeenBefore | null;
}

const cellOf = (check: Pick<AlertCheck, "tracked_query_id" | "surface">) =>
  `${check.tracked_query_id}|${check.surface}`;

/** What an alert is about, with its kind, so one of a kind is not mistaken for another's. */
function subjectOf(alert: CurrentAlert | NewAlert): string {
  if ("subject" in alert) return `${alert.kind}:${alert.subject}`;
  if (alert.kind === "drop") return `drop:${cellOf(alert)}`;
  return alert.kind === "competitor"
    ? `competitor:${normalizeName(alert.facts.name)}`
    : `site:${alert.facts.host}`;
}

/**
 * What the scan that just finished clears and raises. The newest scan decides which cells
 * exist, as it does for the rates.
 */
export function deriveAlerts({ scans, current, prompts, website, seen }: AlertInput): AlertChanges {
  const changes: AlertChanges = { clear: [], raise: [] };
  const [newest] = scans;
  if (!newest) return changes;

  // Each cell's checks, newest first, with the scan each came from.
  const cells = new Map<string, { check: AlertCheck; scan: number }[]>(
    newest.checks.map((check) => [cellOf(check), []]),
  );
  scans.forEach((scan, index) => {
    for (const check of scan.checks) cells.get(cellOf(check))?.push({ check, scan: index });
  });

  const stillCurrent = new Set<string>();
  for (const alert of current) {
    // Where the scan that raised it stands in the window, or -1 once it has left.
    const raisedBy = scans.findIndex((scan) => scan.id !== null && scan.id === alert.scan_id);
    const reason =
      alert.kind === "drop"
        ? dropEnded(cells.get(cellOf(alert)), raisedBy === -1 ? scans.length : raisedBy)
        : raisedBy === -1
          ? "old_news"
          : null;
    if (reason) changes.clear.push({ id: alert.id, reason });
    else stillCurrent.add(subjectOf(alert));
  }

  const text = new Map(prompts.map((prompt) => [prompt.id, prompt.text]));
  const raised = [
    ...drops(cells, scans, text),
    ...(seen ? firstSightings(newcomers(scans, website, text), seen) : []),
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
    const recent = checks.slice(0, DROP_MISSES + DROP_CHECKS_BEFORE);
    if (recent.length < DROP_MISSES + DROP_CHECKS_BEFORE) continue;
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
    places: Map<string, { answers: number; surfaces: Set<Surface> }>;
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
        const place = business.places.get(answer.tracked_query_id) ?? {
          answers: 0,
          surfaces: new Set<Surface>(),
        };
        place.answers += 1;
        place.surfaces.add(answer.surface);
        business.places.set(answer.tracked_query_id, place);
      }
    }
  });

  const businesses = gathered
    .filter((business) => often(business.answers, business.scans.size))
    .map((business): NewBusiness => {
      const spellings = [...business.spellings].sort((a, b) => b[1] - a[1]);
      const places = [...business.places].sort((a, b) => b[1].answers - a[1].answers);
      return {
        spellings: spellings.map(([spelling]) => spelling),
        facts: {
          name: spellings[0]?.[0] ?? "",
          answers: business.answers,
          scans: business.scans.size,
          of_scans: latest.length,
          places: places.slice(0, MAX_PLACES).map(([query, place]) => ({
            prompt: text.get(query) ?? "",
            surfaces: SURFACES.filter((surface) => place.surfaces.has(surface)),
          })),
          prompts: places.length,
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
  }
}

/** How often a newcomer was seen: "3 answers across 2 of the last 3 scans". */
const sighted = (facts: { answers: number; scans: number; of_scans: number }) =>
  `${count(facts.answers, "answer")} across ${facts.scans} of the last ${facts.of_scans} scans`;

/** The observation an alert rests on. `day` writes a date the way the reader's page does. */
export function alertDetail(alert: Alert, day: (iso: string) => string): string {
  switch (alert.kind) {
    case "drop": {
      const { missed, checks_before, named_before } = alert.facts;
      return `Since ${day(alert.since)}. It was named in ${named_before} of the ${checks_before} checks before that and in none of the ${missed} since.`;
    }
    case "competitor": {
      const { places, prompts } = alert.facts;
      const where = places.map(
        (place) =>
          `"${place.prompt}" on ${listed(place.surfaces.map((surface) => SURFACE_LABELS[surface]))}`,
      );
      const more = prompts - places.length;
      return `Since ${day(alert.since)}. Named in ${sighted(alert.facts)}, and in no answer before. It was named for ${where.join("; ")}${more > 0 ? `; and ${count(more, "more prompt")}` : ""}.`;
    }
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
