import { describe, expect, it } from "vitest";
import { ALLOWANCE_KINDS } from "../src/allowances";
import {
  boundedFetches,
  daysToRead,
  FETCHES_ALLOWANCE,
  type FetchCount,
  fetchedHosts,
  fetchSource,
  MOST_FETCHED_PAGES_A_DAY,
  sampleFetches,
  zoneHolds,
} from "../src/fetches";
import { PAGE_FETCHER_KEYS } from "../src/hosted-pages";
import { CONNECTION_KIND_ALLOWANCES, type Connection, ConnectionInputSchema } from "../src/schemas";

const NOW = new Date("2026-10-29T15:00:00Z");

describe("the allowance and the kind of connection", () => {
  it("are a kind of allowance, included or not, that a Cloudflare connection needs", () => {
    expect(ALLOWANCE_KINDS[FETCHES_ALLOWANCE]).toEqual({
      counted: false,
      name: "Fetches by assistants counted",
    });
    expect(CONNECTION_KIND_ALLOWANCES.cloudflare).toBe(FETCHES_ALLOWANCE);
  });

  it("is connected with a token, and nothing else is", () => {
    const token = "a".repeat(40);
    expect(ConnectionInputSchema.parse({ kind: "cloudflare", token: ` ${token} ` })).toEqual({
      kind: "cloudflare",
      token,
    });
    for (const sent of [
      { kind: "cloudflare" },
      { kind: "cloudflare", token: "short" },
      { kind: "cloudflare", token: `${"a".repeat(39)} b` },
    ]) {
      expect(ConnectionInputSchema.safeParse(sent).success, JSON.stringify(sent)).toBe(false);
    }
    expect(ConnectionInputSchema.parse({ kind: "sample", token })).toEqual({ kind: "sample" });
  });
});

describe("which hosts are a location's site", () => {
  it("are its website's host with and without www", () => {
    expect(fetchedHosts("https://www.Joes.example/menu")).toEqual([
      "joes.example",
      "www.joes.example",
    ]);
    expect(fetchedHosts("shop.joes.example")).toEqual([
      "shop.joes.example",
      "www.shop.joes.example",
    ]);
    expect(fetchedHosts(null)).toBeNull();
    expect(fetchedHosts("localhost")).toBeNull();
  });

  it("are held by the zone of their domain, and by no other", () => {
    expect(zoneHolds("joes.example", "joes.example")).toBe(true);
    expect(zoneHolds("Joes.example", "shop.joes.example")).toBe(true);
    expect(zoneHolds("joes.example", "notjoes.example")).toBe(false);
    expect(zoneHolds("shop.joes.example", "joes.example")).toBe(false);
  });
});

describe("the days a read takes", () => {
  it("are the last thirty finished days the first time", () => {
    const days = daysToRead(null, NOW);
    expect(days).toHaveLength(30);
    expect(days[0]).toBe("2026-09-29");
    expect(days.at(-1)).toBe("2026-10-28");
  });

  it("are the last finished day and the day before it again after that", () => {
    expect(daysToRead("2026-10-27", NOW)).toEqual(["2026-10-27", "2026-10-28"]);
    // Read twice in a day, the second read takes the same two days again.
    expect(daysToRead("2026-10-28", NOW)).toEqual(["2026-10-27", "2026-10-28"]);
  });

  it("take in the days a missed read would have, but never more than thirty", () => {
    expect(daysToRead("2026-10-24", NOW)).toEqual([
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
    ]);
    expect(daysToRead("2026-01-01", NOW)).toHaveLength(30);
  });

  it("start at the first whole day the zone still keeps", () => {
    // About a week, as on Cloudflare's Free and Pro plans.
    expect(daysToRead(null, NOW, 7 * 86_400)).toEqual([
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
    ]);
    expect(daysToRead(null, new Date("2026-10-29T00:00:00Z"), 7 * 86_400)[0]).toBe("2026-10-22");
    expect(daysToRead(null, NOW, 3600)).toEqual([]);
  });
});

describe("a day's counts as they are kept", () => {
  const fetch = (path: string, count: number, day = "2026-10-28"): FetchCount => ({
    day,
    fetcher: "gptbot",
    path,
    count,
  });

  it("are under the most fetched pages, with the rest counted together", () => {
    const counts = Array.from({ length: MOST_FETCHED_PAGES_A_DAY + 2 }, (_, at) =>
      fetch(`/p${at}`, at + 1),
    );
    const kept = boundedFetches([...counts, { ...fetch("/p0", 1), fetcher: "claudebot" }]);
    expect(kept.filter((counted) => counted.path !== "")).toHaveLength(MOST_FETCHED_PAGES_A_DAY);
    // The two least fetched pages: /p0, by both fetchers, and /p1.
    expect(kept.filter((counted) => counted.path === "")).toEqual([
      { day: "2026-10-28", fetcher: "gptbot", path: "", count: 3 },
      { day: "2026-10-28", fetcher: "claudebot", path: "", count: 1 },
    ]);
    const total = (list: FetchCount[]) => list.reduce((sum, counted) => sum + counted.count, 0);
    expect(total(kept)).toBe(total(counts) + 1);
  });

  it("bound each day on its own", () => {
    const counts = Array.from({ length: MOST_FETCHED_PAGES_A_DAY }, (_, at) => [
      fetch(`/a${at}`, 1),
      fetch(`/b${at}`, 1, "2026-10-27"),
    ]).flat();
    expect(boundedFetches(counts).every((counted) => counted.path !== "")).toBe(true);
  });
});

