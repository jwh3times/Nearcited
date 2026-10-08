import { describe, expect, it } from "vitest";
import type { Finding } from "../src/analysis";
import {
  auditScore,
  buildAuditCell,
  type StoredAudit,
  StoredAuditSchema,
  toPublicAudit,
} from "../src/audit";

const finding = (position: number | null | "unranked", change: Partial<Finding> = {}): Finding => ({
  mentioned: position !== null,
  position: typeof position === "number" ? position : null,
  competitors: [],
  cited_urls: [],
  answer_excerpt: null,
  ...change,
});

describe("buildAuditCell", () => {
  it("counts how often the business was named and where", () => {
    const cell = buildAuditCell("chatgpt", [
      finding(1),
      finding(null),
      finding(3),
      finding("unranked"),
      finding(null),
    ]);
    expect(cell).toMatchObject({ surface: "chatgpt", checks: 5, mentions: 3, positions: [1, 3] });
    // 1st is worth 1, 3rd 0.65, and named without a rank 0.6.
    expect(cell.weight).toBeCloseTo(2.25, 5);
  });

  it("tallies who else was named, most often first, ties by name", () => {
    const cell = buildAuditCell("claude", [
      finding(null, { competitors: ["Tony's", "Alpha"] }),
      finding(null, { competitors: ["Tony's", "Zed"] }),
      finding(1, { competitors: ["Tony's"] }),
    ]);
    expect(cell.competitors).toEqual([
      { name: "Tony's", count: 3 },
      { name: "Alpha", count: 1 },
      { name: "Zed", count: 1 },
    ]);
  });

  it("quotes an answer that names the business, with the pages that answer cited", () => {
    const cell = buildAuditCell("chatgpt", [
      finding(null, { answer_excerpt: "Try Tony's.", cited_urls: ["https://tonys.example"] }),
      finding(2, { answer_excerpt: "Try Tony's or Joe's.", cited_urls: ["https://joes.example"] }),
    ]);
    expect(cell.excerpt).toBe("Try Tony's or Joe's.");
    expect(cell.cited_urls).toEqual(["https://joes.example"]);
  });

  it("falls back to any answer when none named the business", () => {
    const cell = buildAuditCell("chatgpt", [
      finding(null),
      finding(null, { answer_excerpt: "Try Tony's.", cited_urls: ["https://tonys.example"] }),
    ]);
    expect(cell.excerpt).toBe("Try Tony's.");
    expect(cell.cited_urls).toEqual(["https://tonys.example"]);
  });

  it("counts the sites every answer cited, not only the quoted one", () => {
    const cell = buildAuditCell(
      "chatgpt",
      [
        finding(null, { cited_urls: ["https://reviews.example/a"] }),
        finding(1, { cited_urls: ["https://reviews.example/a", "https://joes.example/menu"] }),
      ],
      undefined,
      "https://joes.example",
    );
    expect(cell.sources.map((site) => [site.host, site.answers, site.named, site.own])).toEqual([
      ["reviews.example", 2, 1, false],
      ["joes.example", 1, 1, true],
    ]);
  });

  it("uses the weights it is given", () => {
    const flat = { unranked: 1, by_position: [{ through: 10, weight: 0.5 }], beyond: 0 };
    expect(buildAuditCell("chatgpt", [finding(2), finding(2)], flat).weight).toBe(1);
  });
});

describe("auditScore", () => {
  it("is null with nothing answered", () => {
    expect(auditScore([])).toBeNull();
    expect(auditScore([{ cells: [] }])).toBeNull();
  });

  it("averages each cell over its own checks, then averages the cells", () => {
    const first = buildAuditCell("chatgpt", [finding(1), finding(1), finding(1), finding(1)]);
    const never = buildAuditCell("claude", [finding(null), finding(null)]);
    // One cell at 1.0 and one at 0: the mean of the cells, not 4 hits in 6 checks.
    expect(auditScore([{ cells: [first, never] }])).toBe(50);
    expect(auditScore([{ cells: [first] }, { cells: [never] }])).toBe(50);
  });
});

