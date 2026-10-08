import { describe, expect, it } from "vitest";
import { type ActionPlanInput, buildActionPlan, tallyNames } from "../src/actions";
import type { SiteCheck, SourceSummary } from "../src/schemas";

const source = (host: string, answers: number, named: number, own = false): SourceSummary => ({
  host,
  answers,
  named,
  own,
  urls: [`https://${host}/page`],
});

const site = (...failed: SiteCheck["checks"][number]["id"][]): SiteCheck => ({
  url: "https://joes.example/",
  status: 200,
  checks: (["reachable", "crawlers_allowed", "text_content", "names_city"] as const).map((id) => ({
    id,
    passed: !failed.includes(id),
  })),
  blocked_crawlers: failed.includes("crawlers_allowed") ? ["OAI-SearchBot"] : [],
  words: 120,
});

const plan = (change: Partial<ActionPlanInput> = {}) =>
  buildActionPlan({
    name: "Joe's Pizza",
    website: "https://www.joes.example",
    answers: 20,
    sources: [],
    site: null,
    competitors: [],
    ...change,
  });
const ids = (change: Partial<ActionPlanInput> = {}) => plan(change).map((action) => action.id);
const first = (change: Partial<ActionPlanInput>) => plan(change)[0];

describe("tallyNames", () => {
  it("adds up spellings of one business under the shortest, most named first", () => {
    expect(
      tallyNames([
        { name: "Tony's Slice House, LLC", count: 2 },
        { name: "Zed", count: 4 },
        { name: "Tony's Slice House", count: 3 },
      ]),
    ).toEqual([
      { name: "Tony's Slice House", count: 5 },
      { name: "Zed", count: 4 },
    ]);
    expect(
      tallyNames(
        [
          { name: "A", count: 1 },
          { name: "B", count: 2 },
        ],
        1,
      ),
    ).toEqual([{ name: "B", count: 2 }]);
  });
});

describe("the website step", () => {
  it("joins an uncited site to what the check found, as the reasons", () => {
    const action = first({ site: site("text_content", "crawlers_allowed") });
    expect(action).toMatchObject({
      id: "fix_website",
      title: "Make your website readable to assistants",
    });
    expect(action?.summary).toBe(
      "None of the 20 answers cited joes.example, and the check of its home page found 2 things that would keep an assistant from using it.",
    );
    expect(action?.items.map((item) => item.label)).toEqual([
      "Your website tells assistants to stay out",
      "Your home page has almost no text until scripts run",
    ]);
    expect(action?.items[0]?.detail).toContain("Blocked: OAI-SearchBot.");
  });

  it("says a readable site is simply not being chosen", () => {
    const action = first({ site: site() });
    expect(action?.title).toBe("Your website is readable, but is not being used");
    expect(action?.items).toEqual([]);
  });

  it("gives no reason when the page was not checked", () => {
    expect(first({ site: null })?.summary).toBe(
      "None of the 20 answers cited joes.example. The home page was not checked, so there is no reason to give yet.",
    );
  });

  it("still lists problems on a site that is being cited", () => {
    const action = first({
      sources: [source("joes.example", 3, 3, true)],
      site: site("names_city"),
    });
    expect(action?.title).toBe("Fix what the website check found");
    expect(action?.summary).toContain("cited in 3 of 20 answers, but its home page has 1 thing ");
  });

  it("says nothing when the site is cited and passes, when there is none, or on too few answers", () => {
    expect(ids({ sources: [source("joes.example", 3, 3, true)], site: site() })).toEqual([]);
    expect(ids({ website: null, site: site("text_content") })).toEqual([]);
    expect(ids({ answers: 3 })).toEqual([]);
    // A failed check is worth saying however few answers there are.
    expect(ids({ answers: 0, site: site("reachable") })).toEqual(["fix_website"]);
  });
});

describe("the listings steps", () => {
  const sources = [
    source("yelp.example", 10, 0),
    source("guide.example", 8, 5),
    source("once.example", 1, 0),
    source("maps.example", 6, 6),
    source("joes.example", 2, 2, true),
  ];

  it("sends the business to sites read in answers that never named it", () => {
    const action = plan({ sources }).find((candidate) => candidate.id === "get_listed");
    expect(action?.items).toEqual([
      {
        label: "yelp.example",
        detail: "Cited in 10 of 20 answers",
        url: "https://yelp.example/page",
      },
    ]);
  });

  it("names the sites whose answers did name it, most often first", () => {
    const action = plan({ sources }).find((candidate) => candidate.id === "keep_listings");
    expect(action?.items.map((item) => [item.label, item.detail])).toEqual([
      ["maps.example", "Named you in 6 of the 6 answers that cited it"],
      ["guide.example", "Named you in 5 of the 8 answers that cited it"],
    ]);
  });

  it("never sends the business to a competitor's own website", () => {
    const actions = plan({
      sources: [source("yelp.example", 10, 0), source("tonysslicehouse.example", 9, 0)],
      competitors: [{ name: "Tony's Slice House", count: 12 }],
    });
    expect(actions.find((action) => action.id === "get_listed")?.items).toHaveLength(1);
    expect(actions.find((action) => action.id === "competitors")?.items).toEqual([
      {
        label: "Tony's Slice House",
        detail: "Named in 12 of 20 answers",
        url: "https://tonysslicehouse.example/page",
      },
    ]);
  });

  it("lists at most five sites and three competitors", () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      source(`dir${index}.example`, 9 - index, 0),
    );
    const actions = plan({
      sources: many,
      competitors: ["A", "B", "C", "D"].map((name, index) => ({ name, count: 9 - index })),
    });
    expect(actions.find((action) => action.id === "get_listed")?.items).toHaveLength(5);
    expect(actions.find((action) => action.id === "competitors")?.items).toHaveLength(3);
  });
});

describe("the plan as a whole", () => {
  it("puts the steps in a fixed order", () => {
    expect(
      ids({
        site: site("text_content"),
        sources: [source("yelp.example", 10, 0), source("maps.example", 6, 6)],
        competitors: [{ name: "Tony's Slice House", count: 12 }],
      }),
    ).toEqual(["fix_website", "get_listed", "keep_listings", "competitors"]);
  });

  it("is empty when there is nothing to go on", () => {
    expect(plan({ answers: 0, website: null })).toEqual([]);
  });
});