describe("sample fetches", () => {
  it("are the same for the same location and day, and differ between locations", () => {
    const days = ["2026-10-27", "2026-10-28"];
    const one = sampleFetches("a0000000-0000-4000-8000-000000000001", days);
    expect(sampleFetches("a0000000-0000-4000-8000-000000000001", days)).toEqual(one);
    expect(sampleFetches("a0000000-0000-4000-8000-000000000002", days)).not.toEqual(one);
    expect(one.length).toBeGreaterThan(0);
    for (const counted of one) {
      expect(days).toContain(counted.day);
      expect(PAGE_FETCHER_KEYS).toContain(counted.fetcher);
      expect(counted.path).toMatch(/^\//);
      expect(counted.count).toBeGreaterThan(0);
    }
  });
});

describe("where a location's fetches come from", () => {
  const here = { id: "l1", name: "Main Street", website: "https://www.joes.example" };
  const there = { id: "l2", name: "Riverside", website: "https://joes.example/riverside" };
  const zone = (overrides: Partial<Connection> = {}) => ({
    id: "c1",
    kind: "cloudflare" as const,
    status: "working" as const,
    last_synced_at: "2026-10-29T01:00:00Z",
    choices: [
      { id: "z1", label: "joes.example" },
      { id: "z2", label: "other.example" },
    ],
    matches: [],
    ...overrides,
  });
  const matched = (locationId: string) => ({
    location_id: locationId,
    external_id: "z1",
    external_label: "joes.example",
    matched_at: "2026-10-29T01:00:00Z",
  });
  const source = (
    connections: ReturnType<typeof zone>[],
    { allowances = { fetches: true as const }, sampleData = false, location = here } = {},
  ) => fetchSource({ location, locations: [here, there], connections, allowances, sampleData });

  it("is the zone matched to the location", () => {
    expect(source([zone({ matches: [matched("l1")] })])).toEqual({
      state: "counted",
      zone: "joes.example",
      connection_id: "c1",
      broken: false,
    });
    expect(source([zone({ status: "broken", matches: [matched("l1")] })])).toMatchObject({
      state: "counted",
      broken: true,
    });
  });

  it("names the location the zone is matched to, where it is another", () => {
    expect(source([zone({ matches: [matched("l2")] })])).toEqual({
      state: "elsewhere",
      zone: "joes.example",
      location_id: "l2",
      location_name: "Riverside",
      same_website: true,
    });
  });

  it("says where the location matched has another website in the zone, which counts this one nowhere", () => {
    const shop = { id: "l3", name: "Shop", website: "https://shop.joes.example" };
    expect(
      fetchSource({
        location: shop,
        locations: [here, there, shop],
        connections: [zone({ matches: [matched("l1")] })],
        allowances: { fetches: true },
        sampleData: false,
      }),
    ).toMatchObject({ state: "elsewhere", location_id: "l1", same_website: false });
  });

  it("says a broken connection is broken, rather than waiting on it", () => {
    expect(source([zone({ status: "broken", last_synced_at: null, choices: [] })])).toEqual({
      state: "broken",
    });
  });

  it("says why there are none", () => {
    expect(source([], { allowances: {} as never })).toEqual({ state: "not_on_plan" });
    expect(source([], { sampleData: true })).toEqual({ state: "sample" });
    expect(source([], { location: { ...here, website: null } as never })).toEqual({
      state: "no_website",
    });
    expect(source([])).toEqual({ state: "not_connected" });
    expect(source([zone({ status: "removed" })])).toEqual({ state: "not_connected" });
    expect(source([zone({ kind: "sample" as never })])).toEqual({ state: "not_connected" });
    expect(source([zone({ choices: [{ id: "z2", label: "other.example" }] })])).toEqual({
      state: "not_in_zone",
    });
    // A zone that holds the site, not matched yet, is matched at the next read.
    expect(source([zone()])).toEqual({ state: "waiting" });
    expect(source([zone({ last_synced_at: null, choices: [] })])).toEqual({ state: "waiting" });
  });
});
