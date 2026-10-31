import {
  ANALYTICS_REPORT_SOURCES,
  type ConnectionMessage,
  ConnectionSchema,
  GoogleStartSchema,
  LocationAnalyticsVisitsSchema,
  LocationSchema,
  OrganizationSchema,
} from "@nearcited/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { availableConnectionKinds, removeConnection, syncConnection } from "../src/connections";
import {
  accessTokenFor,
  GoogleRefused,
  googleState,
  withdrawSignIn,
} from "../src/connections/google";
import { listProperties, readSessions } from "../src/connections/google-analytics";
import { open, sealingKey } from "../src/connections/seal";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

/**
 * Sessions from assistants, read from a business's Google Analytics property (issue #144). Google
 * here is made up: it answers with responses written for these tests, with made-up numbers.
 */

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const carol = "c0000000-0000-4000-8000-000000000003";
const dave = "d0000000-0000-4000-8000-000000000004";
const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const REFRESH = "made-up-refresh-token";
const ACCESS = "made-up-access-token";
const APP = { client_id: "made-up-client", client_secret: "made-up-client-secret" };
const DAY = 86_400_000;
/** Six in the morning (UTC) today: the page counts back from the day it is read. */
const NOW = new Date(Math.floor(Date.now() / DAY) * DAY + 6 * 3_600_000);
/** The day (UTC) `back` days before today. */
const dayBack = (back: number) => new Date(NOW.getTime() - back * DAY).toISOString().slice(0, 10);
const compact = (day: string) => day.replaceAll("-", "");

/** One row of a report, as Google answers it. */
const row = (day: string, source: string, page: string, sessions: number) => ({
  dimensionValues: [{ value: compact(day) }, { value: source }, { value: page }],
  metricValues: [{ value: String(sessions) }],
});

interface FakeGoogle {
  /** What the token endpoint answers a code with. */
  swapped: Record<string, unknown>;
  /** An answer to every token request, as for a sign-in Google refuses. */
  tokenStatus?: { status: number; error: string };
  properties: { property: string; displayName: string }[];
  streams: Record<string, unknown[]>;
  rows: ReturnType<typeof row>[];
  /** Answer the Analytics interfaces with this, as for an outage or a revoked access. */
  apiStatus?: { status: number; body?: unknown };
  revokeStatus?: { status: number; error?: string };
  /** Answer every request with a redirect somewhere else. */
  redirects?: boolean;
  asked: { url: string; body: unknown; auth: string | null }[];
}

let google: FakeGoogle;

/** Google as this test makes it up. */
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const text = typeof init?.body === "string" ? init.body : null;
  const form = url.includes("oauth2.googleapis.com") && text ? new URLSearchParams(text) : null;
  const body = form ? Object.fromEntries(form) : text ? JSON.parse(text) : null;
  google.asked.push({ url, body, auth: new Headers(init?.headers).get("Authorization") });
  // The Workers runtime throws on `redirect: "error"`, though Node takes it, so a sign-in is kept
  // from going on through a redirect by asking for "manual" and not following what comes back.
  expect(init?.redirect).toBe("manual");
  if (google.redirects) {
    return new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } });
  }
  if (url === "https://oauth2.googleapis.com/token") {
    if (google.tokenStatus) {
      return Response.json(
        { error: google.tokenStatus.error },
        { status: google.tokenStatus.status },
      );
    }
    return body.grant_type === "refresh_token"
      ? Response.json({ access_token: ACCESS, expires_in: 3599 })
      : Response.json(google.swapped);
  }
  if (url === "https://oauth2.googleapis.com/revoke") {
    const { status, error } = google.revokeStatus ?? { status: 200 };
    return Response.json(error ? { error } : {}, { status });
  }
  if (google.apiStatus) {
    return Response.json(google.apiStatus.body ?? {}, { status: google.apiStatus.status });
  }
  if (url.startsWith("https://analyticsadmin.googleapis.com/v1beta/accountSummaries")) {
    return Response.json({
      accountSummaries: [{ account: "accounts/1", propertySummaries: google.properties }],
    });
  }
  const streams = url.match(
    /analyticsadmin\.googleapis\.com\/v1beta\/(properties\/\d+)\/dataStreams/,
  );
  if (streams?.[1]) return Response.json({ dataStreams: google.streams[streams[1]] ?? [] });
  if (url.startsWith("https://analyticsdata.googleapis.com/v1beta/properties/")) {
    const offset = Number(body.offset ?? 0);
    const limit = Number(body.limit);
    const inRange = google.rows.filter((kept) => {
      const day = kept.dimensionValues[0]?.value ?? "";
      const [{ startDate, endDate }] = body.dateRanges;
      return day >= compact(startDate) && day <= compact(endDate);
    });
    return Response.json({
      rows: inRange.slice(offset, offset + limit),
      rowCount: inRange.length,
    });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const webStream = (uri: string) => ({
  type: "WEB_DATA_STREAM",
  displayName: "Site",
  webStreamData: { defaultUri: uri, measurementId: "G-MADEUP" },
});

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
  google: APP,
  now,
});

