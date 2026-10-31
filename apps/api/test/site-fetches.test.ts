import {
  type ConnectionMessage,
  ConnectionSchema,
  LocationFetchesSchema,
  LocationSchema,
  OrganizationSchema,
} from "@nearcited/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { syncConnection } from "../src/connections";
import { listZones, readFetches, TokenRefused, zoneLimits } from "../src/connections/cloudflare";
import { open, sealingKey } from "../src/connections/seal";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

/**
 * Fetches of a business's own site, read from its Cloudflare zone (issue #156). Cloudflare here is
 * made up: it answers with recorded responses whose numbers are made up too.
 */

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const carol = "c0000000-0000-4000-8000-000000000003";
const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const TOKEN = "cf-token-made-up-for-tests-0123456789abcd";
const DAY = 86_400_000;
/** Six in the morning (UTC) today: the page counts back from the day it is read. */
const NOW = new Date(Math.floor(Date.now() / DAY) * DAY + 6 * 3_600_000);
/** The day (UTC) `back` days before today. */
const dayBack = (back: number) => new Date(NOW.getTime() - back * DAY).toISOString().slice(0, 10);

/** One day's groups as Cloudflare's analytics answered them, with made-up numbers. */
const RECORDED = [
  {
    count: 12,
    dimensions: {
      userAgent:
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
      clientRequestPath: "/",
    },
  },
  {
    count: 3,
    dimensions: {
      userAgent:
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot",
      clientRequestPath: "/",
    },
  },
  {
    count: 4,
    dimensions: {
      userAgent: "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
      clientRequestPath: "/menu",
    },
  },
  {
    count: 7.6,
    dimensions: {
      userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      clientRequestPath: "/menu",
    },
  },
  {
    // A browser that says a fetcher's name in passing is not one: `fetcherOf` decides.
    count: 50,
    dimensions: {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36",
      clientRequestPath: "/",
    },
  },
  { count: 2, dimensions: { userAgent: "GPTBot/1.2", clientRequestPath: "not-a-path" } },
];

interface FakeCloudflare {
  zones: { id: string; name: string }[];
  /** Answer every request with this status, as for a token Cloudflare refuses. */
  status?: number;
  /** Answer the analytics with errors. */
  broken?: boolean;
  /** How far back the zone keeps its counts, in seconds. */
  keptFor?: number;
  /** A day's groups, by day. */
  groups: Record<string, unknown[]>;
  /** Answer every request with a redirect somewhere else. */
  redirects?: boolean;
  asked: { url: string; body: { query: string; variables: Record<string, unknown> } | null }[];
}

let cloudflare: FakeCloudflare;

/** Cloudflare as this test makes it up. */
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  cloudflare.asked.push({ url, body });
  expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
  // The Workers runtime throws on `redirect: "error"`, though Node takes it, so the token is kept
  // from going on through a redirect by asking for "manual" and not following what comes back.
  expect(init?.redirect).toBe("manual");
  if (cloudflare.redirects) {
    return new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } });
  }
  if (cloudflare.status) return new Response("{}", { status: cloudflare.status });
  if (url.startsWith("https://api.cloudflare.com/client/v4/zones?")) {
    return Response.json({
      success: true,
      result: cloudflare.zones,
      result_info: { page: 1, total_pages: 1 },
    });
  }
  if (url === "https://api.cloudflare.com/client/v4/graphql") {
    if (cloudflare.broken) {
      return Response.json({ data: null, errors: [{ message: "the analytics are down" }] });
    }
    if (body.query.startsWith("query Limits")) {
      return Response.json({
        data: {
          viewer: {
            zones: [
              {
                settings: {
                  httpRequestsAdaptiveGroups: {
                    notOlderThan: cloudflare.keptFor ?? 31 * 86_400,
                    maxPageSize: 10_000,
                  },
                },
              },
            ],
          },
        },
        errors: null,
      });
    }
    const day = String(body.variables.filter.datetime_geq).slice(0, 10);
    return Response.json({
      data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: cloudflare.groups[day] ?? [] }] } },
      errors: null,
    });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

