import { describe, expect, it } from "vitest";
import {
  type AlertCheck,
  type AlertScan,
  alertDetail,
  alertEnded,
  alertTitle,
  type CurrentAlert,
  deriveAlerts,
  groupAlerts,
  hasNewcomers,
  type SeenBefore,
} from "../src/alerts";
import type { Alert, DropAlert, Surface } from "../src/schemas";

const PIZZA = "00000000-0000-4000-8000-000000000001";
const PASTA = "00000000-0000-4000-8000-000000000002";
const PROMPTS = [
  { id: PIZZA, text: "best pizza near me" },
  { id: PASTA, text: "fresh pasta downtown" },
];
const WEBSITE = "https://joes.example";
const ON_FILE = "+19195550100";
/** What the rules are told of the location, whatever the test is about. */
const ABOUT = { prompts: PROMPTS, website: WEBSITE, phone: ON_FILE, country_code: "US" };

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
        return mark
          ? [
              {
                tracked_query_id: query,
                surface,
                mentioned: mark === "T",
                competitors: [],
                cited_urls: [],
                phones: [],
              },
            ]
          : [];
      }),
    });
  }
  return scans.reverse();
}

/** The rules over a window of drops alone: nothing in it could be a first sighting. */
const derive = (scans: AlertScan[], current: CurrentAlert[] = []) =>
  deriveAlerts({ ...ABOUT, scans, current, seen: null });

const current = (query: string, raisedBy: string | null, surface: Surface = "chatgpt") =>
  ({
    id: `alert-${query}`,
    kind: "drop",
    tracked_query_id: query,
    surface,
    scan_id: raisedBy,
  }) satisfies CurrentAlert;

describe("deriveAlerts: raising a drop", () => {
  it("raises one when three checks in a row missed and the four before all named it", () => {
    const { raise, clear } = derive(windowOf({ [PIZZA]: "TTTTFFF" }));

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
    const [alert] = derive(windowOf({ [PIZZA]: "TFTTFFF" })).raise;
    expect(alert?.facts).toMatchObject({ missed: 3, checks_before: 4, named_before: 3 });
  });

  it.each([
    ["only two misses", "TTTTTFF"],
    ["a miss, a mention and a miss", "TTTTFTF"],
    ["named in two of the four before", "TFFTFFF"],
    ["never named", "FFFFFFF"],
    ["named in the newest check", "TTTFFFT"],
  ])("raises nothing for %s", (_, history) => {
    expect(derive(windowOf({ [PIZZA]: history })).raise).toEqual([]);
  });

  it("raises nothing until the cell has a full window, however it reads", () => {
    expect(derive(windowOf({ [PIZZA]: "TTTFFF" })).raise).toEqual([]);
    // A prompt added three scans ago, beside one that has been asked all along.
    expect(derive(windowOf({ [PASTA]: "TTTTTTT", [PIZZA]: "FFF" })).raise).toEqual([]);
  });

  it("says the whole run when the drop is older than three checks", () => {
    // Four misses: the alert could not be raised at the third, so it dates from the first.
    const [alert] = derive(windowOf({ [PIZZA]: "TTTFFFF" })).raise;
    expect(alert?.facts).toMatchObject({ missed: 4, checks_before: 3, named_before: 3 });
    expect(alert?.since).toBe("2026-10-04T09:00:00Z");
  });

  it("raises nothing for a drop older than the window can show", () => {
    expect(derive(windowOf({ [PIZZA]: "TTFFFFF" })).raise).toEqual([]);
  });

  it("judges each prompt on each surface by itself", () => {
    const scans = windowOf({ [PIZZA]: "TTTTFFF", [PASTA]: "TTTTTTT" });
    expect(derive(scans).raise.map((alert) => alert.subject)).toEqual([`${PIZZA}|chatgpt`]);
  });

  it("does not raise a second while one for the same thing is current, dismissed or not", () => {
    const scans = windowOf({ [PIZZA]: "TTTFFFF" });
    // Raised by the scan before this one. Whether a member dismissed it makes no difference
    // here: the rule is not told, and a dismissed alert is still current.
    expect(derive(scans, [current(PIZZA, "scan-6")])).toEqual({ clear: [], raise: [] });
  });
});