const visitsOf = async (user: string, locationId: string) =>
  LocationAnalyticsVisitsSchema.parse(
    await (await call(user, "GET", `/locations/${locationId}/analytics-visits`)).json(),
  );

/** Alice's organization, on a plan that counts visits, with Bob a member, and three locations. */
async function organization() {
  const made = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Joe's Pizza" })).json(),
  );
  db.memberships.push({ organization_id: made.id, user_id: bob, role: "member" });
  const kept = db.organizations.find((o) => o.id === made.id);
  if (kept) Object.assign(kept, { allowances: { visits: true }, max_locations: 10 });
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

const startPath = (organizationId: string) =>
  `/organizations/${organizationId}/connections/google-analytics/start`;
const returnPath = (organizationId: string) =>
  `/organizations/${organizationId}/connections/google-analytics`;

/** Starts a sign-in as Alice, and hands back the `state` Google would be given. */
async function started(organizationId: string, user = alice) {
  const answered = GoogleStartSchema.parse(
    await (await call(user, "POST", startPath(organizationId))).json(),
  );
  return new URL(answered.url).searchParams.get("state") ?? "";
}

/** A connection Alice made through Google's sign-in. */
async function connected(organizationId: string) {
  const state = await started(organizationId);
  const response = await call(alice, "POST", returnPath(organizationId), {
    code: "made-up-code",
    state,
  });
  expect(response.status).toBe(201);
  return ConnectionSchema.parse(await response.json());
}

