import type { AnalyticsSource, Connection } from "@nearcited/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_WORDS,
  analyticsLede,
  analyticsNote,
  analyticsShown,
  analyticsVisible,
  sourcesDiffer,
} from "../src/lib/analytics-visits";
import { connectionNote } from "../src/lib/connections";
import {
  forgetGoogleStarted,
  GOOGLE_WORDS,
  googleStartedFrom,
  noteGoogleStarted,
  takeGoogleHandedBack,
} from "../src/lib/google";
import { COUNT_WORDS } from "../src/lib/visits";

describe("whether a location's page has a section for Google Analytics", () => {
  const never: AnalyticsSource["state"][] = ["not_connected", "not_on_plan", "sample"];
  const always: AnalyticsSource[] = [
    { state: "no_website" },
    { state: "broken" },
    { state: "not_matched" },
    { state: "waiting" },
    {
      state: "counted",
      property: "Joe's",
      connection_id: "20000000-0000-4000-8000-000000000001",
      broken: false,
    },
    {
      state: "elsewhere",
      property: "Joe's",
      location_id: "10000000-0000-4000-8000-000000000002",
      location_name: "Riverside",
    },
  ];

  it("has none where nothing is connected and nothing was counted, so it looks as it did", () => {
    for (const state of never) {
      expect(analyticsVisible({ state } as AnalyticsSource, 0), state).toBe(false);
    }
  });

  it("keeps what was counted, whatever has happened to the connection since", () => {
    for (const state of never) {
      expect(analyticsVisible({ state } as AnalyticsSource, 3), state).toBe(true);
    }
  });

  it("has one where a connection is there, even with nothing counted", () => {
    for (const source of always) {
      expect(analyticsVisible(source, 0), source.state).toBe(true);
    }
  });
});

describe("what the section says of where its numbers come from", () => {
  it("says no property is matched, without saying that none measures the website", () => {
    expect(analyticsNote({ state: "not_matched" })).toBe(ANALYTICS_WORDS.notMatched);
    // A property with two websites' streams is one location's, so the other's website is measured.
    expect(ANALYTICS_WORDS.notMatched).toContain("is matched to this location");
    expect(ANALYTICS_WORDS.notMatched).toContain("one location");
  });

  it("names the location that holds the property", () => {
    expect(
      analyticsNote({
        state: "elsewhere",
        property: "Joe's",
        location_id: "10000000-0000-4000-8000-000000000002",
        location_name: "Riverside",
      }),
    ).toContain("Riverside");
  });

  it("says when the connection is broken and what is shown was read before", () => {
    expect(
      analyticsNote({
        state: "counted",
        property: "Joe's",
        connection_id: "20000000-0000-4000-8000-000000000001",
        broken: true,
      }),
    ).toBe(ANALYTICS_WORDS.broken);
    expect(
      analyticsNote({
        state: "counted",
        property: "Joe's",
        connection_id: "20000000-0000-4000-8000-000000000001",
        broken: false,
      }),
    ).toBeNull();
  });

  it("calls made-up counts made up", () => {
    expect(analyticsNote({ state: "sample" })).toBe(ANALYTICS_WORDS.sample);
    expect(ANALYTICS_WORDS.sample).toMatch(/made up/);
  });

  it("names the property and the count in its opening line", () => {
    expect(
      analyticsLede(
        {
          state: "counted",
          property: "Joe's site",
          connection_id: "20000000-0000-4000-8000-000000000001",
          broken: false,
        },
        12,
      ),
    ).toBe(
      "Google Analytics reported 12 sessions from assistants in the last 30 days, on Joe's site.",
    );
    expect(analyticsLede({ state: "sample" }, 1)).toBe(
      "Google Analytics reported 1 session from assistants in the last 30 days.",
    );
    expect(analyticsLede({ state: "sample" }, 0)).toBe(ANALYTICS_WORDS.none);
  });
});

describe("a location's sessions as the section lays them out", () => {
  it("are added up by assistant and by day, with no ceiling on a day", () => {
    const shown = analyticsShown({
      days: [
        { day: "2026-10-29", assistant: "chatgpt", count: 1500 },
        { day: "2026-10-30", assistant: "claude", count: 3 },
      ],
    });
    expect(shown.total).toBe(1503);
    expect(shown.assistants.map((row) => [row.name, row.count])).toEqual([
      ["ChatGPT", 1500],
      ["Claude", 3],
    ]);
    // The line stops counting at its ceiling. Google's figures have none, so no day is marked.
    expect(shown.days.every((row) => row.full === false)).toBe(true);
  });
});