describe("deriveAlerts: clearing a drop", () => {
  it("clears one when a check since it was raised names the business", () => {
    const scans = windowOf({ [PIZZA]: "TTTFFFT" });
    expect(derive(scans, [current(PIZZA, "scan-6")])).toEqual({
      clear: [{ id: `alert-${PIZZA}`, reason: "named_again" }],
      raise: [],
    });
  });

  it("is not cleared by the checks that named it before it was raised", () => {
    const scans = windowOf({ [PIZZA]: "TTTFFFF" });
    // Raised by the sixth scan, at the third miss: everything that named the business is older.
    expect(derive(scans, [current(PIZZA, "scan-6")]).clear).toEqual([]);
  });

  it("is cleared by a scan that named it even if the newest did not", () => {
    // A scan finished without the rules running, named the business, and the next did not.
    const scans = windowOf({ [PIZZA]: "TTFFFTF" });
    expect(derive(scans, [current(PIZZA, "scan-5")]).clear).toEqual([
      { id: `alert-${PIZZA}`, reason: "named_again" },
    ]);
  });

  it("never clears by age: seven misses on, it is still current", () => {
    const scans = windowOf({ [PIZZA]: "FFFFFFF" });
    // The scan that raised it has left the window, and nothing in the window named the business.
    expect(derive(scans, [current(PIZZA, "scan-long-ago")])).toEqual({ clear: [], raise: [] });
  });

  it("clears one whose scan has left the window as soon as any check names the business", () => {
    const scans = windowOf({ [PIZZA]: "FFFFFFT" });
    expect(derive(scans, [current(PIZZA, "scan-long-ago")]).clear).toEqual([
      { id: `alert-${PIZZA}`, reason: "named_again" },
    ]);
  });

  it("clears one whose prompt is no longer asked, or whose surface is no longer checked", () => {
    const scans = windowOf({ [PASTA]: "TTTTTTT" });
    const changes = derive(scans, [current(PIZZA, "scan-6"), current(PASTA, "scan-6", "claude")]);
    expect(changes.clear).toEqual([
      { id: `alert-${PIZZA}`, reason: "not_tracked" },
      { id: `alert-${PASTA}`, reason: "not_tracked" },
    ]);
  });

  it("does not raise again what it has just cleared", () => {
    const scans = windowOf({ [PIZZA]: "TTTFFFT" });
    expect(derive(scans, [current(PIZZA, "scan-6")]).raise).toEqual([]);
  });

  it("changes nothing without a scan", () => {
    expect(derive([], [current(PIZZA, "scan-6")])).toEqual({ clear: [], raise: [] });
  });
});

/** One answer: who it named besides the business, and the pages it cited. */
interface Answer {
  names?: string[];
  urls?: string[];
  phones?: string[];
  query?: string;
  surface?: Surface;
  mentioned?: boolean;
}

const TONYS: Answer = {
  names: ["Tony's Slice House"],
  urls: ["https://www.yelp.com/biz/tonys"],
};

/**
 * A full window, newest first. `latest` is the newest scans' answers, newest scan first, and
 * every scan before them gave two answers naming the usual business and citing the usual site.
 */
function answered(latest: Answer[][], length = 7): AlertScan[] {
  const scans = [
    ...latest,
    ...Array.from({ length: length - latest.length }, () => [TONYS, TONYS]),
  ];
  return scans.map((answers, index) => ({
    id: index === 0 ? null : `scan-${length - index}`,
    at: `2026-10-${String(length - index).padStart(2, "0")}T09:00:00Z`,
    checks: answers.map(
      (answer): AlertCheck => ({
        tracked_query_id: answer.query ?? PIZZA,
        surface: answer.surface ?? "chatgpt",
        mentioned: answer.mentioned ?? false,
        competitors: answer.names ?? [],
        cited_urls: answer.urls ?? [],
        phones: answer.phones ?? [],
      }),
    ),
  }));
}

/** What the record held before the latest scans: the usual business and the usual site. */
const SEEN: SeenBefore = {
  competitors: ["Tony's Slice House"],
  origins: ["https://www.yelp.com"],
};

const sightings = (
  scans: AlertScan[],
  options: { seen?: SeenBefore | null; current?: CurrentAlert[] } = {},
) =>
  deriveAlerts({
    ...ABOUT,
    scans,
    current: options.current ?? [],
    seen: options.seen === undefined ? SEEN : options.seen,
  });

const OAK: Answer = { names: ["Oak & Ember"] };