beforeEach(() => {
  db = createMemoryDb();
  queued = [];
  google = {
    swapped: {
      access_token: ACCESS,
      refresh_token: REFRESH,
      scope: "https://www.googleapis.com/auth/analytics.readonly",
      expires_in: 3599,
    },
    properties: [
      { property: "properties/1", displayName: "Joe's site" },
      { property: "properties/2", displayName: "Somebody else's" },
    ],
    streams: {
      "properties/1": [webStream("https://www.joes.example")],
      "properties/2": [webStream("https://other.example")],
    },
    rows: [],
    asked: [],
  };
  env = {
    PROVIDER_MODE: "live",
    CONNECTIONS_KEY: SECRET,
    APP_URL: "https://app.example/",
    GOOGLE_CLIENT_ID: APP.client_id,
    GOOGLE_CLIENT_SECRET: APP.client_secret,
    SCAN_QUEUE: {
      send: async (message: ConnectionMessage) => {
        queued.push(message);
      },
      sendBatch: async (messages: { body: ConnectionMessage }[]) => {
        queued.push(...messages.map((message) => message.body));
      },
    },
  } as unknown as Env;
  vi.stubGlobal("fetch", fakeFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google", () => {
  it("lists the properties a sign-in reaches, each with the hosts its web streams measure", async () => {
    google.streams["properties/1"] = [
      webStream("https://www.joes.example/"),
      webStream("http://shop.joes.example"),
      // An app's stream measures no website, and a web stream may name none.
      { type: "ANDROID_APP_DATA_STREAM", androidAppStreamData: { packageName: "example.joes" } },
      { type: "WEB_DATA_STREAM", webStreamData: {} },
    ];
    expect(await listProperties(ACCESS, { fetch: fakeFetch })).toEqual([
      { id: "properties/1", label: "Joe's site", hosts: ["joes.example", "shop.joes.example"] },
      { id: "properties/2", label: "Somebody else's", hosts: ["other.example"] },
    ]);
    expect(google.asked.every((asked) => asked.auth === `Bearer ${ACCESS}`)).toBe(true);
  });

  it("is asked for sessions from assistants alone, and what it answers is kept as counts", async () => {
    google.rows = [
      row("2026-10-27", "chatgpt.com", "/", 12),
      // Two spellings of one assistant are one count.
      row("2026-10-27", "chat.openai.com", "/", 3),
      row("2026-10-27", "www.perplexity.ai", "/menu?from=answer", 4),
      // Google names no page for this one. It is counted, under no page.
      row("2026-10-28", "claude.ai", "(not set)", 2),
      // A source that only looks like one, should Google answer with one all the same.
      row("2026-10-28", "notchatgpt.com", "/", 50),
      row("2026-10-28", "chatgpt.com", `/${"a".repeat(300)}`, 1),
    ];
    const counts = await readSessions(
      ACCESS,
      "properties/1",
      { from: "2026-10-27", to: "2026-10-28" },
      { fetch: fakeFetch },
    );
    expect(counts).toEqual([
      { day: "2026-10-27", assistant: "chatgpt", path: "/", count: 15 },
      { day: "2026-10-27", assistant: "perplexity", path: "/menu", count: 4 },
      { day: "2026-10-28", assistant: "claude", path: "", count: 2 },
      { day: "2026-10-28", assistant: "chatgpt", path: `/${"a".repeat(199)}`, count: 1 },
    ]);
    const [asked] = google.asked;
    expect(asked?.url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/1:runReport");
    expect(asked?.body).toMatchObject({
      dateRanges: [{ startDate: "2026-10-27", endDate: "2026-10-28" }],
      dimensions: [{ name: "date" }, { name: "sessionSource" }, { name: "landingPage" }],
      metrics: [{ name: "sessions" }],
    });
    // Nothing is asked about a session that did not come from an assistant.
    const sent = asked?.body as
      | { dimensionFilter: { orGroup: { expressions: unknown[] } } }
      | undefined;
    const filter = sent?.dimensionFilter.orGroup.expressions;
    expect(filter).toHaveLength(ANALYTICS_REPORT_SOURCES.length);
    expect(filter).toContainEqual({
      filter: {
        fieldName: "sessionSource",
        stringFilter: { matchType: "FULL_REGEXP", value: "(.+\\.)?chatgpt\\.com" },
      },
    });
  });

  it("is read a page of rows at a time, until the report is finished", async () => {
    google.rows = Array.from({ length: 25_000 }, (_, at) =>
      row("2026-10-27", "chatgpt.com", `/p${at}`, 1),
    );
    const counts = await readSessions(
      ACCESS,
      "properties/1",
      { from: "2026-10-27", to: "2026-10-27" },
      { fetch: fakeFetch },
    );
    expect(counts).toHaveLength(25_000);
    expect(google.asked).toHaveLength(3);
  });

  it("refuses only what taking the sign-in away would explain", async () => {
    google.apiStatus = { status: 401 };
    await expect(listProperties(ACCESS, { fetch: fakeFetch })).rejects.toThrow(GoogleRefused);
    google.apiStatus = {
      status: 403,
      body: {
        error: {
          status: "PERMISSION_DENIED",
          details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
        },
      },
    };
    await expect(listProperties(ACCESS, { fetch: fakeFetch })).rejects.toThrow(GoogleRefused);
    for (const apiStatus of [
      // This product's own project is at fault, and the owner can do nothing about it.
      { status: 403, body: { error: { details: [{ reason: "SERVICE_DISABLED" }] } } },
      { status: 429 },
      { status: 500 },
    ]) {
      google.apiStatus = apiStatus;
      await expect(listProperties(ACCESS, { fetch: fakeFetch })).rejects.not.toThrow(GoogleRefused);
    }
  });

  it("never sends a sign-in on through a redirect, and does not take one for an answer", async () => {
    google.redirects = true;
    await expect(listProperties(ACCESS, { fetch: fakeFetch })).rejects.not.toThrow(GoogleRefused);
    await expect(accessTokenFor(APP, REFRESH, { fetch: fakeFetch })).rejects.not.toThrow(
      GoogleRefused,
    );
    expect(await withdrawSignIn(REFRESH, { fetch: fakeFetch })).toBe(false);
    expect(google.asked.map((asked) => asked.url)).not.toContain("https://elsewhere.example/");
  });

  it("takes a sign-in back, and a sign-in already gone is taken back", async () => {
    expect(await withdrawSignIn(REFRESH, { fetch: fakeFetch })).toBe(true);
    expect(google.asked[0]).toMatchObject({
      url: "https://oauth2.googleapis.com/revoke",
      body: { token: REFRESH },
    });
    google.revokeStatus = { status: 400, error: "invalid_token" };
    expect(await withdrawSignIn(REFRESH, { fetch: fakeFetch })).toBe(true);
    google.revokeStatus = { status: 503 };
    expect(await withdrawSignIn(REFRESH, { fetch: fakeFetch })).toBe(false);
  });
});

describe("the kind of connection", () => {
  const onPlan = { is_test: false, allowances: { visits: true as const } };

  it("is offered only with both Google secrets, the sealing key and the visits allowance", () => {
    const has = (
      over: Partial<Env>,
      organization: Parameters<typeof availableConnectionKinds>[1],
    ) => availableConnectionKinds({ ...env, ...over }, organization).includes("google_analytics");
    expect(has({}, onPlan)).toBe(true);
    expect(has({ GOOGLE_CLIENT_ID: undefined }, onPlan)).toBe(false);
    expect(has({ GOOGLE_CLIENT_SECRET: undefined }, onPlan)).toBe(false);
    expect(has({ CONNECTIONS_KEY: undefined }, onPlan)).toBe(false);
    expect(has({}, { ...onPlan, allowances: {} })).toBe(false);
    expect(has({}, { ...onPlan, is_test: true })).toBe(false);
    expect(has({ PROVIDER_MODE: "mock" }, onPlan)).toBe(false);
  });

  it("is never made from something posted to the connections route", async () => {
    const { organization: made } = await organization();
    const response = await call(alice, "POST", `/organizations/${made.id}/connections`, {
      kind: "google_analytics",
    });
    expect(response.status).toBe(422);
    expect(db.connections).toEqual([]);
  });
});

describe("starting a sign-in", () => {
  it("answers an owner or admin Google's sign-in address, for read-only Analytics and nothing else", async () => {
    const { organization: made } = await organization();
    db.memberships.push({ organization_id: made.id, user_id: dave, role: "admin" });
    for (const user of [alice, dave]) {
      const response = await call(user, "POST", startPath(made.id));
      expect(response.status).toBe(200);
      const url = new URL(GoogleStartSchema.parse(await response.json()).url);
      expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        client_id: APP.client_id,
        redirect_uri: "https://app.example/google/return",
        response_type: "code",
        scope: "https://www.googleapis.com/auth/analytics.readonly",
        access_type: "offline",
        prompt: "consent",
      });
      expect(url.searchParams.get("state")).toBeTruthy();
      // The client's secret stays on the server.
      expect(url.toString()).not.toContain(APP.client_secret);
    }
  });

  it("is not found for a member, the operator and a stranger", async () => {
    const { organization: made } = await organization();
    db.operators.add(carol);
    for (const user of [bob, carol, "e0000000-0000-4000-8000-000000000005"]) {
      expect((await call(user, "POST", startPath(made.id))).status, user).toBe(404);
      expect(
        (await call(user, "POST", returnPath(made.id), { code: "c", state: "s" })).status,
        user,
      ).toBe(404);
    }
    expect(google.asked).toEqual([]);
  });

  it("is refused where the kind is not offered", async () => {
    const { organization: made } = await organization();
    env = { ...env, GOOGLE_CLIENT_ID: undefined } as Env;
    expect((await call(alice, "POST", startPath(made.id))).status).toBe(422);
    env = { ...env, GOOGLE_CLIENT_ID: APP.client_id, CONNECTIONS_KEY: undefined } as Env;
    expect((await call(alice, "POST", startPath(made.id))).status).toBe(503);
  });
});

