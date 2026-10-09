import type { ScanResult, TrackedQuery } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import { buildMatrix, markName, ordinal, tallyCompetitors } from "../src/lib/matrix";

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
  mentioned: true,
  position: 1,
  competitors,
  cited_urls: [],
  answer_excerpt: null,
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
            history: [true, false, true],
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