describe("deriveAlerts: a business named for the first time", () => {
  it("raises one for three answers across two of the latest three scans, and none before", () => {
    const scans = answered([
      [OAK, { ...OAK, surface: "claude" }, TONYS],
      [TONYS, TONYS],
      [{ ...OAK, query: PASTA }, TONYS],
    ]);

    expect(sightings(scans)).toEqual({
      clear: [],
      raise: [
        {
          kind: "competitor",
          subject: "oak and ember",
          facts: {
            name: "Oak & Ember",
            answers: 3,
            scans: 2,
            of_scans: 3,
            places: [
              { prompt: "best pizza near me", surfaces: ["chatgpt", "claude"] },
              { prompt: "fresh pasta downtown", surfaces: ["chatgpt"] },
            ],
            prompts: 2,
          },
          // The oldest of the latest scans that named it.
          since: "2026-10-05T09:00:00Z",
        },
      ],
    });
  });

  it.each([
    ["two answers", [[OAK], [OAK], [TONYS]]],
    ["three answers in one scan", [[OAK, OAK, OAK], [TONYS], [TONYS]]],
    ["answers older than the latest three scans", [[OAK], [TONYS], [TONYS], [OAK, OAK]]],
    ["a business the rest of the window named", [[OAK, OAK], [OAK], [TONYS], [TONYS], [OAK]]],
  ])("raises nothing for %s", (_, latest) => {
    expect(sightings(answered(latest)).raise).toEqual([]);
  });

  it("raises nothing for a business an earlier scan on record named, however it was written", () => {
    const scans = answered([[OAK, OAK], [OAK]]);
    expect(sightings(scans).raise).toHaveLength(1);
    for (const old of ["Oak & Ember", "oak and ember llc", "Oak & Ember Steakhouse - Raleigh"]) {
      const seen = { ...SEEN, competitors: [...SEEN.competitors, old] };
      expect(sightings(scans, { seen }).raise, old).toEqual([]);
    }
  });

  it("gathers the ways one business is written, and calls it what it is most often called", () => {
    const scans = answered([
      [{ names: ["Oak & Ember"] }, { names: ["Oak and Ember"] }],
      [{ names: ["Oak & Ember Steakhouse"] }, { names: ["Oak & Ember"] }],
    ]);
    const [alert] = sightings(scans).raise;
    expect(alert?.facts).toMatchObject({ name: "Oak & Ember", answers: 4, scans: 2 });
  });

  it("counts an answer once, however it writes the business", () => {
    const scans = answered([[{ names: ["Oak & Ember", "Oak and Ember"] }], [OAK]]);
    expect(sightings(scans).raise).toEqual([]);
  });

  it("counts only written answers, not the lists of results", () => {
    const listed = { ...OAK, surface: "google_local_pack" as const };
    expect(sightings(answered([[listed, listed], [listed]])).raise).toEqual([]);
    // An AI Overview is a written answer.
    const overview = { ...OAK, surface: "google_ai_overview" as const };
    expect(sightings(answered([[overview, overview], [overview]])).raise).toHaveLength(1);
  });

  it("raises nothing until the location has a full window of scans on record", () => {
    const latest = [[OAK, OAK], [OAK]];
    expect(sightings(answered(latest, 6)).raise).toEqual([]);
    expect(sightings(answered(latest, 7)).raise).toHaveLength(1);
  });

  it("raises nothing when the record before was not read", () => {
    expect(sightings(answered([[OAK, OAK], [OAK]]), { seen: null }).raise).toEqual([]);
  });

  it("lists three of the prompts it was named for, and counts the rest", () => {
    const more = ["a", "b", "c", "d"].map((letter) => ({ ...OAK, query: `prompt-${letter}` }));
    const [alert] = sightings(answered([more, [OAK, OAK]])).raise;
    expect(alert?.facts).toMatchObject({ prompts: 5 });
    if (alert?.kind !== "competitor") throw new Error("not a business");
    expect(alert.facts.places).toHaveLength(3);
    // The prompt with the most answers comes first.
    expect(alert.facts.places[0]).toEqual({ prompt: "best pizza near me", surfaces: ["chatgpt"] });
  });

  it("does not raise a second while one for the same business is current", () => {
    const scans = answered([[OAK, OAK], [OAK]]);
    const raised = {
      id: "alert-oak",
      kind: "competitor",
      facts: { name: "Oak and Ember" },
      scan_id: "scan-6",
    } as CurrentAlert;
    expect(sightings(scans, { current: [raised] })).toEqual({ clear: [], raise: [] });
  });
});