describe("toPublicAudit", () => {
  const cell = buildAuditCell("chatgpt", [finding(1), finding(null)]);
  const stored: StoredAudit = {
    business_name: "Joe's Pizza",
    website: "https://joes.example",
    city: "Raleigh",
    region: "NC",
    prompts: ["best pizza", "pizza delivery", "late night food"],
    samples: 2,
    status: "queued",
    // The second prompt finished before the first; the third has not reported.
    parts: { "1": { cells: [cell] } },
    created_at: "2026-10-07T00:00:00Z",
    expires_at: "2026-11-06T00:00:00Z",
  };

  it("lines each prompt up with its results, leaving unfinished ones empty", () => {
    const audit = toPublicAudit(stored);
    expect(audit.prompts.map((prompt) => [prompt.text, prompt.cells?.length ?? null])).toEqual([
      ["best pizza", null],
      ["pizza delivery", 1],
      ["late night food", null],
    ]);
  });

  it("scores over the prompts answered so far", () => {
    expect(toPublicAudit(stored).score).toBe(50);
    expect(toPublicAudit({ ...stored, parts: {} }).score).toBeNull();
  });

  it("adds up the cited sites across prompts and assistants", () => {
    const sourced = (surface: "chatgpt" | "claude") =>
      buildAuditCell(surface, [finding(null, { cited_urls: ["https://reviews.example/a"] })]);
    const audit = toPublicAudit({
      ...stored,
      parts: { "0": { cells: [sourced("chatgpt"), sourced("claude")] }, "1": { cells: [cell] } },
    });
    expect(audit.sources).toMatchObject([{ host: "reviews.example", answers: 2, named: 0 }]);
  });

  it("reads an audit stored before sites were counted", () => {
    const { sources: _sources, ...old } = cell;
    const parsed = StoredAuditSchema.parse({ ...stored, parts: { "0": { cells: [old] } } });
    expect(toPublicAudit(parsed).sources).toEqual([]);
  });

  it("carries the website check from whichever prompt made it", () => {
    const site = {
      url: "https://joes.example/",
      status: 200,
      checks: [{ id: "reachable" as const, passed: true }],
      blocked_crawlers: [],
      words: 120,
    };
    expect(toPublicAudit(stored).site).toBeNull();
    expect(
      toPublicAudit({ ...stored, parts: { "1": { cells: [cell] }, "0": { cells: [cell], site } } })
        .site,
    ).toEqual(site);
  });

  it("builds the action plan from the report's own evidence", () => {
    const unnamed = buildAuditCell(
      "chatgpt",
      [1, 2].map(() =>
        finding(null, {
          competitors: ["Tony's Slice House"],
          cited_urls: ["https://reviews.example/a"],
        }),
      ),
    );
    const audit = toPublicAudit({ ...stored, parts: { "0": { cells: [unnamed, unnamed] } } });
    expect(audit.actions.map((action) => action.id)).toEqual([
      "fix_website",
      "get_listed",
      "competitors",
    ]);
    expect(audit.actions[0]?.summary).toContain("None of the 4 answers cited joes.example");
    expect(audit.actions[1]?.items).toEqual([
      {
        label: "reviews.example",
        detail: "Cited in 4 of 4 answers",
        url: "https://reviews.example/a",
      },
    ]);
    expect(audit.actions[2]?.items[0]).toMatchObject({
      label: "Tony's Slice House",
      detail: "Named in 4 of 4 answers",
    });
  });

  it("passes on nothing the page does not show", () => {
    expect(Object.keys(toPublicAudit(stored)).sort()).toEqual(
      [
        "actions",
        "business_name",
        "city",
        "created_at",
        "expires_at",
        "prompts",
        "region",
        "samples",
        "score",
        "site",
        "sources",
        "status",
        "website",
      ].sort(),
    );
  });
});
