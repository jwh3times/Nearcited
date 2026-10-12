import { describe, expect, it } from "vitest";
import {
  type AlertScan,
  alertDetail,
  alertEnded,
  alertTitle,
  type CurrentAlert,
  deriveAlerts,
  groupAlerts,
} from "../src/alerts";
import type { Alert, Surface } from "../src/schemas";

const PIZZA = "00000000-0000-4000-8000-000000000001";
const PASTA = "00000000-0000-4000-8000-000000000002";
const PROMPTS = [
  { id: PIZZA, text: "best pizza near me" },
  { id: PASTA, text: "fresh pasta downtown" },
];

/**
 * A window from each cell's history, written oldest first: "TTTTFFF" was named four times and
 * then missed three. Scans come back newest first, as the window is, the newest with no ID yet
 * and the rest numbered from the oldest, `scan-1`.
 */
function windowOf(cells: Record<string, string>, surface: Surface = "chatgpt"): AlertScan[] {
  const length = Math.max(...Object.values(cells).map((history) => history.length));
  const scans: AlertScan[] = [];
  for (let index = 0; index < length; index++) {
    scans.push({
      id: index === length - 1 ? null : `scan-${index + 1}`,
      at: `2026-10-${String(index + 1).padStart(2, "0")}T09:00:00Z`,
      checks: Object.entries(cells).flatMap(([query, history]) => {
        // A shorter history is a prompt that was added later: it has no check in the older scans.
        const mark = history[index - (length - history.length)];
        return mark ? [{ tracked_query_id: query, surface, mentioned: mark === "T" }] : [];
      }),
    });
  }
  return scans.reverse();
}

const current = (query: string, raisedBy: string | null, surface: Surface = "chatgpt") =>
  ({ id: `alert-${query}`, tracked_query_id: query, surface, scan_id: raisedBy }) as CurrentAlert;

describe("deriveAlerts: raising a drop", () => {
  it("raises one when three checks in a row missed and the four before all named it", () => {
    const { raise, clear } = deriveAlerts(windowOf({ [PIZZA]: "TTTTFFF" }), [], PROMPTS);

    expect(clear).toEqual([]);
    expect(raise).toEqual([
      {
        kind: "drop",
        subject: `${PIZZA}|chatgpt`,
        tracked_query_id: PIZZA,
        surface: "chatgpt",
        facts: { prompt: "best pizza near me", missed: 3, checks_before: 4, named_before: 4 },
        // The first of the three that missed.
        since: "2026-10-05T09:00:00Z",
      },
    ]);
  });

  it("raises one when three of the four before named it", () => {
    const [alert] = deriveAlerts(windowOf({ [PIZZA]: "TFTTFFF" }), [], PROMPTS).raise;
    expect(alert?.facts).toMatchObject({ missed: 3, checks_before: 4, named_before: 3 });
  });

  it.each([
    ["only two misses", "TTTTTFF"],
    ["a miss, a mention and a miss", "TTTTFTF"],
    ["named in two of the four before", "TFFTFFF"],
    ["never named", "FFFFFFF"],
    ["named in the newest check", "TTTFFFT"],
  ])("raises nothing for %s", (_, history) => {
    expect(deriveAlerts(windowOf({ [PIZZA]: history }), [], PROMPTS).raise).toEqual([]);
  });

  it("raises nothing until the cell has a full window, however it reads", () => {
    expect(deriveAlerts(windowOf({ [PIZZA]: "TTTFFF" }), [], PROMPTS).raise).toEqual([]);
    // A prompt added three scans ago, beside one that has been asked all along.
    const changes = deriveAlerts(windowOf({ [PASTA]: "TTTTTTT", [PIZZA]: "FFF" }), [], PROMPTS);
    expect(changes.raise).toEqual([]);
  });

  it("says the whole run when the drop is older than three checks", () => {
    // Four misses: the alert could not be raised at the third, so it dates from the first.
    const [alert] = deriveAlerts(windowOf({ [PIZZA]: "TTTFFFF" }), [], PROMPTS).raise;
    expect(alert?.facts).toMatchObject({ missed: 4, checks_before: 3, named_before: 3 });
    expect(alert?.since).toBe("2026-10-04T09:00:00Z");
  });

  it("raises nothing for a drop older than the window can show", () => {
    expect(deriveAlerts(windowOf({ [PIZZA]: "TTFFFFF" }), [], PROMPTS).raise).toEqual([]);
  });

  it("judges each prompt on each surface by itself", () => {
    const scans = windowOf({ [PIZZA]: "TTTTFFF", [PASTA]: "TTTTTTT" });
    expect(deriveAlerts(scans, [], PROMPTS).raise.map((alert) => alert.tracked_query_id)).toEqual([
      PIZZA,
    ]);
  });

  it("does not raise a second while one for the same thing is current, dismissed or not", () => {
    const scans = windowOf({ [PIZZA]: "TTTFFFF" });
    // Raised by the scan before this one. Whether a member dismissed it makes no difference
    // here: the rule is not told, and a dismissed alert is still current.
    const changes = deriveAlerts(scans, [current(PIZZA, "scan-6")], PROMPTS);
    expect(changes).toEqual({ clear: [], raise: [] });
  });
});

