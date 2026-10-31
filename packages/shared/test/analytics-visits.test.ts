import { describe, expect, it } from "vitest";
import {
  ANALYTICS_REPORT_SOURCES,
  analyticsDaysToRead,
  analyticsSource,
  assistantOfSource,
  GOOGLE_RETURN_PATH,
  sampleAnalyticsVisits,
} from "../src/analytics-visits";
import {
  CONNECTION_KIND_ALLOWANCES,
  type Connection,
  ConnectionInputSchema,
  GoogleReturnSchema,
  LocationAnalyticsVisitsSchema,
} from "../src/schemas";
import { ASSISTANT_REFERRERS, VISITS_ALLOWANCE } from "../src/visits";

describe("the assistant a session came from", () => {
  it("is the one whose host its source is, a subdomain counting as its site", () => {
    expect(assistantOfSource("chatgpt.com")).toBe("chatgpt");
    expect(assistantOfSource("chat.openai.com")).toBe("chatgpt");
    expect(assistantOfSource("www.perplexity.ai")).toBe("perplexity");
    expect(assistantOfSource("gemini.google.com")).toBe("gemini");
    expect(assistantOfSource(" Claude.AI ")).toBe("claude");
  });

  it("is nobody for any other source, however like one it looks", () => {
    for (const source of [
      "google",
      "google.com",
      "bing",
      "(direct)",
      "(not set)",
      "",
      "notchatgpt.com",
      "chatgpt.com.example",
    ]) {
      expect(assistantOfSource(source), source).toBeNull();
    }
  });

  it("is asked of Google for every assistant's every host and tag, and nothing else", () => {
    const named = Object.values(ASSISTANT_REFERRERS).flatMap(({ hosts, tags }) => [
      ...hosts,
      ...tags,
    ]);
    expect([...ANALYTICS_REPORT_SOURCES].sort()).toEqual([...new Set(named)].sort());
  });
});

describe("the days to read a location's sessions for", () => {
  const now = new Date("2026-10-31T06:00:00Z");

  it("are the last thirty finished days the first time", () => {
    const days = analyticsDaysToRead(null, now);
    expect(days).toHaveLength(30);
    expect(days[0]).toBe("2026-10-01");
    expect(days.at(-1)).toBe("2026-10-30");
  });

  it("are the last three finished days after a read that was up to date", () => {
    expect(analyticsDaysToRead("2026-10-29", now)).toEqual([
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
    ]);
  });

  it("reach back to the day after the last read where reads were missed", () => {
    const days = analyticsDaysToRead("2026-10-20", now);
    expect(days[0]).toBe("2026-10-21");
    expect(days.at(-1)).toBe("2026-10-30");
  });

  it("never reach past the thirty days shown", () => {
    const days = analyticsDaysToRead("2026-01-01", now);
    expect(days).toHaveLength(30);
    expect(days[0]).toBe("2026-10-01");
  });
});

describe("a location's sample sessions", () => {
  const days = ["2026-10-29", "2026-10-30"];

  it("are the same for the same location and day, and name known assistants and pages", () => {
    const made = sampleAnalyticsVisits("location-1", days);
    expect(made.length).toBeGreaterThan(0);
    expect(sampleAnalyticsVisits("location-1", days)).toEqual(made);
    expect(sampleAnalyticsVisits("location-2", days)).not.toEqual(made);
    for (const counted of made) {
      expect(days).toContain(counted.day);
      expect(Object.keys(ASSISTANT_REFERRERS)).toContain(counted.assistant);
      expect(counted.path.startsWith("/")).toBe(true);
      expect(counted.count).toBeGreaterThan(0);
    }
  });
});

describe("what a Google Analytics connection is", () => {
  it("needs the visits allowance, and no new one", () => {
    expect(CONNECTION_KIND_ALLOWANCES.google_analytics).toBe(VISITS_ALLOWANCE);
  });

  it("is never made from something pasted, only through Google's return", () => {
    expect(ConnectionInputSchema.safeParse({ kind: "google_analytics" }).success).toBe(false);
    expect(GoogleReturnSchema.parse({ code: " a-code ", state: "a-state" })).toEqual({
      code: "a-code",
      state: "a-state",
    });
    expect(GoogleReturnSchema.safeParse({ code: "", state: "a-state" }).success).toBe(false);
    expect(GoogleReturnSchema.safeParse({ code: "a-code" }).success).toBe(false);
  });

  it("returns to the app, not the API", () => {
    expect(GOOGLE_RETURN_PATH.startsWith("/api")).toBe(false);
  });
});

describe("where a location's sessions from assistants come from", () => {
  const here = {
    id: "10000000-0000-4000-8000-000000000001",
    name: "Main Street",
    website: "https://www.joes.example/",
  };
  const there = {
    id: "10000000-0000-4000-8000-000000000002",
    name: "Riverside",
    website: "https://joes.example/riverside",
  };
  const connection = (over: Partial<Connection> = {}) =>
    ({
      id: "20000000-0000-4000-8000-000000000001",
      kind: "google_analytics" as const,
      status: "working" as const,
      choices: [{ id: "properties/1", label: "Joe's" }],
      matches: [],
      last_synced_at: "2026-10-30T06:00:00Z",
      ...over,
    }) as Pick<Connection, "id" | "kind" | "status" | "choices" | "matches" | "last_synced_at">;
  const match = (locationId: string) => ({
    location_id: locationId,
    external_id: "properties/1",
    external_label: "Joe's",
    matched_at: "2026-10-30T06:00:00Z",
  });
  const source = (
    connections: ReturnType<typeof connection>[],
    {
      location = here as { id: string; name: string; website: string | null },
      allowances = { [VISITS_ALLOWANCE]: true } as Record<string, true>,
      sampleData = false,
    } = {},
  ) => analyticsSource({ location, locations: [here, there], connections, allowances, sampleData });

  it("is not said where the plan does not include visits, or on sample data", () => {
    expect(source([], { allowances: {} })).toEqual({ state: "not_on_plan" });
    expect(source([], { sampleData: true })).toEqual({ state: "sample" });
  });

  it("is why there are none where nothing is matched to it", () => {
    expect(source([])).toEqual({ state: "not_connected" });
    expect(source([connection({ kind: "cloudflare" })])).toEqual({ state: "not_connected" });
    expect(source([connection({ status: "removed" })])).toEqual({ state: "not_connected" });
    expect(source([connection()], { location: { ...here, website: null } })).toEqual({
      state: "no_website",
    });
    expect(source([connection({ last_synced_at: null })])).toEqual({ state: "waiting" });
    expect(source([connection()])).toEqual({ state: "not_matched" });
    expect(source([connection({ status: "broken" })])).toEqual({ state: "broken" });
  });

  it("is the property matched to it, which may be broken", () => {
    expect(source([connection({ matches: [match(here.id)] })])).toEqual({
      state: "counted",
      property: "Joe's",
      connection_id: "20000000-0000-4000-8000-000000000001",
      broken: false,
    });
    expect(source([connection({ matches: [match(here.id)], status: "broken" })])).toMatchObject({
      state: "counted",
      broken: true,
    });
  });

  it("names the location holding the property where they share a website", () => {
    const parsed = LocationAnalyticsVisitsSchema.shape.source.parse(
      source([connection({ matches: [match(there.id)] })]),
    );
    expect(parsed).toEqual({
      state: "elsewhere",
      property: "Joe's",
      location_id: there.id,
      location_name: "Riverside",
    });
  });
});
