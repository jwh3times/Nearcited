import { describe, expect, it } from "vitest";
import type { Recommendation, SourceSummary } from "../src/schemas";
import { sourceKind } from "../src/source-kinds";
import { belongsTo, unnamedSources } from "../src/sources";
import { buildTasks, namedCount, sourceOfRule } from "../src/tasks";

const source = (host: string, answers: number, named: number): SourceSummary => ({
  host,
  answers,
  named,
  own: false,
  urls: [`https://${host}/page`],
});

let next = 0;
const recommendation = (rule: string, fields: Partial<Recommendation> = {}): Recommendation => {
  next += 1;
  return {
    id: `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`,
    location_id: "00000000-0000-4000-8000-0000000000aa",
    scan_id: null,
    rule,
    title: "Title",
    detail: "Detail",
    status: "open",
    acted_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    ...fields,
  };
};

const answer = (mentioned: boolean, ...cited_urls: string[]) => ({ mentioned, cited_urls });

describe("the kind of a source", () => {
  it("knows a listed site and its subdomains", () => {
    expect(sourceKind("yelp.com")).toBe("reviews_unasked");
    expect(sourceKind("m.yelp.com")).toBe("reviews_unasked");
    expect(sourceKind("realestate.usnews.com")).toBe("editorial");
    expect(sourceKind("yellowpages.com")).toBe("directory");
    expect(sourceKind("tripadvisor.com")).toBe("reviews");
    // Its own pages were not read saying a business may ask, so nobody is told to.
    expect(sourceKind("facebook.com")).toBe("directory");
  });

  it("calls everything else unknown, including a site that only ends the same way", () => {
    expect(sourceKind("some-agency.example")).toBe("unknown");
    expect(sourceKind("notyelp.com")).toBe("unknown");
    expect(sourceKind("com")).toBe("unknown");
  });
});

describe("the sites to work on", () => {
  it("are at most three, most cited first, never named, own or a competitor's", () => {
    const sources = [
      { ...source("mine.example", 9, 0), own: true },
      source("maplelanestudio.example", 8, 0),
      source("named.example", 7, 3),
      source("a.example", 6, 0),
      source("b.example", 5, 0),
      source("c.example", 4, 0),
      source("d.example", 3, 0),
      source("once.example", 1, 0),
    ];
    expect(unnamedSources(sources, ["Maple Lane Studio"]).map((site) => site.host)).toEqual([
      "a.example",
      "b.example",
      "c.example",
    ]);
  });
});

describe("a site that looks like a named business's own", () => {
  it('is matched with or without the name\'s "and"', () => {
    expect(belongsTo("oak-ember.example", "Oak & Ember")).toBe(true);
    expect(belongsTo("oakandember.example", "Oak and Ember")).toBe(true);
    expect(belongsTo("theedigital.com", "TheeDigital")).toBe(true);
    expect(belongsTo("yelp.com", "Oak & Ember")).toBe(false);
    // Too short to tell from a coincidence.
    expect(belongsTo("bobs.example", "Bob's")).toBe(false);
  });
});

describe("counting the answers that cited a site", () => {
  it("counts a site once per answer and only the answers that cited it", () => {
    const answers = [
      answer(false, "https://www.yelp.com/a", "https://yelp.com/b"),
      answer(true, "https://yelp.com/a"),
      answer(true, "https://other.example"),
    ];
    expect(namedCount(answers, "yelp.com")).toEqual({ answers: 2, named: 1 });
    expect(namedCount(answers, "nowhere.example")).toEqual({ answers: 0, named: 0 });
  });
});

describe("tasks", () => {
  const build = (
    recommendations: Recommendation[],
    sources: SourceSummary[] = [],
    evidence = new Map(),
  ) => buildTasks({ name: "Tony's", recommendations, sources, answers: 10, evidence });

  it("reads the site out of a source rule and nothing out of any other", () => {
    expect(sourceOfRule("source:yelp.com")).toBe("yelp.com");
    expect(sourceOfRule("site:reachable")).toBeNull();
    expect(sourceOfRule("source:")).toBeNull();
  });

  it("makes one for each source the rule fires for, worded for its kind", () => {
    const tasks = build(
      [
        recommendation("absent:gemini"),
        recommendation("source:yellowpages.com"),
        recommendation("source:yelp.com"),
      ],
      [source("yelp.com", 6, 0), source("yellowpages.com", 4, 0)],
    );
    expect(tasks.map((task) => [task.host, task.kind])).toEqual([
      ["yelp.com", "reviews_unasked"],
      ["yellowpages.com", "directory"],
    ]);
    expect(tasks[0]).toMatchObject({
      title: "Claim and complete your listing on yelp.com",
      summary: "yelp.com was cited in 6 of 10 answers, and none of them named Tony's.",
      url: "https://yelp.com/page",
      open: true,
      acted_at: null,
      before: null,
      since: null,
    });
    expect(tasks[0]?.detail).toContain("does not allow a business to ask for reviews");
  });

  it("never asks for reviews on a site it does not know", () => {
    const [task] = build([recommendation("source:blog.example")], [source("blog.example", 3, 0)]);
    expect(task?.kind).toBe("unknown");
    expect(task?.title).not.toMatch(/review/i);
    expect(task?.detail).not.toMatch(/ask/i);
  });

  it("sets the counts before and since beside a task that was marked", () => {
    const marked = recommendation("source:yelp.com", { acted_at: "2026-10-05T00:00:00.000Z" });
    const evidence = new Map([
      [
        marked.id,
        {
          before: [answer(false, "https://yelp.com/a"), answer(false, "https://yelp.com/a")],
          since: [answer(true, "https://yelp.com/a"), answer(false, "https://other.example")],
        },
      ],
    ]);
    const [task] = build([marked], [source("yelp.com", 2, 0)], evidence);
    expect(task).toMatchObject({
      before: { answers: 2, named: 0 },
      since: { answers: 1, named: 1 },
    });
  });

  it("leaves out a dismissed one, and one that cleared without anyone marking it", () => {
    expect(
      build([
        recommendation("source:a.example", { status: "dismissed" }),
        recommendation("source:b.example", { status: "done" }),
      ]),
    ).toEqual([]);
  });

  it("keeps a marked task whose rule stopped firing, after the open ones, newest first", () => {
    const tasks = build(
      [
        recommendation("source:old.example", {
          status: "done",
          acted_at: "2026-09-01T00:00:00+00:00",
        }),
        recommendation("source:new.example", {
          status: "done",
          acted_at: "2026-10-01T00:00:00.000Z",
        }),
        recommendation("source:open.example"),
      ],
      [source("open.example", 3, 0), source("new.example", 4, 2)],
    );
    expect(tasks.map((task) => task.host)).toEqual(["open.example", "new.example", "old.example"]);
    expect(tasks[1]).toMatchObject({
      open: false,
      summary: "2 of the 4 answers that cited new.example in the latest scans named Tony's.",
    });
    expect(tasks[2]?.summary).toBe(
      "old.example is no longer one of the sites read most for answers that leave Tony's out.",
    );
  });
});