describe("coming back from Google", () => {
  it("swaps the code, seals the sign-in to a new connection, and queues its first sync", async () => {
    const { organization: made } = await organization();
    const state = await started(made.id);
    const response = await call(alice, "POST", returnPath(made.id), {
      code: "made-up-code",
      state,
    });
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain(REFRESH);
    expect(text).not.toContain(ACCESS);
    const connection = ConnectionSchema.parse(JSON.parse(text));
    expect(connection).toMatchObject({
      kind: "google_analytics",
      status: "working",
      organization_id: made.id,
    });

    const sealed = db.connectionSecrets.get(connection.id) ?? "";
    expect(sealed).not.toContain(REFRESH);
    const key = await sealingKey(SECRET);
    if (!key) throw new Error("no key");
    expect(await open(key, connection.id, sealed)).toBe(REFRESH);
    expect(queued).toEqual([{ connection_id: connection.id, step: "sync" }]);

    const [swap] = google.asked;
    expect(swap).toMatchObject({
      url: "https://oauth2.googleapis.com/token",
      body: {
        grant_type: "authorization_code",
        code: "made-up-code",
        client_id: APP.client_id,
        client_secret: APP.client_secret,
        redirect_uri: "https://app.example/google/return",
      },
    });
  });

  it("refuses a state made for someone else, for another organization, expired or changed, and stores nothing", async () => {
    const { organization: made } = await organization();
    db.memberships.push({ organization_id: made.id, user_id: dave, role: "admin" });
    const other = OrganizationSchema.parse(
      await (await call(carol, "POST", "/organizations", { name: "Carol's" })).json(),
    );
    db.memberships.push({ organization_id: other.id, user_id: alice, role: "owner" });
    const allowOther = db.organizations.find((o) => o.id === other.id);
    if (allowOther) allowOther.allowances = { visits: true };
    const key = await sealingKey(SECRET);
    if (!key) throw new Error("no key");
    const good = await started(made.id);
    const bad = [
      await started(made.id, dave),
      await started(other.id),
      await googleState(key, alice, made.id, new Date(Date.now() - 3_600_000)),
      `${good.slice(0, -4)}AAA=`,
      "not-a-state",
    ];
    for (const state of bad) {
      const response = await call(alice, "POST", returnPath(made.id), { code: "code", state });
      expect(response.status, state).toBe(422);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "sign_in_not_started_here",
      );
    }
    expect(db.connections).toEqual([]);
    expect(google.asked).toEqual([]);
  });

  it("stores nothing where Google gave less than was asked, or refused the code", async () => {
    const { organization: made } = await organization();
    const tried = async () => {
      const state = await started(made.id);
      const response = await call(alice, "POST", returnPath(made.id), { code: "code", state });
      return [response.status, ((await response.json()) as { error: { code: string } }).error.code];
    };
    // The owner took Analytics off the list on Google's screen.
    google.swapped = { access_token: ACCESS, refresh_token: REFRESH, scope: "openid email" };
    expect(await tried()).toEqual([422, "analytics_not_allowed"]);
    google.swapped = { access_token: ACCESS, refresh_token: REFRESH };
    expect(await tried()).toEqual([422, "analytics_not_allowed"]);
    google.swapped = {
      access_token: ACCESS,
      scope: "https://www.googleapis.com/auth/analytics.readonly",
    };
    expect(await tried()).toEqual([422, "no_lasting_sign_in"]);
    google.tokenStatus = { status: 400, error: "invalid_grant" };
    expect(await tried()).toEqual([422, "sign_in_refused"]);
    google.tokenStatus = { status: 503, error: "unavailable" };
    expect(await tried()).toEqual([502, "google_unavailable"]);
    expect(db.connections).toEqual([]);
    expect(queued).toEqual([]);
  });
});

