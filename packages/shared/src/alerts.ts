import {
  type Alert,
  type AlertClearReason,
  type AlertKind,
  type DropFacts,
  SURFACE_LABELS,
  SURFACES_BY_KIND,
  type Surface,
} from "./schemas";

/**
 * Alerts: telling an owner when something measured gets worse (issue #136).
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
 *
 * One answer is a sample, which is why it takes three. A prompt that names the business nine
 * times in ten misses three times running by chance about once in a thousand scans, and twice
 * running about once in a hundred: with thirty such cells scanned daily that is a false alert
 * about once a month against one every few days.
 */
export const DROP_MISSES = 3;
export const DROP_CHECKS_BEFORE = 4;
export const DROP_NAMED_BEFORE = 3;

/** One check, as far as an alert is concerned. */
export interface AlertCheck {
  tracked_query_id: string;
  surface: Surface;
  mentioned: boolean;
}

/** One scan's checks, and when it asked. `id` is null only where the scan has none to give. */
export interface AlertScan {
  id: string | null;
  at: string;
  checks: readonly AlertCheck[];
}

/** An alert the worker has not cleared, dismissed or not, as far as the rules are concerned. */
export type CurrentAlert = Pick<Alert, "id" | "tracked_query_id" | "surface" | "scan_id">;

/** An alert a rule raises. The database adds the location, the scan and when. */
export interface NewAlert {
  kind: AlertKind;
  /** What it is about, so the same thing is not raised twice while one is current. */
  subject: string;
  tracked_query_id: string;
  surface: Surface;
  facts: DropFacts;
  since: string;
}

/** What a finished scan changes: the alerts that have ended, and the new ones. */
export interface AlertChanges {
  clear: { id: string; reason: AlertClearReason }[];
  raise: NewAlert[];
}

const cellOf = (check: Pick<AlertCheck, "tracked_query_id" | "surface">) =>
  `${check.tracked_query_id}|${check.surface}`;

/**
 * What the scan that just finished clears and raises.
 *
 * `scans` is the window, newest first, the scan that just finished at its head. `current` is
 * every alert of the location not yet cleared, the dismissed ones among them: a dismissed alert
 * is still current, so the thing it is about is not raised again until it has ended and begun
 * afresh. `prompts` gives each prompt's text, which the alert keeps so that it reads the same
 * wherever it is shown.
 *
 * The newest scan decides which cells exist, as it does for the rates.
 */
export function deriveAlerts(
  scans: readonly AlertScan[],
  current: readonly CurrentAlert[],
  prompts: readonly { id: string; text: string }[],
): AlertChanges {
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
    const checks = cells.get(cellOf(alert));
    if (!checks) {
      changes.clear.push({ id: alert.id, reason: "not_tracked" });
      continue;
    }
    // Only a check made after the alert was raised ends it: the scans ahead of the one that
    // raised it, which is all of them once that scan has left the window.
    const raisedBy = scans.findIndex((scan) => scan.id !== null && scan.id === alert.scan_id);
    const newer = raisedBy === -1 ? scans.length : raisedBy;
    if (checks.some(({ check, scan }) => scan < newer && check.mentioned)) {
      changes.clear.push({ id: alert.id, reason: "named_again" });
    } else {
      stillCurrent.add(cellOf(alert));
    }
  }

  const text = new Map(prompts.map((prompt) => [prompt.id, prompt.text]));
  for (const [cell, checks] of cells) {
    const [first] = checks;
    if (!first || stillCurrent.has(cell)) continue;
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
    changes.raise.push({
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
      since: scans[began?.scan ?? 0]?.at ?? newest.at,
    });
  }
  return changes;
}

/** "prompt" where the surface is asked prompts, "keyword" where it is searched. */
const asked = (surface: Surface) =>
  SURFACES_BY_KIND.search_keyword.includes(surface) ? "keyword" : "prompt";

/** What an alert says, in a line. */
export function alertTitle(alert: Pick<Alert, "facts" | "surface">): string {
  return `No longer named for "${alert.facts.prompt}" on ${SURFACE_LABELS[alert.surface]}`;
}

/**
 * The observation an alert rests on. `day` writes a date the way the reader's page does.
 */
export function alertDetail(
  alert: Pick<Alert, "facts" | "since">,
  day: (iso: string) => string,
): string {
  const { missed, checks_before, named_before } = alert.facts;
  return `Since ${day(alert.since)}. It was named in ${named_before} of the ${checks_before} checks before that and in none of the ${missed} since.`;
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
 * so the drops one scan raised on one surface are shown as one.
 */
export function groupAlerts(alerts: readonly Alert[]): AlertGroup[] {
  const groups = new Map<string, Alert[]>();
  for (const alert of alerts) {
    // An alert whose scan is gone stands alone.
    const key = `${alert.kind}|${alert.surface}|${alert.scan_id ?? alert.id}`;
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
  if (members.length === 1) return alertTitle(first);
  return `No longer named for ${members.length} ${asked(first.surface)}s on ${SURFACE_LABELS[first.surface]}`;
}