describe("the two sources side by side", () => {
  it("are explained only where both have counts", () => {
    expect(sourcesDiffer(4, 9)).toBe(ANALYTICS_WORDS.whyTheyDiffer);
    expect(sourcesDiffer(0, 9)).toBeNull();
    expect(sourcesDiffer(4, 0)).toBeNull();
    expect(sourcesDiffer(0, 0)).toBeNull();
  });

  it("say why they differ, each missing different visitors", () => {
    expect(ANALYTICS_WORDS.whyTheyDiffer).toMatch(/cookies/);
    expect(ANALYTICS_WORDS.whyTheyDiffer).toMatch(/browser/);
  });

  it("each say which assistants cannot be told apart from ordinary search", () => {
    for (const words of [ANALYTICS_WORDS.floor, COUNT_WORDS.floor]) {
      expect(words).toMatch(/AI Overviews and AI Mode/);
      expect(words).toMatch(/Copilot inside Bing/);
    }
  });

  it("say that nothing is worked out from the count, and whose day it is", () => {
    expect(ANALYTICS_WORDS.worked).toMatch(/nothing else here is worked out/i);
    expect(ANALYTICS_WORDS.days).toMatch(/time zone/);
  });
});

describe("a broken connection's note", () => {
  const broken = (reason: "refused" | "failing") =>
    ({
      kind: "google_analytics",
      status: "broken",
      broken_reason: reason,
    }) as Connection;

  it("says to remove it and then sign in again where it was refused, in that order", () => {
    // Taking a sign-in back at Google can take back others of the same person's.
    expect(connectionNote(broken("refused"), String)).toMatch(
      /Google refused.*Remove it.*then sign in with Google again/,
    );
    expect(connectionNote(broken("failing"), String)).toMatch(/three days in a row/);
  });
});

describe("coming back from Google", () => {
  let kept: Map<string, string>;
  let replaced: string[];

  beforeEach(() => {
    kept = new Map();
    replaced = [];
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => kept.set(key, value),
      removeItem: (key: string) => kept.delete(key),
    });
    vi.stubGlobal("window", {
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url),
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const at = (pathname: string, search: string) => ({ pathname, search }) as Location;
  const organization = "30000000-0000-4000-8000-000000000001";
  const signIn = "https://accounts.google.com/o/oauth2/v2/auth?state=the-state&client_id=x";

  it("takes the code off the address at once", () => {
    expect(takeGoogleHandedBack(at("/google/return", "?code=the-code&state=the-state"))).toEqual({
      kind: "agreed",
      code: "the-code",
      state: "the-state",
    });
    expect(replaced).toEqual(["/google/return"]);
  });

  it("is a refusal where the owner said no on Google's screen", () => {
    expect(takeGoogleHandedBack(at("/google/return", "?error=access_denied&state=s"))).toEqual({
      kind: "declined",
      state: "s",
    });
  });

  it("is nothing on any other page, or with half of what it needs, and leaves the address", () => {
    expect(takeGoogleHandedBack(at("/connections", "?code=c&state=s"))).toEqual({
      kind: "nothing",
    });
    expect(replaced).toEqual([]);
    expect(takeGoogleHandedBack(at("/google/return", "?code=c"))).toEqual({ kind: "nothing" });
  });

  it("is believed only in the tab that started it, for the organization it started from", () => {
    expect(noteGoogleStarted(organization, signIn)).toBe(true);
    expect(googleStartedFrom("the-state")).toBe(organization);
    expect(googleStartedFrom("another-state")).toBeNull();
    forgetGoogleStarted();
    expect(googleStartedFrom("the-state")).toBeNull();
  });

  it("is not started where the browser keeps nothing", () => {
    vi.stubGlobal("sessionStorage", {
      setItem: () => {
        throw new Error("no storage");
      },
    });
    expect(noteGoogleStarted(organization, signIn)).toBe(false);
  });

  it("says only what is read, before anyone agrees", () => {
    expect(GOOGLE_WORDS.about).toMatch(/asks only to read/);
    expect(GOOGLE_WORDS.matched).toMatch(/measures/);
    expect(GOOGLE_WORDS.remove("Google Analytics")).toMatch(/takes back the access/);
  });
});