let db: MemoryDb;
let queued: ConnectionMessage[];
let env: Env;

const app = createApp({
  authenticate: async (request) => {
    const userId = request.headers.get("Authorization")?.replace("Bearer ", "");
    return userId
      ? { user: { id: userId, email: `${userId}@example.com` }, store: memoryStore(db, userId) }
      : null;
  },
  publicStore: () => memoryStore(db, "nobody"),
});

function call(user: string | null, method: string, path: string, body?: unknown) {
  return app.request(
    `/api${path}`,
    {
      method,
      headers: {
        ...(user ? { Authorization: `Bearer ${user}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

const worker = async (now = NOW) => ({
  store: memoryStore(db, null),
  key: await sealingKey(SECRET),
  outside: { fetch: fakeFetch },
  now,
});

const fetchesOf = async (user: string, locationId: string) =>
  LocationFetchesSchema.parse(
    await (await call(user, "GET", `/locations/${locationId}/fetches`)).json(),
  );

/** Alice's organization, on a plan that counts fetches, with Bob a member, and three locations. */
async function organization() {
  const made = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Joe's Pizza" })).json(),
  );
  db.memberships.push({ organization_id: made.id, user_id: bob, role: "member" });
  const kept = db.organizations.find((o) => o.id === made.id);
  if (kept) Object.assign(kept, { allowances: { fetches: true }, max_locations: 10 });
  const locations = [];
  for (const [name, website] of [
    ["Main Street", "https://www.joes.example/"],
    ["Riverside", "https://joes.example/riverside"],
    ["Elsewhere", "https://elsewhere.example"],
  ]) {
    locations.push(
      LocationSchema.parse(
        await (
          await call(alice, "POST", `/organizations/${made.id}/locations`, {
            name,
            city: "Raleigh",
            website,
          })
        ).json(),
      ),
    );
  }
  const [main, riverside, elsewhere] = locations;
  if (!main || !riverside || !elsewhere) throw new Error("no locations");
  return { organization: made, main, riverside, elsewhere };
}

const connect = async (organizationId: string, token = TOKEN) =>
  call(alice, "POST", `/organizations/${organizationId}/connections`, {
    kind: "cloudflare",
    token,
  });

beforeEach(() => {
  db = createMemoryDb();
  queued = [];
  cloudflare = {
    zones: [
      { id: "zone-joes", name: "joes.example" },
      { id: "zone-other", name: "other.example" },
    ],
    groups: {},
    asked: [],
  };
  env = {
    PROVIDER_MODE: "live",
    CONNECTIONS_KEY: SECRET,
    SCAN_QUEUE: {
      send: async (message: ConnectionMessage) => {
        queued.push(message);
      },
      sendBatch: async (messages: { body: ConnectionMessage }[]) => {
        queued.push(...messages.map((message) => message.body));
      },
    },
  } as unknown as Env;
});

describe("Cloudflare", () => {
  it("lists the zones a token reaches, and refuses a token it refuses or that reaches none", async () => {
    expect(await listZones(TOKEN, { fetch: fakeFetch })).toEqual([
      { id: "zone-joes", label: "joes.example" },
      { id: "zone-other", label: "other.example" },
    ]);
    cloudflare.zones = [];
    await expect(listZones(TOKEN, { fetch: fakeFetch })).rejects.toThrow(TokenRefused);
    cloudflare.status = 403;
    await expect(listZones(TOKEN, { fetch: fakeFetch })).rejects.toThrow(TokenRefused);
    cloudflare.status = 500;
    await expect(listZones(TOKEN, { fetch: fakeFetch })).rejects.not.toThrow(TokenRefused);
  });

  it("never sends a token on through a redirect, and does not take one for a refusal", async () => {
    cloudflare.redirects = true;
    await expect(listZones(TOKEN, { fetch: fakeFetch })).rejects.toThrow(
      "Cloudflare answered 302.",
    );
    await expect(zoneLimits(TOKEN, "zone-joes", { fetch: fakeFetch })).rejects.toThrow(
      "Cloudflare answered 302.",
    );
    expect(cloudflare.asked.map((asked) => new URL(asked.url).host)).toEqual([
      "api.cloudflare.com",
      "api.cloudflare.com",
    ]);
  });

  it("is asked for one day at a time, for the website's host with and without www, and its fetchers", async () => {
    cloudflare.groups = { "2026-10-27": RECORDED, "2026-10-28": RECORDED.slice(2, 3) };
    const counts = await readFetches(
      TOKEN,
      { zone_id: "zone-joes", website: "https://www.Joes.example/menu" },
      ["2026-10-27", "2026-10-28"],
      { keptForSeconds: null, mostGroups: 500 },
      { fetch: fakeFetch },
    );
    expect(counts).toEqual([
      // Two versions of one fetcher are one fetcher. The estimate is kept as a whole number.
      { day: "2026-10-27", fetcher: "gptbot", path: "/", count: 15 },
      { day: "2026-10-27", fetcher: "claudebot", path: "/menu", count: 4 },
      { day: "2026-10-27", fetcher: "googlebot", path: "/menu", count: 8 },
      { day: "2026-10-28", fetcher: "claudebot", path: "/menu", count: 4 },
    ]);
    const [first, second] = cloudflare.asked.map((asked) => asked.body?.variables);
    expect(first).toMatchObject({
      zone: "zone-joes",
      limit: 500,
      filter: {
        datetime_geq: "2026-10-27T00:00:00Z",
        datetime_lt: "2026-10-28T00:00:00.000Z",
        // Every other host in the zone is left out, an answer subdomain among them.
        clientRequestHTTPHost_in: ["joes.example", "www.joes.example"],
      },
    });
    const asked = (first?.filter as { OR?: unknown[] } | undefined)?.OR;
    expect(asked).toContainEqual({ userAgent_like: "%GPTBot%" });
    expect(asked).toHaveLength(10);
    expect(second).toMatchObject({ filter: { datetime_geq: "2026-10-28T00:00:00Z" } });
    // Nothing per request is asked for: no time of day, address, query or status.
    const query = cloudflare.asked[0]?.body?.query ?? "";
    expect(query).toContain("dimensions { userAgent clientRequestPath }");
    expect(query).not.toMatch(/clientIP|datetimeHour|clientRequestQuery|edgeResponseStatus/);
  });
});

describe("a Cloudflare connection", () => {
  it("is made by an owner with a token, sealed, on a plan that counts fetches", async () => {
    const { organization: made } = await organization();
    const response = await connect(made.id);
    expect(response.status).toBe(201);
    const connection = ConnectionSchema.parse(await response.json());
    expect(connection).toMatchObject({ kind: "cloudflare", label: "Cloudflare token" });
    expect(JSON.stringify(connection)).not.toContain(TOKEN);
    const sealed = db.connectionSecrets.get(connection.id) ?? "";
    expect(sealed).not.toContain(TOKEN);
    const key = await sealingKey(SECRET);
    if (!key) throw new Error("no key");
    expect(await open(key, connection.id, sealed)).toBe(TOKEN);
    expect(queued).toEqual([{ connection_id: connection.id, step: "sync" }]);

    expect((await connect(made.id, "not a token")).status).toBe(422);
    expect(
      (
        await call(bob, "POST", `/organizations/${made.id}/connections`, {
          kind: "cloudflare",
          token: TOKEN,
        })
      ).status,
    ).toBe(404);
    const kept = db.organizations.find((o) => o.id === made.id);
    if (kept) kept.allowances = {};
    expect((await connect(made.id)).status).toBe(422);
  });

  it("reads thirty days of fetches the first time, for the location whose website the zone holds", async () => {
    const { organization: made, main, riverside, elsewhere } = await organization();
    const connection = ConnectionSchema.parse(await (await connect(made.id)).json());
    for (let back = 1; back <= 31; back++) {
      cloudflare.groups[new Date(NOW.getTime() - back * DAY).toISOString().slice(0, 10)] = RECORDED;
    }
    expect(await syncConnection(connection.id, await worker())).toBe("synced");

    const days = new Set(db.siteFetches.map((counted) => counted.day));
    expect(days.size).toBe(30);
    expect([...days].sort()[0]).toBe(dayBack(30));
    expect(db.siteFetches.every((counted) => counted.location_id === main.id)).toBe(true);
    expect(db.siteFetches.every((counted) => !counted.sample_data)).toBe(true);
    // One zone, one location: the zone is Main Street's, the first made with that website.
    expect(db.connections[0]?.matches.map((m) => [m.location_id, m.external_label])).toEqual([
      [main.id, "joes.example"],
    ]);

    const mine = await fetchesOf(bob, main.id);
    expect(mine.source).toEqual({
      state: "counted",
      zone: "joes.example",
      connection_id: connection.id,
      broken: false,
    });
    expect(mine.read_through).toBe(dayBack(1));
    expect(mine.days.filter((row) => row.day === dayBack(1))).toEqual([
      { day: dayBack(1), fetcher: "claudebot", count: 4 },
      { day: dayBack(1), fetcher: "googlebot", count: 8 },
      { day: dayBack(1), fetcher: "gptbot", count: 15 },
    ]);
    expect(mine.pages).toEqual([
      { fetcher: "claudebot", path: "/menu", count: 4 * 30 },
      { fetcher: "googlebot", path: "/menu", count: 8 * 30 },
      { fetcher: "gptbot", path: "/", count: 15 * 30 },
    ]);

    // The other location with the same website names where its fetches are counted.
    expect((await fetchesOf(bob, riverside.id)).source).toEqual({
      state: "elsewhere",
      zone: "joes.example",
      location_id: main.id,
      location_name: "Main Street",
      same_website: true,
    });
    expect((await fetchesOf(bob, riverside.id)).days).toEqual([]);
    expect((await fetchesOf(alice, elsewhere.id)).source).toEqual({ state: "not_in_zone" });
    expect((await call(carol, "GET", `/locations/${main.id}/fetches`)).status).toBe(404);
  });

  it("reads the last day and the day before it again after that, replacing rather than adding", async () => {
    const { organization: made, main } = await organization();
    const connection = ConnectionSchema.parse(await (await connect(made.id)).json());
    cloudflare.groups[dayBack(1)] = RECORDED.slice(0, 1);
    await syncConnection(connection.id, await worker());
    cloudflare.asked = [];

    // A day later Cloudflare's figure for yesterday has grown, and today is finished.
    cloudflare.groups[dayBack(1)] = [{ ...RECORDED[0], count: 20 }];
    cloudflare.groups[dayBack(0)] = RECORDED.slice(2, 3);
    expect(await syncConnection(connection.id, await worker(new Date(NOW.getTime() + DAY)))).toBe(
      "synced",
    );
    const asked = cloudflare.asked
      .map((a) => (a.body?.variables.filter as { datetime_geq?: string } | undefined)?.datetime_geq)
      .filter(Boolean);
    expect(asked).toEqual([`${dayBack(1)}T00:00:00Z`, `${dayBack(0)}T00:00:00Z`]);
    expect(
      db.siteFetches
        .filter((counted) => counted.location_id === main.id)
        .map(({ day, fetcher, count }) => [day, fetcher, count])
        .sort(),
    ).toEqual([
      [dayBack(1), "gptbot", 20],
      [dayBack(0), "claudebot", 4],
    ]);
  });

  it("reads back only as far as the zone keeps its counts", async () => {
    const { organization: made } = await organization();
    const connection = ConnectionSchema.parse(await (await connect(made.id)).json());
    cloudflare.keptFor = 7 * 86_400;
    await syncConnection(connection.id, await worker());
    const asked = cloudflare.asked.filter((a) => a.body?.query.startsWith("query Fetches"));
    expect(asked).toHaveLength(6);
  });

  it("breaks at once when Cloudflare refuses the token or it reaches no zone, and counts nothing", async () => {
    for (const refuse of [
      () => {
        cloudflare.status = 401;
      },
      () => {
        cloudflare.zones = [];
      },
    ]) {
      db = createMemoryDb();
      cloudflare.status = undefined;
      cloudflare.zones = [{ id: "zone-joes", name: "joes.example" }];
      const { organization: made } = await organization();
      const connection = ConnectionSchema.parse(await (await connect(made.id)).json());
      refuse();
      expect(await syncConnection(connection.id, await worker())).toBe("refused");
      expect(db.connections[0]).toMatchObject({ status: "broken", broken_reason: "refused" });
      expect(db.siteFetches).toEqual([]);
    }
  });

  it("breaks at once when the token may not read the zone's analytics", async () => {
    const { organization: made } = await organization();
    const connection = ConnectionSchema.parse(await (await connect(made.id)).json());
    const real = fakeFetch;
    const withoutAnalytics = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/graphql")
        ? Response.json({
            data: null,
            errors: [{ message: "not authorized for that account", extensions: { code: "authz" } }],
          })
        : real(input, init)) as typeof fetch;
    expect(
      await syncConnection(connection.id, {
        ...(await worker()),
        outside: { fetch: withoutAnalytics },
      }),
    ).toBe("refused");
    expect(db.connections[0]).toMatchObject({ status: "broken", broken_reason: "refused" });
    expect((await fetchesOf(alice, db.locations[0]?.id ?? "")).source).toEqual({
      state: "counted",
      zone: "joes.example",
      connection_id: connection.id,
      broken: true,
    });
  });

  it("counts a failed read as a failed sync, so reads that keep failing break it", async () => {
    const { organization: made } = await organization();
    const connection = ConnectionSchema.parse(await (await connect(made.id)).json());
    cloudflare.broken = true;
    for (let day = 0; day < 3; day++) {
      db.now = new Date(NOW.getTime() + day * DAY).toISOString();
      expect(
        await syncConnection(connection.id, await worker(new Date(NOW.getTime() + day * DAY))),
      ).toBe("failed");
    }
    expect(db.connections[0]).toMatchObject({ status: "broken", broken_reason: "failing" });
    expect(db.connections[0]?.last_synced_at).toBeNull();
  });

  it("is never matched to a location by hand", async () => {
    const { organization: made, riverside } = await organization();
    const connection = ConnectionSchema.parse(await (await connect(made.id)).json());
    await syncConnection(connection.id, await worker());
    const response = await call(
      alice,
      "PUT",
      `/connections/${connection.id}/locations/${riverside.id}`,
      { external_id: "zone-joes" },
    );
    expect(response.status).toBe(422);
  });
});

describe("a location's fetches", () => {
  it("say why there are none, and what was counted while there were", async () => {
    const { organization: made, main } = await organization();
    expect((await fetchesOf(alice, main.id)).source).toEqual({ state: "not_connected" });
    const kept = db.organizations.find((o) => o.id === made.id);
    if (kept) kept.allowances = {};
    expect((await fetchesOf(alice, main.id)).source).toEqual({ state: "not_on_plan" });
  });

  it("are the made-up ones for a test organization and on sample data, and never Cloudflare's", async () => {
    const { main } = await organization();
    env = { ...env, PROVIDER_MODE: "mock" } as Env;
    db.siteFetches.push({
      location_id: main.id,
      day: dayBack(1),
      fetcher: "gptbot",
      path: "/",
      count: 2,
      sample_data: true,
    });
    const sampled = await fetchesOf(alice, main.id);
    expect(sampled.source).toEqual({ state: "sample" });
    expect(sampled.days).toEqual([{ day: dayBack(1), fetcher: "gptbot", count: 2 }]);
    expect(cloudflare.asked).toEqual([]);
  });
});