describe("deriveAlerts: a site read for the first time", () => {
  const BLOG = { urls: ["https://raleighfood.example/best-pizza"] };

  it("raises one for three answers across two of the latest three scans, and none before", () => {
    const scans = answered([
      [BLOG, { urls: ["https://www.raleighfood.example/guide"], mentioned: true }, TONYS],
      [{ urls: ["https://raleighfood.example/best-pizza", "https://raleighfood.example/2"] }],
    ]);

    expect(sightings(scans).raise).toEqual([
      {
        kind: "site",
        subject: "raleighfood.example",
        facts: {
          host: "raleighfood.example",
          answers: 3,
          scans: 2,
          of_scans: 3,
          // One of the three answers that cited it named the business.
          named: 1,
          own: false,
          url: "https://raleighfood.example/best-pizza",
        },
        since: "2026-10-06T09:00:00Z",
      },
    ]);
  });

  it("raises nothing for a site an earlier scan cited, by any of its pages or addresses", () => {
    const scans = answered([[BLOG, BLOG], [BLOG]]);
    for (const origin of [
      "https://raleighfood.example",
      "http://www.raleighfood.example",
      "https://m.raleighfood.example:8443",
    ]) {
      const seen = { ...SEEN, origins: [...SEEN.origins, origin] };
      expect(sightings(scans, { seen }).raise, origin).toEqual([]);
    }
  });

  it("says the business's own website apart", () => {
    const own = { urls: [`${WEBSITE}/menu`], mentioned: true };
    const [alert] = sightings(answered([[own, own], [own]])).raise;
    expect(alert).toMatchObject({
      kind: "site",
      subject: "joes.example",
      facts: { host: "joes.example", own: true, answers: 3, named: 3 },
    });
  });

  it("does not say a competitor's own website as a site", () => {
    const withSite = { names: ["Oak & Ember"], urls: ["https://oak-ember.example/"] };
    const { raise } = sightings(answered([[withSite, withSite], [withSite]]));
    // The business is said. Its website would only say it again.
    expect(raise.map((alert) => alert.kind)).toEqual(["competitor"]);
  });

  it("raises nothing for two answers, one scan, a short record or an unread one", () => {
    expect(sightings(answered([[BLOG], [BLOG]])).raise).toEqual([]);
    expect(sightings(answered([[BLOG, BLOG, BLOG]])).raise).toEqual([]);
    expect(sightings(answered([[BLOG, BLOG], [BLOG]], 6)).raise).toEqual([]);
    expect(sightings(answered([[BLOG, BLOG], [BLOG]]), { seen: null }).raise).toEqual([]);
  });
});

describe("deriveAlerts: clearing a first sighting", () => {
  const raisedBy = (scan: string | null) =>
    [
      { id: "alert-oak", kind: "competitor", facts: { name: "Oak & Ember" }, scan_id: scan },
      { id: "alert-blog", kind: "site", facts: { host: "raleighfood.example" }, scan_id: scan },
    ] as CurrentAlert[];

  it("leaves one alone while the scan that raised it is in the window", () => {
    // The oldest scan in a window of seven: six more have passed.
    expect(sightings(answered([]), { current: raisedBy("scan-1") }).clear).toEqual([]);
  });

  it("clears one as old news once seven more scans have passed", () => {
    expect(sightings(answered([]), { current: raisedBy("scan-0") }).clear).toEqual([
      { id: "alert-oak", reason: "old_news" },
      { id: "alert-blog", reason: "old_news" },
    ]);
  });

  it("is not ended by the business going unnamed, or the site uncited", () => {
    const scans = answered([[TONYS], [TONYS], [TONYS]]);
    expect(sightings(scans, { current: raisedBy("scan-4") })).toEqual({ clear: [], raise: [] });
  });
});