describe("a Google Analytics connection", () => {
  it("reads thirty days the first time, for the location whose website the property measures", async () => {
    const { organization: made, main, riverside, elsewhere } = await organization();
    const connection = await connected(made.id);
    for (let back = 1; back <= 31; back++) {
      google.rows.push(row(dayBack(back), "chatgpt.com", "/", 2));
      google.rows.push(row(dayBack(back), "gemini.google.com", "/menu", 1));
    }
    expect(await syncConnection(connection.id, await worker())).toBe("synced");

    const days = new Set(db.analyticsVisits.map((counted) => counted.day));
    expect(days.size).toBe(30);
    expect([...days].sort()[0]).toBe(dayBack(30));
    expect(db.analyticsVisits.every((counted) => counted.location_id === main.id)).toBe(true);
    expect(db.analyticsVisits.every((counted) => !counted.sample_data)).toBe(true);
    // One property, one location: the property is Main Street's, the first made with that website.
    expect(db.connections[0]?.matches.map((m) => [m.location_id, m.external_label])).toEqual([
      [main.id, "Joe's site"],
    ]);
    expect(db.connections[0]?.choices).toEqual([
      { id: "properties/1", label: "Joe's site" },
      { id: "properties/2", label: "Somebody else's" },
    ]);
    // What the line counted is another table, and this adds nothing to it.
    expect(db.visits).toEqual([]);
    // Only the matched property's report is asked for.
    const reports = google.asked.filter((asked) => asked.url.endsWith(":runReport"));
    expect(reports.map((asked) => asked.url)).toEqual([
      "https://analyticsdata.googleapis.com/v1beta/properties/1:runReport",
    ]);

    const mine = await visitsOf(bob, main.id);
    expect(mine.source).toEqual({
      state: "counted",
      property: "Joe's site",
      connection_id: connection.id,
      broken: false,
    });
    expect(mine.since).toBe(dayBack(30));
    expect(mine.through).toBe(dayBack(1));
    expect(mine.days.filter((counted) => counted.day === dayBack(1))).toEqual([
      { day: dayBack(1), assistant: "chatgpt", count: 2 },
      { day: dayBack(1), assistant: "gemini", count: 1 },
    ]);
    expect(mine.pages).toEqual([
      { path: "/", count: 60 },
      { path: "/menu", count: 30 },
    ]);
    expect(mine.other_pages).toBe(0);

    // The other location with the same website names where its sessions are counted.
    const theirs = await visitsOf(bob, riverside.id);
    expect(theirs.source).toEqual({
      state: "elsewhere",
      property: "Joe's site",
      location_id: main.id,
      location_name: "Main Street",
    });
    expect(theirs.days).toEqual([]);
    expect((await visitsOf(alice, elsewhere.id)).source).toEqual({ state: "not_matched" });

    db.operators.add(dave);
    expect((await visitsOf(dave, main.id)).days.length).toBeGreaterThan(0);
    expect((await call(carol, "GET", `/locations/${main.id}/analytics-visits`)).status).toBe(404);
  });

  it("reads from the day after the last read, and the last three days again, replacing them", async () => {
    const { organization: made, main } = await organization();
    const connection = await connected(made.id);
    google.rows = [row(dayBack(1), "chatgpt.com", "/", 3)];
    await syncConnection(connection.id, await worker());
    google.asked = [];

    // A day later Google's figure for that day has grown, and today is finished.
    google.rows = [row(dayBack(1), "chatgpt.com", "/", 8), row(dayBack(0), "claude.ai", "/", 1)];
    expect(await syncConnection(connection.id, await worker(new Date(NOW.getTime() + DAY)))).toBe(
      "synced",
    );
    const report = google.asked.find((asked) => asked.url.endsWith(":runReport"));
    expect(report?.body).toMatchObject({
      dateRanges: [{ startDate: dayBack(2), endDate: dayBack(0) }],
    });
    expect(
      db.analyticsVisits
        .filter((counted) => counted.location_id === main.id)
        .map(({ day, assistant, count }) => [day, assistant, count])
        .sort(),
    ).toEqual([
      [dayBack(1), "chatgpt", 8],
      [dayBack(0), "claude", 1],
    ]);
  });

  it("breaks at once when Google refuses the sign-in, and counts nothing", async () => {
    for (const refuse of [
      () => {
        google.tokenStatus = { status: 400, error: "invalid_grant" };
      },
      () => {
        google.apiStatus = { status: 401 };
      },
    ]) {
      db = createMemoryDb();
      google.tokenStatus = undefined;
      google.apiStatus = undefined;
      const { organization: made } = await organization();
      const connection = await connected(made.id);
      refuse();
      expect(await syncConnection(connection.id, await worker())).toBe("refused");
      expect(db.connections[0]).toMatchObject({ status: "broken", broken_reason: "refused" });
      expect(db.analyticsVisits).toEqual([]);
    }
  });

  it("counts anything else as a failed sync, so reads that keep failing break it", async () => {
    const { organization: made } = await organization();
    const connection = await connected(made.id);
    google.apiStatus = { status: 500 };
    for (let day = 0; day < 3; day++) {
      db.now = new Date(NOW.getTime() + day * DAY).toISOString();
      expect(
        await syncConnection(connection.id, await worker(new Date(NOW.getTime() + day * DAY))),
      ).toBe("failed");
    }
    expect(db.connections[0]).toMatchObject({ status: "broken", broken_reason: "failing" });
    expect(db.connections[0]?.last_synced_at).toBeNull();
  });

  it("cannot be read without the deployment's Google secrets, and nothing is changed", async () => {
    const { organization: made } = await organization();
    const connection = await connected(made.id);
    const { google: _dropped, ...without } = await worker();
    expect(await syncConnection(connection.id, without)).toBe("unreadable");
    expect(db.connections[0]).toMatchObject({ status: "working" });
  });

  it("is never read for a test organization", async () => {
    const { organization: made } = await organization();
    const connection = await connected(made.id);
    const kept = db.organizations.find((o) => o.id === made.id);
    if (kept) kept.is_test = true;
    google.asked = [];
    expect(await syncConnection(connection.id, await worker())).toBe("not_working");
    expect(google.asked).toEqual([]);
  });

  it("withdraws the access at Google before it is removed", async () => {
    const { organization: made } = await organization();
    const connection = await connected(made.id);
    await call(alice, "DELETE", `/connections/${connection.id}`);
    google.asked = [];
    expect(await removeConnection(connection.id, await worker())).toBe("removed");
    expect(google.asked.map((asked) => asked.url)).toEqual([
      "https://oauth2.googleapis.com/revoke",
    ]);
    expect(google.asked[0]?.body).toEqual({ token: REFRESH });
    expect(db.connectionSecrets.has(connection.id)).toBe(false);
    expect(db.connections[0]).toMatchObject({ status: "removed" });
  });

  it("is removed all the same where Google could not be asked, and says so", async () => {
    const { organization: made } = await organization();
    const connection = await connected(made.id);
    await call(alice, "DELETE", `/connections/${connection.id}`);
    google.revokeStatus = { status: 503 };
    expect(await removeConnection(connection.id, await worker())).toBe("left_at_site");
    expect(db.connectionSecrets.has(connection.id)).toBe(false);
  });

  it("keeps what it counted when it is removed", async () => {
    const { organization: made, main } = await organization();
    const connection = await connected(made.id);
    google.rows = [row(dayBack(1), "chatgpt.com", "/", 3)];
    await syncConnection(connection.id, await worker());
    await call(alice, "DELETE", `/connections/${connection.id}`);
    await removeConnection(connection.id, await worker());
    const after = await visitsOf(alice, main.id);
    expect(after.source).toEqual({ state: "not_connected" });
    expect(after.days).toHaveLength(1);
  });

  it("is never matched to a location by hand", async () => {
    const { organization: made, riverside } = await organization();
    const connection = await connected(made.id);
    await syncConnection(connection.id, await worker());
    for (const [method, body] of [
      ["PUT", { external_id: "properties/1" }],
      ["DELETE", undefined],
    ] as const) {
      const response = await call(
        alice,
        method,
        `/connections/${connection.id}/locations/${riverside.id}`,
        body,
      );
      expect(response.status).toBe(422);
    }
  });

  it("proposes no action, since it can only read", async () => {
    const { proposeAfterSync } = await import("../src/actions");
    const { organization: made } = await organization();
    const connection = await connected(made.id);
    await syncConnection(connection.id, await worker());
    expect(await proposeAfterSync(connection.id, await worker())).toBe(0);
  });
});

