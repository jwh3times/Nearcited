import type { AnswerSubdomain } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import { offersPages, removedBecause } from "../src/lib/hosted-pages";

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