describe("deriveAlerts: a phone number that is not the location's", () => {
  const OTHER = "+19195550199";
  const wrong: Answer = { phones: [OTHER] };
  const given = (
    scans: AlertScan[],
    options: { phone?: string | null; current?: CurrentAlert[] } = {},
  ) =>
    deriveAlerts({
      ...ABOUT,
      scans,
      current: options.current ?? [],
      seen: null,
      phone: options.phone === undefined ? ON_FILE : options.phone,
    });
  const raised = (dismissed: string | null = null) =>
    ({
      id: "alert-number",
      kind: "phone",
      facts: { number: OTHER },
      scan_id: "scan-6",
      dismissed_at: dismissed,
    }) as CurrentAlert;

  it("is raised when answers in two scans of the window give the same other number", () => {
    const scans = answered([[wrong, TONYS], [TONYS], [TONYS], [{ ...wrong, surface: "claude" }]]);

    expect(given(scans)).toEqual({
      clear: [],
      raise: [
        {
          kind: "phone",
          subject: OTHER,
          facts: {
            number: OTHER,
            on_file: ON_FILE,
            country_code: "US",
            answers: 2,
            scans: 2,
            of_scans: 7,
            places: [{ prompt: "best pizza near me", surfaces: ["chatgpt", "claude"] }],
            prompts: 1,
          },
          // The oldest scan in the window that gave it.
          since: "2026-10-04T09:00:00Z",
        },
      ],
    });
  });

  it.each([
    ["one answer", [[wrong]]],
    ["two answers in one scan", [[wrong, wrong]]],
    ["the number on file", [[{ phones: [ON_FILE] }], [{ phones: [ON_FILE] }]]],
    ["two different numbers, once each", [[wrong], [{ phones: ["+19195550177"] }]]],
  ])("is not raised for %s", (_, latest) => {
    expect(given(answered(latest)).raise).toEqual([]);
  });

  it("is not raised where no number is on file to differ from", () => {
    expect(given(answered([[wrong], [wrong]]), { phone: null }).raise).toEqual([]);
  });

  it("counts an answer once, however often it gives the number", () => {
    const twice: Answer = { phones: [OTHER, OTHER] };
    expect(given(answered([[twice]])).raise).toEqual([]);
    expect(given(answered([[twice], [twice]])).raise[0]?.facts).toMatchObject({
      answers: 2,
      scans: 2,
    });
  });

  it("is not raised a second time while one for the number is current", () => {
    expect(given(answered([[wrong], [wrong]]), { current: [raised()] })).toEqual({
      clear: [],
      raise: [],
    });
  });

  it("is cleared when no answer in the window gives the number any more", () => {
    expect(given(answered([]), { current: [raised()] }).clear).toEqual([
      { id: "alert-number", reason: "no_longer_given" },
    ]);
    // One answer is enough to keep it: it took two to raise, and it has not gone away.
    expect(given(answered([[TONYS], [wrong]]), { current: [raised()] }).clear).toEqual([]);
  });

  it("is cleared when the number becomes the one on file, or none is on file", () => {
    const scans = answered([[wrong], [wrong]]);
    expect(given(scans, { current: [raised()], phone: OTHER })).toEqual({
      clear: [{ id: "alert-number", reason: "now_on_file" }],
      raise: [],
    });
    expect(given(scans, { current: [raised()], phone: null })).toEqual({
      clear: [{ id: "alert-number", reason: "not_tracked" }],
      raise: [],
    });
  });

  it("is never cleared once a member has said the number is theirs, so never raised again", () => {
    const dismissed = [raised("2026-10-08T09:00:00Z")];
    // The answers stop giving it.
    expect(given(answered([]), { current: dismissed })).toEqual({ clear: [], raise: [] });
    // And give it again, months on.
    expect(given(answered([[wrong], [wrong]]), { current: dismissed })).toEqual({
      clear: [],
      raise: [],
    });
  });
});

describe("hasNewcomers", () => {
  it("says whether the record before the latest scans needs reading", () => {
    // Named often enough, and nowhere in the rest of the window. The record may still hold it.
    expect(hasNewcomers(answered([[OAK, OAK], [OAK]]), WEBSITE)).toBe(true);
    // The business every scan names: the window alone says it is not new.
    expect(hasNewcomers(answered([[TONYS, TONYS], [TONYS]]), WEBSITE)).toBe(false);
    // Not often enough, or too short a record for anything to be new.
    expect(hasNewcomers(answered([[OAK], [OAK]]).slice(0, 2), WEBSITE)).toBe(false);
    expect(hasNewcomers(answered([[OAK, OAK], [OAK]], 6), WEBSITE)).toBe(false);
    expect(hasNewcomers(windowOf({ [PIZZA]: "TTTTFFF" }), WEBSITE)).toBe(false);
  });
});