describe("deriveAlerts: clearing a drop", () => {
  it("clears one when a check since it was raised names the business", () => {
    const scans = windowOf({ [PIZZA]: "TTTFFFT" });
    expect(deriveAlerts(scans, [current(PIZZA, "scan-6")], PROMPTS)).toEqual({
      clear: [{ id: `alert-${PIZZA}`, reason: "named_again" }],
      raise: [],
    });
  });

  it("is not cleared by the checks that named it before it was raised", () => {
    const scans = windowOf({ [PIZZA]: "TTTFFFF" });
    // Raised by the sixth scan, at the third miss: everything that named the business is older.
    expect(deriveAlerts(scans, [current(PIZZA, "scan-6")], PROMPTS).clear).toEqual([]);
  });

  it("is cleared by a scan that named it even if the newest did not", () => {
    // A scan finished without the rules running, named the business, and the next did not.
    const scans = windowOf({ [PIZZA]: "TTFFFTF" });
    expect(deriveAlerts(scans, [current(PIZZA, "scan-5")], PROMPTS).clear).toEqual([
      { id: `alert-${PIZZA}`, reason: "named_again" },
    ]);
  });

  it("never clears by age: seven misses on, it is still current", () => {
    const scans = windowOf({ [PIZZA]: "FFFFFFF" });
    // The scan that raised it has left the window, and nothing in the window named the business.
    expect(deriveAlerts(scans, [current(PIZZA, "scan-long-ago")], PROMPTS)).toEqual({
      clear: [],
      raise: [],
    });
  });

  it("clears one whose scan has left the window as soon as any check names the business", () => {
    const scans = windowOf({ [PIZZA]: "FFFFFFT" });
    expect(deriveAlerts(scans, [current(PIZZA, "scan-long-ago")], PROMPTS).clear).toEqual([
      { id: `alert-${PIZZA}`, reason: "named_again" },
    ]);
  });

  it("clears one whose prompt is no longer asked, or whose surface is no longer checked", () => {
    const scans = windowOf({ [PASTA]: "TTTTTTT" });
    const changes = deriveAlerts(
      scans,
      [current(PIZZA, "scan-6"), current(PASTA, "scan-6", "claude")],
      PROMPTS,
    );
    expect(changes.clear).toEqual([
      { id: `alert-${PIZZA}`, reason: "not_tracked" },
      { id: `alert-${PASTA}`, reason: "not_tracked" },
    ]);
  });

  it("does not raise again what it has just cleared", () => {
    const scans = windowOf({ [PIZZA]: "TTTFFFT" });
    expect(deriveAlerts(scans, [current(PIZZA, "scan-6")], PROMPTS).raise).toEqual([]);
  });

  it("changes nothing without a scan", () => {
    expect(deriveAlerts([], [current(PIZZA, "scan-6")], PROMPTS)).toEqual({ clear: [], raise: [] });
  });
});

const alert = (overrides: Partial<Alert> = {}): Alert => ({
  id: "00000000-0000-4000-8000-0000000000a1",
  location_id: "00000000-0000-4000-8000-0000000000b1",
  kind: "drop",
  tracked_query_id: PIZZA,
  surface: "chatgpt",
  facts: { prompt: "best pizza near me", missed: 3, checks_before: 4, named_before: 4 },
  since: "2026-10-05T09:00:00Z",
  scan_id: "00000000-0000-4000-8000-0000000000c1",
  raised_at: "2026-10-07T09:00:00Z",
  cleared_at: null,
  clear_reason: null,
  dismissed_at: null,
  dismissed_by_email: null,
  ...overrides,
});

const day = (iso: string) => iso.slice(0, 10);

describe("what an alert says", () => {
  it("names the prompt and the surface, and states what was counted", () => {
    expect(alertTitle(alert())).toBe('No longer named for "best pizza near me" on ChatGPT');
    expect(alertDetail(alert(), day)).toBe(
      "Since 2026-10-05. It was named in 4 of the 4 checks before that and in none of the 3 since.",
    );
  });
});

describe("what an alert that ended says", () => {
  it("says the business is named again, and since when it had not been", () => {
    expect(alertEnded(alert(), day)).toBe(
      'Named again for "best pizza near me" on ChatGPT. It had not been since 2026-10-05.',
    );
  });
});

describe("groupAlerts", () => {
  it("shows an alert on its own under its own line", () => {
    const [group] = groupAlerts([alert()]);
    expect(group?.title).toBe('No longer named for "best pizza near me" on ChatGPT');
    expect(group?.alerts).toHaveLength(1);
  });

  it("shows the drops one scan raised on one surface as one", () => {
    const groups = groupAlerts([
      alert(),
      alert({ id: "00000000-0000-4000-8000-0000000000a2", tracked_query_id: PASTA }),
      alert({ id: "00000000-0000-4000-8000-0000000000a3", surface: "claude" }),
    ]);
    expect(groups.map((group) => [group.title, group.alerts.length])).toEqual([
      ["No longer named for 2 prompts on ChatGPT", 2],
      ['No longer named for "best pizza near me" on Claude', 1],
    ]);
  });

  it("keeps apart drops that different scans raised", () => {
    const groups = groupAlerts([
      alert(),
      alert({
        id: "00000000-0000-4000-8000-0000000000a2",
        tracked_query_id: PASTA,
        scan_id: "00000000-0000-4000-8000-0000000000c2",
      }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("calls them keywords where the surface is searched, not asked", () => {
    const [group] = groupAlerts([
      alert({ surface: "google_local_pack" }),
      alert({
        id: "00000000-0000-4000-8000-0000000000a2",
        tracked_query_id: PASTA,
        surface: "google_local_pack",
      }),
    ]);
    expect(group?.title).toBe("No longer named for 2 keywords on Map pack");
  });
});
