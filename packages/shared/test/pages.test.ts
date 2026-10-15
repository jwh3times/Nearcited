import { describe, expect, it } from "vitest";
import { type DraftGiven, factsNobodyGave } from "../src/drafts";
import {
  buildPageTasks,
  citesPage,
  MIN_ANSWERS_FOR_PAGE,
  pageClosing,
  pageParts,
  pageRule,
  pageSlug,
  pageToCopy,
  promptOfRule,
  promptsLeftOut,
  readPageAddress,
} from "../src/pages";
import { deriveRecommendations } from "../src/recommendations";
import type { Recommendation, Surface } from "../src/schemas";

const PIZZA = "a0000000-0000-4000-8000-00000000000a";
const PASTA = "b0000000-0000-4000-8000-00000000000b";
const KEYWORD = "c0000000-0000-4000-8000-00000000000c";
const queries = [
  { id: PIZZA, kind: "ai_prompt" as const, text: "late night pizza", is_active: true },
  { id: PASTA, kind: "ai_prompt" as const, text: "fresh pasta", is_active: true },
  { id: KEYWORD, kind: "search_keyword" as const, text: "pizza", is_active: true },
];
const ASSISTANTS: Surface[] = ["chatgpt", "gemini", "perplexity", "claude"];

/** One answer from each assistant to a prompt, named or not, citing what it cites. */
const answers = (queryId: string, mentioned = false, cited: string[] = []) =>
  ASSISTANTS.map((surface) => ({
    tracked_query_id: queryId,
    surface,
    mentioned,
    competitors: [],
    cited_urls: cited,
  }));

const joes = { name: "Joe's Pizza", website: "https://joespizza.example", google_place_id: "p" };

describe("which prompts want a page", () => {
  it("is each active assistant prompt none of at least four answers named the business for", () => {
    const results = [...answers(PIZZA), ...answers(PASTA, true)];
    expect(promptsLeftOut(joes.website, queries, results)).toEqual([
      { query: queries[0], answers: 4 },
    ]);
  });

  it("is none on too few answers, for a keyword, for a retired prompt, or with no website", () => {
    const few = answers(PIZZA).slice(0, MIN_ANSWERS_FOR_PAGE - 1);
    expect(promptsLeftOut(joes.website, queries, few)).toEqual([]);
    const searched = answers(KEYWORD).map((answer) => ({
      ...answer,
      surface: "google_organic" as const,
    }));
    expect(promptsLeftOut(joes.website, queries, searched)).toEqual([]);
    const retired = queries.map((query) => ({ ...query, is_active: false }));
    expect(promptsLeftOut(joes.website, retired, answers(PIZZA))).toEqual([]);
    expect(promptsLeftOut(null, queries, answers(PIZZA))).toEqual([]);
  });

  it("is raised as a recommendation, which clears when an answer to the prompt names the business", () => {
    const raised = deriveRecommendations(joes, answers(PIZZA), null, queries).find((r) =>
      r.rule.startsWith("page:"),
    );
    expect(raised).toEqual({
      rule: pageRule(PIZZA),
      title: "Publish a page that answers “late night pizza”",
      detail:
        "None of the 4 assistant answers to “late night pizza” named Joe's Pizza. A page on joespizza.example that answers it in plain words gives an assistant something of yours to read for it. This clears when an answer to it names the business.",
    });
    const named = answers(PIZZA).map((answer, index) => ({ ...answer, mentioned: index === 2 }));
    expect(
      deriveRecommendations(joes, named, null, queries).some((r) => r.rule.startsWith("page:")),
    ).toBe(false);
  });

  it("is read back from the rule", () => {
    expect(promptOfRule(pageRule(PIZZA))).toBe(PIZZA);
    expect(promptOfRule("page:")).toBeNull();
    expect(promptOfRule("source:yelp.com")).toBeNull();
  });
});

const recommendation = (rule: string, extra: Partial<Recommendation> = {}): Recommendation => ({
  id: `${rule}-id`,
  location_id: "l",
  scan_id: null,
  rule,
  title: "t",
  detail: "d",
  status: "open",
  acted_at: null,
  acted_by_action: null,
  created_at: "2026-10-01T00:00:00Z",
  ...extra,
});

describe("the page tasks shown", () => {
  const input = {
    name: "Joe's Pizza",
    queries,
    results: [...answers(PIZZA), ...answers(PASTA)],
    evidence: new Map(),
    drafts: [],
    pages: [],
  };

  it("are the open ones in the order the prompts were added, then the few done since named", () => {
    const tasks = buildPageTasks({
      ...input,
      recommendations: [
        recommendation(pageRule(PASTA)),
        recommendation("source:yelp.com"),
        recommendation(pageRule(PIZZA)),
        recommendation(pageRule(KEYWORD), {
          status: "dismissed",
          acted_at: "2026-10-02T00:00:00Z",
        }),
        recommendation("page:gone"),
      ],
    });
    expect(tasks.map((task) => task.prompt)).toEqual(["late night pizza", "fresh pasta"]);
    expect(tasks[0]?.draft_kind).toBe("page");

    const done = buildPageTasks({
      ...input,
      results: [...answers(PIZZA, true)],
      recommendations: [
        recommendation(pageRule(PIZZA), { status: "done", acted_at: "2026-10-02T00:00:00Z" }),
        recommendation(pageRule(PASTA), { status: "done" }),
      ],
    });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      open: false,
      draft_kind: null,
      summary: "4 of the 4 assistant answers to this prompt in the latest scans named Joe's Pizza.",
    });
  });

  it("offer no copy where it cannot be written", () => {
    const [task] = buildPageTasks({
      ...input,
      recommendations: [recommendation(pageRule(PIZZA))],
      writes: () => false,
    });
    expect(task?.draft_kind).toBeNull();
  });

  it("count the answers either side of the mark, and those since that cited the page", () => {
    const page = "https://joespizza.example/late-night";
    const [task] = buildPageTasks({
      ...input,
      recommendations: [recommendation(pageRule(PIZZA), { acted_at: "2026-10-02T00:00:00Z" })],
      evidence: new Map([
        [
          `${pageRule(PIZZA)}-id`,
          {
            before: answers(PIZZA),
            since: [
              ...answers(PIZZA, true, ["https://www.joespizza.example/late-night/?utm=x"]),
              ...answers(PASTA, true, [page]),
            ],
          },
        ],
      ]),
      pages: [
        {
          recommendation_id: `${pageRule(PIZZA)}-id`,
          url: page,
          set_by_email: null,
          set_at: "2026-10-02T00:00:00Z",
        },
      ],
    });
    expect(task?.before).toEqual({ answers: 4, named: 0, cited: 0 });
    expect(task?.since).toEqual({ answers: 4, named: 4, cited: 4 });
  });
});