const alert = (overrides: Partial<DropAlert> = {}): DropAlert => ({
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

const row = {
  id: "00000000-0000-4000-8000-0000000000a9",
  location_id: "00000000-0000-4000-8000-0000000000b1",
  since: "2026-10-05T09:00:00Z",
  scan_id: "00000000-0000-4000-8000-0000000000c1",
  raised_at: "2026-10-07T09:00:00Z",
  cleared_at: null,
  clear_reason: null,
  dismissed_at: null,
  dismissed_by_email: null,
};
const business = (facts: Partial<Extract<Alert, { kind: "competitor" }>["facts"]> = {}): Alert => ({
  ...row,
  kind: "competitor",
  facts: {
    name: "Oak & Ember",
    answers: 4,
    scans: 2,
    of_scans: 3,
    places: [
      { prompt: "best pizza near me", surfaces: ["chatgpt", "claude"] },
      { prompt: "fresh pasta downtown", surfaces: ["chatgpt"] },
    ],
    prompts: 2,
    ...facts,
  },
});
const site = (facts: Partial<Extract<Alert, { kind: "site" }>["facts"]> = {}): Alert => ({
  ...row,
  kind: "site",
  facts: {
    host: "raleighfood.example",
    answers: 3,
    scans: 2,
    of_scans: 3,
    named: 0,
    own: false,
    url: "https://raleighfood.example/best-pizza",
    ...facts,
  },
});

const number = (facts: Partial<Extract<Alert, { kind: "phone" }>["facts"]> = {}): Alert => ({
  ...row,
  kind: "phone",
  facts: {
    number: "+19195550199",
    on_file: "+19195550100",
    country_code: "US",
    answers: 2,
    scans: 2,
    of_scans: 7,
    places: [{ prompt: "best pizza near me", surfaces: ["chatgpt"] }],
    prompts: 1,
    ...facts,
  },
});

const day = (iso: string) => iso.slice(0, 10);

describe("what an alert says", () => {
  it("names the prompt and the surface of a drop, and states what was counted", () => {
    expect(alertTitle(alert())).toBe('No longer named for "best pizza near me" on ChatGPT');
    expect(alertDetail(alert(), day)).toBe(
      "Since 2026-10-05. It was named in 4 of the 4 checks before that and in none of the 3 since.",
    );
  });

  it("names a business seen for the first time, and where it was named", () => {
    expect(alertTitle(business())).toBe("Oak & Ember is named for the first time");
    expect(alertDetail(business(), day)).toBe(
      'Since 2026-10-05. Named in 4 answers across 2 of the last 3 scans, and in no answer before. It was named for "best pizza near me" on ChatGPT and Claude; "fresh pasta downtown" on ChatGPT.',
    );
    expect(alertDetail(business({ prompts: 4 }), day)).toMatch(/on ChatGPT; and 2 more prompts\.$/);
    expect(alertDetail(business({ prompts: 3 }), day)).toMatch(/; and 1 more prompt\.$/);
  });

  it("names a site read for the first time, and whether its answers named the business", () => {
    expect(alertTitle(site())).toBe("raleighfood.example is read for the first time");
    expect(alertDetail(site(), day)).toBe(
      "Since 2026-10-05. Cited in 3 answers across 2 of the last 3 scans, and in no answer before. None of those answers named the business.",
    );
    expect(alertDetail(site({ named: 1 }), day)).toMatch(
      / 1 of those 3 answers named the business\.$/,
    );
    expect(alertDetail(site({ named: 3 }), day)).toMatch(
      / All 3 of those answers named the business\.$/,
    );
  });

  it("gives the other phone number as it is written where the business is, beside the one on file", () => {
    expect(alertTitle(number())).toBe("The answers give a different phone number: (919) 555-0199");
    expect(alertDetail(number(), day)).toBe(
      'Since 2026-10-05. Given for the business in 2 answers across 2 of the last 7 scans. The number on file is (919) 555-0100. It was given for "best pizza near me" on ChatGPT.',
    );
    // A number from another country keeps its country code.
    expect(alertTitle(number({ number: "+442079460958" }))).toBe(
      "The answers give a different phone number: +44 20 7946 0958",
    );
  });

  it("says the business's own website as its own", () => {
    expect(alertTitle(site({ own: true, named: 3 }))).toBe(
      "Your website is read for the first time",
    );
    expect(alertDetail(site({ own: true, named: 3 }), day)).toBe(
      "Since 2026-10-05. Cited in 3 answers across 2 of the last 3 scans, and in no answer before.",
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

  it("leaves a first sighting to stand alone, whatever scan raised it", () => {
    const groups = groupAlerts([
      business(),
      { ...site(), id: "00000000-0000-4000-8000-0000000000aa" },
      alert(),
    ]);
    expect(groups.map((group) => group.title)).toEqual([
      "Oak & Ember is named for the first time",
      "raleighfood.example is read for the first time",
      'No longer named for "best pizza near me" on ChatGPT',
    ]);
  });
});
