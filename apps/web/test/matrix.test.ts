import type { ScanResult, TrackedQuery } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import {
  buildMatrix,
  historyWords,
  type MatrixCell,
  markName,
  nothingShownLine,
  ordinal,
  readCell,
  tallyCompetitors,
} from "../src/lib/matrix";

const query = (id: string, kind: TrackedQuery["kind"], text: string): TrackedQuery => ({
  id,
  location_id: "loc",
  kind,
  text,
  is_active: true,
  set_aside_by_plan: false,
  created_at: "2026-10-01T00:00:00Z",
});

const result = (
  queryId: string,
  surface: ScanResult["surface"],
  competitors: string[] = [],
): ScanResult => ({
  id: `${queryId}-${surface}`,
  scan_id: "scan",
  tracked_query_id: queryId,
  surface,
  shown: true,
  mentioned: true,
  position: 1,
  competitors,
  cited_urls: [],
  answer_excerpt: null,
  phones: [],
  tier: "standard",
  sampled_at: "2026-10-01T00:00:00Z",
});

describe("buildMatrix", () => {
  it("groups queries by kind and lines results up under that kind's surfaces", () => {
    const groups = buildMatrix(
      [query("p1", "ai_prompt", "best pizza"), query("k1", "search_keyword", "pizza near me")],
      [result("p1", "gemini"), result("k1", "google_local_pack")],
    );

    expect(groups.map((group) => group.kind)).toEqual(["ai_prompt", "search_keyword"]);
    expect(groups[0]?.rows[0]?.cells.map((cell) => [cell.surface, cell.result !== null])).toEqual([
      ["chatgpt", false],
      ["gemini", true],
      ["perplexity", false],
      ["claude", false],
    ]);
    expect(groups[1]?.rows[0]?.cells[0]).toMatchObject({ surface: "google_local_pack" });
    expect(groups[1]?.rows[0]?.cells[0]?.result).not.toBeNull();
  });

  it("attaches the rate over recent scans to each cell that has one", () => {
    const [group] = buildMatrix(
      [query("p1", "ai_prompt", "best pizza")],
      [result("p1", "gemini")],
      {
        size: 7,
        scans: 3,
        cells: [
          {
            tracked_query_id: "p1",
            surface: "gemini",
            checks: 3,
            mentions: 2,
            not_shown: 0,
            history: ["named", "not_named", "named"],
          },
        ],
        answers: 0,
        sources: [],
      },
    );
    const cells = group?.rows[0]?.cells ?? [];
    expect(cells.find((cell) => cell.surface === "gemini")?.rate).toMatchObject({
      checks: 3,
      mentions: 2,
    });
    expect(cells.find((cell) => cell.surface === "chatgpt")?.rate).toBeNull();
  });

  it("drops the column of a surface that is not checked, unless it still has a result", () => {
    const queries = [query("p1", "ai_prompt", "best pizza")];
    const columns = (results: ScanResult[]) =>
      buildMatrix(queries, results, undefined, ["chatgpt", "claude"])[0]?.surfaces;

    expect(columns([])).toEqual(["chatgpt", "claude"]);
    // Gemini is no longer checked, but the latest scan has an answer from it: keep showing it.
    expect(columns([result("p1", "gemini")])).toEqual(["chatgpt", "gemini", "claude"]);
  });

  it("keeps a kind whose surfaces are all unchecked, with no columns", () => {
    const [group] = buildMatrix([query("k1", "search_keyword", "pizza near me")], [], undefined, [
      "chatgpt",
    ]);
    expect(group?.surfaces).toEqual([]);
    expect(group?.rows[0]?.cells).toEqual([]);
  });

  it("leaves out a kind with no queries", () => {
    expect(buildMatrix([query("p1", "ai_prompt", "best pizza")], [])).toHaveLength(1);
    expect(buildMatrix([], [])).toEqual([]);
  });
});