describe("a page's address", () => {
  it("is matched by host and path, whatever follows them", () => {
    const page = "https://joespizza.example/late-night";
    expect(citesPage(["http://WWW.joespizza.example/late-night/#x"], page)).toBe(true);
    expect(citesPage(["https://joespizza.example/late-night-menu"], page)).toBe(false);
    expect(citesPage(["https://joespizza.example/"], page)).toBe(false);
  });

  it("is taken from what a member pastes when it is a page of the location's own site", () => {
    const site = "https://www.joespizza.example";
    expect(readPageAddress(site, "joespizza.example/late-night#top")).toEqual({
      url: "https://joespizza.example/late-night",
    });
    expect(readPageAddress(site, "http://shop.joespizza.example/a")).toEqual({
      url: "https://shop.joespizza.example/a",
    });
    expect(readPageAddress(site, "https://notjoespizza.example/a")).toHaveProperty("problem");
    expect(readPageAddress(site, "https://joespizza.example.evil/a")).toEqual({
      problem:
        "That address is not on joespizza.example. Paste the address of the page on your site.",
    });
    expect(readPageAddress(site, "https://joespizza.example/")).toEqual({
      problem: "That is your home page. Paste the address of the page you published.",
    });
    expect(readPageAddress(site, "ftp://joespizza.example/a")).toHaveProperty("problem");
    expect(readPageAddress(site, "https://u:p@joespizza.example/a")).toHaveProperty("problem");
    expect(readPageAddress(null, "https://joespizza.example/a")).toHaveProperty("problem");
    expect(readPageAddress(site, `https://joespizza.example/${"a".repeat(600)}`)).toHaveProperty(
      "problem",
    );
  });
});

describe("a page's copy", () => {
  const text =
    "# Late night pizza in Raleigh\n\nWe make pizza\nlate into the night.\n\n## Where we are\n\nRaleigh, NC.\n";

  it("is read as a title, then headings and paragraphs", () => {
    expect(pageParts(text)).toEqual({
      title: "Late night pizza in Raleigh",
      blocks: [
        { heading: false, text: "We make pizza late into the night." },
        { heading: true, text: "Where we are" },
        { heading: false, text: "Raleigh, NC." },
      ],
    });
    expect(pageParts("")).toEqual({ title: "", blocks: [] });
  });

  it("is copied whole, with the closing line composed from the location's details", () => {
    const closing = pageClosing({
      name: "Joe's Pizza ",
      address_line: "12 Main St",
      city: "Raleigh",
      region: "NC",
      postal_code: "27601",
      phone: "+19195550100",
      country_code: "US",
    });
    expect(closing).toBe("Joe's Pizza, 12 Main St, Raleigh, NC 27601. Call (919) 555-0100.");
    expect(
      pageClosing({
        name: "Joe's Pizza",
        address_line: null,
        city: "Raleigh",
        region: null,
        postal_code: null,
        phone: null,
        country_code: "US",
      }),
    ).toBe("Joe's Pizza, Raleigh.");
    expect(pageToCopy(text, closing)).toBe(
      "Late night pizza in Raleigh\n\nWe make pizza late into the night.\n\nWhere we are\n\nRaleigh, NC.\n\nJoe's Pizza, 12 Main St, Raleigh, NC 27601. Call (919) 555-0100.",
    );
  });

  it("is published at an address made from its title", () => {
    expect(pageSlug("Late-night pizza in Raleigh, NC")).toBe("late-night-pizza-in-raleigh-nc");
    expect(pageSlug("Café Crème — Durham")).toBe("cafe-creme-durham");
    expect(pageSlug("!!!")).toBe("page");
    const long = pageSlug("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("-")).toBe(false);
    expect(pageSlug("a".repeat(80))).toBe("a".repeat(60));
  });

  it("may repeat the prompt, which counts as given", () => {
    const given: DraftGiven = {
      name: "Joe's Pizza",
      city: "Raleigh",
      region: "NC",
      category: null,
      website: "https://joespizza.example",
      what_we_do: "Wood-fired pizza.",
      host: "joespizza.example",
      url: null,
      prompt: "pizza open after 11",
    };
    expect(factsNobodyGave("Pizza open after 11 in Raleigh.", given)).toEqual([]);
    expect(factsNobodyGave("Open until 2 every night.", given)).toEqual(["2"]);
  });
});
