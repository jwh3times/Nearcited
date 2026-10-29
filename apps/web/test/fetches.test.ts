import { describe, expect, it } from "vitest";
import { about, CLOUDFLARE_WORDS, fetchesLede, fetchesShown } from "../src/lib/fetches";

describe("a location's fetches as the page lays them out", () => {
  const fetches = {
    days: [
      { day: "2026-10-27", fetcher: "gptbot", count: 3 },
      { day: "2026-10-28", fetcher: "gptbot", count: 2 },
      { day: "2026-10-28", fetcher: "claudebot", count: 9 },
      { day: "2026-10-28", fetcher: "googlebot", count: 40 },
      // A fetcher a newer build knows and this one does not.
      { day: "2026-10-28", fetcher: "newbot", count: 7 },
    ],
    pages: [
      { fetcher: "gptbot", path: "/menu", count: 1 },
      { fetcher: "gptbot", path: "/", count: 4 },
      { fetcher: "googlebot", path: "/", count: 40 },
    ],
    other_pages: [{ fetcher: "claudebot", count: 9 }],
  };

  it("keeps the assistants' fetchers and the search engines' crawlers apart, the most first", () => {
    const shown = fetchesShown(fetches);
    expect(shown.assistant.total).toBe(14);
    expect(shown.search.total).toBe(40);
    expect(shown.assistant.fetchers.map((f) => [f.name, f.maker, f.total])).toEqual([
      ["ClaudeBot", "Anthropic", 9],
      ["GPTBot", "OpenAI", 5],
    ]);
    expect(shown.search.fetchers.map((f) => f.name)).toEqual(["Googlebot"]);
  });

  it("gives each fetcher its days, newest first, its pages fetched most, and the rest together", () => {
    const gptbot = fetchesShown(fetches).assistant.fetchers.find((f) => f.fetcher === "gptbot");
    expect(gptbot?.days).toEqual([
      { day: "2026-10-28", count: 2 },
      { day: "2026-10-27", count: 3 },
    ]);
    expect(gptbot?.pages).toEqual([
      { path: "/", count: 4 },
      { path: "/menu", count: 1 },
    ]);
    const claudebot = fetchesShown(fetches).assistant.fetchers.find(
      (f) => f.fetcher === "claudebot",
    );
    expect(claudebot?.other).toBe(9);
  });

  it("says each count is about that many", () => {
    expect(about(1240)).toBe("about 1,240");
    expect(fetchesLede(fetchesShown(fetches))).toBe(
      "In the last 30 days assistants' fetchers read your website about 14 times, and search engines' crawlers about 40 times.",
    );
    expect(fetchesLede(fetchesShown({ days: [], pages: [], other_pages: [] }))).toMatch(
      /^No fetcher/,
    );
  });
});

describe("connecting Cloudflare", () => {
  it("says where the token is made and with which permissions", () => {
    const steps = CLOUDFLARE_WORDS.steps.join(" ");
    expect(steps).toContain("API Tokens");
    expect(steps).toContain("Zone, Analytics, Read");
    expect(steps).toContain("Zone, Zone, Read");
  });
});