describe("a location's sessions from assistants", () => {
  it("say why there are none, and what was counted while there were", async () => {
    const { organization: made, main } = await organization();
    expect((await visitsOf(alice, main.id)).source).toEqual({ state: "not_connected" });
    const kept = db.organizations.find((o) => o.id === made.id);
    if (kept) kept.allowances = {};
    expect((await visitsOf(alice, main.id)).source).toEqual({ state: "not_on_plan" });
  });

  it("are the made-up ones for a test organization and on sample data, and never Google's", async () => {
    const { organization: made, main } = await organization();
    const made_up = {
      location_id: main.id,
      day: dayBack(1),
      assistant: "chatgpt" as const,
      path: "/",
      count: 2,
      sample_data: true,
    };
    db.analyticsVisits.push(made_up);
    expect((await visitsOf(alice, main.id)).days).toEqual([]);

    env = { ...env, PROVIDER_MODE: "mock" } as Env;
    const sampled = await visitsOf(alice, main.id);
    expect(sampled.source).toEqual({ state: "sample" });
    expect(sampled.days).toEqual([{ day: dayBack(1), assistant: "chatgpt", count: 2 }]);

    env = { ...env, PROVIDER_MODE: "live" } as Env;
    const kept = db.organizations.find((o) => o.id === made.id);
    if (kept) kept.is_test = true;
    expect((await visitsOf(alice, main.id)).source).toEqual({ state: "sample" });
    expect(google.asked).toEqual([]);
  });
});
