import { describe, expect, it } from "vitest";
import { deriveRecommendations } from "../src/recommendations";
import type { Surface } from "../src/schemas";
import { mergeSources, summarizeSources } from "../src/sources";

const answer = (mentioned: boolean, ...cited_urls: string[]) => ({ mentioned, cited_urls });

describe("summarizeSources", () => {
  it("counts a site once per answer, and how many of those answers named the business", () => {
    const sources = summarizeSources(
      [
        answer(false, "https://reviews.example/a", "https://reviews.example/b"),
        answer(true, "https://reviews.example/a", "https://guide.example/best"),
        answer(false, "https://guide.example/best"),
        answer(false),
      ],
      null,
    );
    expect(sources).toEqual([
      {
        host: "guide.example",
        answers: 2,
        named: 1,
        own: false,
        urls: ["https://guide.example/best"],
      },
      {
        host: "reviews.example",
        answers: 2,
        named: 1,
        own: false,
        // The page cited by two answers comes first.
        urls: ["https://reviews.example/a", "https://reviews.example/b"],
      },
    ]);
  });

  it("marks the business's own site, subdomains included", () => {
    const sources = summarizeSources(
      [answer(true, "https://order.joes.example/menu", "https://reviews.example/a")],
      "https://www.joes.example",
    );
    expect(sources.map((site) => [site.host, site.own])).toEqual([
      ["order.joes.example", true],
      ["reviews.example", false],
    ]);
  });

  it("ignores anything that is not a web link", () => {
    expect(
      summarizeSources(
        [answer(false, "javascript:alert(1)", "not a url", "", "ftp://x.example")],
        null,
      ),
    ).toEqual([]);
  });

  it("keeps the most cited sites and at most three pages of each", () => {
    const pages = ["1", "2", "3", "4"].map((page) => `https://big.example/${page}`);
    const sources = summarizeSources(
      [answer(false, ...pages), answer(false, ...pages, "https://small.example")],
      null,
      1,
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ host: "big.example", answers: 2 });
    expect(sources[0]?.urls).toHaveLength(3);
  });
});

describe("mergeSources", () => {
  it("adds up the same site from separate sets of answers", () => {
    const first = summarizeSources([answer(false, "https://reviews.example/a")], null);
    const second = summarizeSources(
      [answer(true, "https://reviews.example/b"), answer(true, "https://joes.example")],
      "joes.example",
    );
    expect(mergeSources([first, second])).toEqual([
      {
        host: "reviews.example",
        answers: 2,
        named: 1,
        own: false,
        urls: ["https://reviews.example/a", "https://reviews.example/b"],
      },
      { host: "joes.example", answers: 1, named: 1, own: true, urls: ["https://joes.example"] },
    ]);
    // The inputs are left as they were.
    expect(first[0]?.answers).toBe(1);
  });
});

describe("recommendations from sources", () => {
  const joes = { name: "Joe's Pizza", website: "https://joes.example", google_place_id: "place" };
  const check = (mentioned: boolean, cited_urls: string[], surface: Surface = "chatgpt") => ({
    surface,
    mentioned,
    competitors: [],
    cited_urls,
  });
  const rules = (results: ReturnType<typeof check>[]) =>
    deriveRecommendations(joes, results).map((recommendation) => recommendation.rule);

  it("points at a site the answers keep citing without ever naming the business", () => {
    const results = [
      check(false, ["https://reviews.example/a"]),
      check(false, ["https://reviews.example/b"]),
      check(true, ["https://guide.example/best"]),
      check(true, ["https://guide.example/best"]),
    ];
    const found = deriveRecommendations(joes, results).find(
      (recommendation) => recommendation.rule === "source:reviews.example",
    );
    expect(found?.title).toBe("Check your listing on reviews.example");
    expect(found?.detail).toContain("cited in 2 of 4 assistant answers");
    expect(rules(results)).not.toContain("source:guide.example");
  });

  it("clears once an answer that cites the site names the business", () => {
    const before = [
      check(false, ["https://reviews.example/a"]),
      check(false, ["https://reviews.example/a"]),
    ];
    expect(rules(before)).toContain("source:reviews.example");
    expect(rules([...before, check(true, ["https://reviews.example/a"])])).not.toContain(
      "source:reviews.example",
    );
  });

  it("needs a site to be cited twice, and names at most three sites", () => {
    expect(rules([check(false, ["https://once.example"])])).not.toContain("source:once.example");

    const many = ["a", "b", "c", "d"].map((site) => `https://${site}.example`);
    const sourced = rules([check(false, many), check(false, many)]).filter((rule) =>
      rule.startsWith("source:"),
    );
    expect(sourced).toEqual(["source:a.example", "source:b.example", "source:c.example"]);
  });

  it("says when no answer read the business's own site, and clears when one does", () => {
    const unread = Array.from({ length: 4 }, () => check(false, ["https://reviews.example/a"]));
    const found = deriveRecommendations(joes, unread).find(
      (recommendation) => recommendation.rule === "own_site_uncited",
    );
    expect(found?.detail).toContain("None of the 4 assistant answers cited joes.example");

    expect(rules([...unread, check(true, ["https://www.joes.example/menu"])])).not.toContain(
      "own_site_uncited",
    );
    // Too few answers to say, and nothing to say without a website on file.
    expect(rules(unread.slice(0, 3))).not.toContain("own_site_uncited");
    expect(
      deriveRecommendations({ ...joes, website: null }, unread).map((r) => r.rule),
    ).not.toContain("own_site_uncited");
  });

  it("counts only answers that list their sources, not search rankings", () => {
    const rankings = Array.from({ length: 6 }, () => check(false, [], "google_organic"));
    expect(rules(rankings)).not.toContain("own_site_uncited");
  });
});
