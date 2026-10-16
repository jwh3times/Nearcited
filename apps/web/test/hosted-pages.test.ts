import type { AnswerSubdomain } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import { fetchesLine, offersPages, removedBecause, windingDown } from "../src/lib/hosted-pages";

const subdomain = (changes: Partial<AnswerSubdomain> = {}): AnswerSubdomain => ({
  connection_id: "c0000000-0000-4000-8000-000000000001",
  location_id: "l0000000-0000-4000-8000-000000000001",
  hostname: "answers.joespizza.example",
  target: "abcdefabcdef.pages.nearcited.com",
  record: "ours",
  checked_at: "2026-10-16T00:00:00Z",
  registered_at: "2026-10-16T00:00:00Z",
  live_at: "2026-10-16T00:00:00Z",
  home_links: false,
  website_matches: true,
  waits_until: null,
  status: "working",
  paused_at: null,
  ...changes,
});

describe("whether pages are offered on an answer subdomain", () => {
  it("is so only while it is live, working and still under the website", () => {
    expect(offersPages(subdomain())).toBe(true);
    expect(offersPages(subdomain({ live_at: null }))).toBe(false);
    expect(offersPages(subdomain({ website_matches: false }))).toBe(false);
    expect(offersPages(subdomain({ status: "paused" }))).toBe(false);
    expect(offersPages(null)).toBe(false);
  });
});

describe("why an answer subdomain was removed", () => {
  it("says so for each reason, and nothing for one that was asked for", () => {
    expect(removedBecause("plan")).toBe(", because your plan no longer includes it");
    expect(removedBecause("unclaimed")).toBe(
      ", because it had not started working after thirty days",
    );
    expect(removedBecause("location")).toBe(" with its location");
    expect(removedBecause("asked")).toBe("");
  });
});

describe("who fetched a hosted page", () => {
  it("names the assistants' fetchers and the search engines apart, and says the count can be padded", () => {
    expect(
      fetchesLine([
        { fetcher: "googlebot", count: 7, last_on: "2026-10-15" },
        { fetcher: "claudebot", count: 5, last_on: "2026-10-16" },
        { fetcher: "chatgpt-user", count: 1, last_on: "2026-10-14" },
      ]),
    ).toBe(
      "Fetched in the last 30 days by assistants: ClaudeBot (Anthropic) 5 times, ChatGPT-User (OpenAI) once. By search engines: Googlebot (Google) 7 times. Anyone can claim to be one of these, so this shows the page is being read, not who read it.",
    );
    expect(fetchesLine([{ fetcher: "bingbot", count: 2, last_on: "2026-10-15" }])).toBe(
      "Fetched in the last 30 days by search engines: Bingbot (Microsoft) 2 times. Anyone can claim to be one of these, so this shows the page is being read, not who read it.",
    );
    expect(fetchesLine([])).toBeNull();
  });
});

describe("winding a paused subdomain down", () => {
  it("serves its pages thirty days, then sends visitors on for ninety", () => {
    expect(windingDown("2026-09-01T09:00:00Z")).toEqual({
      served: "2026-10-01T09:00:00.000Z",
      removed: "2026-12-30T09:00:00.000Z",
    });
  });
});