describe("readCell", () => {
  const nothing = (surface: ScanResult["surface"]): ScanResult => ({
    ...result("k1", surface),
    shown: false,
    mentioned: false,
    position: null,
  });
  const rate = (checks: number, mentions: number, not_shown: number) => ({
    checks,
    mentions,
    not_shown,
    history: [],
  });
  const cell = (
    surface: ScanResult["surface"],
    latest: ScanResult | null,
    window: MatrixCell["rate"] = null,
  ): MatrixCell => ({ surface, result: latest, rate: window });

  it("says a surface was not checked when the scan holds nothing for it", () => {
    expect(readCell(cell("chatgpt", null))).toEqual({ kind: "not_checked" });
  });

  it("counts the rate over the checks that showed something", () => {
    expect(readCell(cell("google_organic", result("k1", "google_organic"), rate(4, 3, 2)))).toEqual(
      { kind: "rate", mentions: 3, checks: 4, latest: "Latest 1st" },
    );
  });

  it("says what was missing when the latest search showed nothing, beside the rate", () => {
    expect(
      readCell(cell("google_ai_overview", nothing("google_ai_overview"), rate(2, 1, 1))),
    ).toEqual({ kind: "rate", mentions: 1, checks: 2, latest: "No AI Overview latest" });
  });

  it("says what was missing, in place of a rate, when no search in the window showed anything", () => {
    const words = (surface: ScanResult["surface"], notShown: number) =>
      readCell(cell(surface, nothing(surface), rate(0, 0, notShown)));
    expect(words("google_ai_overview", 5)).toEqual({
      kind: "nothing_shown",
      text: "No AI Overview in the last 5 scans",
    });
    expect(words("google_ai_mode", 2)).toMatchObject({
      text: "No AI Mode answer in the last 2 scans",
    });
    expect(words("google_local_pack", 1)).toMatchObject({
      text: "No map results in the latest scan",
    });
    expect(words("google_organic", 3)).toMatchObject({
      text: "No organic results in the last 3 scans",
    });
  });
});

describe("historyWords", () => {
  it("names each kind of dot, oldest first", () => {
    expect(historyWords(["named", "not_named", "not_shown"])).toBe(
      "Oldest to latest: named, not named, nothing shown",
    );
  });
});

describe("nothingShownLine", () => {
  it("says what Google did not show, when, and that it does not count against the business", () => {
    const line = (surface: ScanResult["surface"]) =>
      nothingShownLine({ surface, sampled_at: "2026-10-18T09:00:00Z" }, "pizza near me");
    expect(line("google_ai_overview")).toMatch(
      /^Google showed no AI Overview for “pizza near me” when it was checked on .+\. This doesn't count against the business\.$/,
    );
    expect(line("google_ai_mode")).toContain("Google gave no AI Mode answer for “pizza near me”");
    expect(line("google_local_pack")).toContain("Google showed no map results for");
    expect(line("google_organic")).toContain("Google showed no organic results for");
  });
});

describe("tallyCompetitors", () => {
  it("counts across results, most named first, ties by name", () => {
    expect(
      tallyCompetitors([
        result("p1", "chatgpt", ["Tony's", "Crust & Co"]),
        result("p1", "gemini", ["Tony's", "Alfie's"]),
      ]),
    ).toEqual([
      { name: "Tony's", count: 2 },
      { name: "Alfie's", count: 1 },
      { name: "Crust & Co", count: 1 },
    ]);
  });
});

describe("ordinal", () => {
  it("handles the teens", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "101st",
      "111th",
    ]);
  });
});

describe("markName", () => {
  it("marks every occurrence, ignoring case, and keeps the original text", () => {
    expect(markName("Try JOE'S PIZZA. Joe's Pizza is good.", "Joe's Pizza")).toEqual([
      { text: "Try ", marked: false },
      { text: "JOE'S PIZZA", marked: true },
      { text: ". ", marked: false },
      { text: "Joe's Pizza", marked: true },
      { text: " is good.", marked: false },
    ]);
  });

  it("returns the text unmarked when the name is absent or empty", () => {
    expect(markName("Try Tony's.", "Joe's Pizza")).toEqual([
      { text: "Try Tony's.", marked: false },
    ]);
    expect(markName("Try Tony's.", "")).toEqual([{ text: "Try Tony's.", marked: false }]);
  });
});
