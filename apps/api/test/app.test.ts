import {
  LocationDetailSchema,
  LocationSchema,
  MeSchema,
  OperatorAccountsSchema,
  OperatorAuditSchema,
  OperatorOverviewSchema,
  OperatorSpendSchema,
  OrganizationSchema,
  type Plan,
  PlanSchema,
  type ScanMessage,
  ScanSchema,
  SURFACES,
  TrackedQuerySchema,
} from "@nearcited/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import type { Store } from "../src/store/types";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";

let db: MemoryDb;
let sent: ScanMessage[];
let env: Env;

/** In these tests the bearer token is simply the user's ID. */
const app = createApp({
  authenticate: async (request) => {
    const userId = request.headers.get("Authorization")?.replace("Bearer ", "");
    return userId
      ? { user: { id: userId, email: `${userId}@example.com` }, store: memoryStore(db, userId) }
      : null;
  },
  publicStore: () => memoryStore(db, "nobody"),
  deployment: {
    models: { chatgpt: "test-gpt", claude: "test-claude" },
    rates: {
      "test-gpt": {
        input_per_million: 2,
        cached_input_per_million: 0.5,
        output_per_million: 10,
        per_thousand_searches: 10,
      },
    },
  },
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
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
  );
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

/** Alice's organization with one location and one tracked prompt. */
async function seed() {
  const organization = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  const location = LocationSchema.parse(
    await (
      await call(alice, "POST", `/organizations/${organization.id}/locations`, {
        name: "Joe's Pizza",
        city: "Raleigh",
      })
    ).json(),
  );
  const query = TrackedQuerySchema.parse(
    await (
      await call(alice, "POST", `/locations/${location.id}/queries`, {
        kind: "ai_prompt",
        text: "best pizza in Raleigh",
      })
    ).json(),
  );
  return { organization, location, query };
}

beforeEach(() => {
  db = createMemoryDb();
  sent = [];
  env = {
    PROVIDER_MODE: "mock",
    COMMIT: "abc1234",
    SCAN_QUEUE: {
      send: async (message: ScanMessage) => {
        sent.push(message);
      },
      sendBatch: async (messages: { body: ScanMessage }[]) => {
        sent.push(...messages.map((message) => message.body));
      },
    },
  } as unknown as Env;
});

describe("access", () => {
  it("answers the health check without a token", async () => {
    const response = await call(null, "GET", "/health");
    expect(response.status).toBe(200);
  });

  it("rejects everything else without a token", async () => {
    const response = await call(null, "GET", "/me");
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("unauthenticated");
  });

  it("returns JSON for an unknown route", async () => {
    const response = await call(alice, "GET", "/nope");
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });
});

describe("plans", () => {
  const plan = (key: string, position: number, change: Partial<Plan> = {}): Plan => ({
    key,
    name: key,
    position,
    on_sale: true,
    price_cents: position * 1000,
    included_locations: 1,
    extra_location_price_cents: null,
    max_queries_per_location: 5,
    assistants: 1,
    scan_every_days: 2,
    max_manual_scans_per_month: 2,
    emails_report: true,
    stronger_models: false,
    ...change,
  });

  it("shows the price list to anyone, cheapest first, without a sign-in", async () => {
    db.plans.push(plan("standard", 2), plan("free", 0), plan("retired", 9, { on_sale: false }));
    const response = await call(null, "GET", "/plans");
    expect(response.status).toBe(200);
    const plans = PlanSchema.array().parse(await response.json());
    expect(plans.map((row) => row.key)).toEqual(["free", "standard"]);
  });

  it("lets an owner choose their assistant within the plan, and nobody else", async () => {
    db.plans.push(plan("free", 0), plan("standard", 2, { assistants: 2 }));
    const { organization } = await seed();
    const path = `/organizations/${organization.id}/assistants`;
    const mine = db.organizations.find((row) => row.id === organization.id);
    if (!mine) throw new Error("organization missing");

    // Set by hand: there is no plan to choose within.
    const byHand = await call(alice, "PUT", path, { surfaces: ["claude"] });
    expect(byHand.status).toBe(409);
    expect(await errorCode(byHand)).toBe("limit_reached");

    mine.plan_key = "free";
    expect((await call(bob, "PUT", path, { surfaces: ["claude"] })).status).toBe(404);
    expect((await call(null, "PUT", path, { surfaces: ["claude"] })).status).toBe(401);
    for (const bad of [{ surfaces: [] }, { surfaces: ["gemini"] }, {}]) {
      expect((await call(alice, "PUT", path, bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await call(alice, "PUT", path, { surfaces: ["chatgpt", "claude"] })).status).toBe(409);
    expect(mine.surfaces).toBeNull();

    const chosen = OrganizationSchema.parse(
      await (await call(alice, "PUT", path, { surfaces: ["claude"] })).json(),
    );
    expect(chosen.surfaces).toEqual(["claude"]);
  });

  it("shows a plan taken off sale to the organization still on it", async () => {
    db.plans.push(plan("free", 0), plan("retired", 9, { on_sale: false }));
    const { organization } = await seed();
    const mine = db.organizations.find((row) => row.id === organization.id);
    if (mine) mine.plan_key = "retired";
    expect((await memoryStore(db, alice).listPlans()).map((row) => row.key)).toEqual([
      "free",
      "retired",
    ]);
    expect((await memoryStore(db, bob).listPlans()).map((row) => row.key)).toEqual(["free"]);
  });
});

describe("organizations and locations", () => {
  it("creates an organization and lists it for its creator only", async () => {
    await seed();

    const mine = MeSchema.parse(await (await call(alice, "GET", "/me")).json());
    expect(mine.organizations.map((organization) => organization.name)).toEqual([
      "Raleigh Pizza Group",
    ]);
    expect(mine.sample_data).toBe(true);
    // The limits travel with the organization, so the app can show them before they are hit.
    expect(mine.organizations[0]).toMatchObject({
      max_locations: expect.any(Number),
      max_queries_per_location: expect.any(Number),
      max_manual_scans_per_month: expect.any(Number),
      scan_every_days: expect.any(Number),
      surfaces: null,
    });

    const theirs = MeSchema.parse(await (await call(bob, "GET", "/me")).json());
    expect(theirs.organizations).toEqual([]);
  });

  it("reports live mode as not sample data", async () => {
    env.PROVIDER_MODE = "live";
    const me = MeSchema.parse(await (await call(alice, "GET", "/me")).json());
    expect(me.sample_data).toBe(false);
  });

  it("rejects a body that is not JSON", async () => {
    const response = await call(alice, "POST", "/organizations", "{nope");
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_json");
  });

  it("rejects invalid input and says which field", async () => {
    const { organization } = await seed();
    const response = await call(alice, "POST", `/organizations/${organization.id}/locations`, {
      name: "",
      city: "Raleigh",
      website: "ftp://example.com",
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("name:");
    expect(body.error.message).toContain("website:");
  });

  it("refuses to add a location to an organization the caller is not in", async () => {
    const { organization } = await seed();
    const response = await call(bob, "POST", `/organizations/${organization.id}/locations`, {
      name: "Planted",
      city: "Raleigh",
    });
    expect(response.status).toBe(403);
    expect(db.locations).toHaveLength(1);
  });

  it("returns a location with its queries, latest scan and recommendations", async () => {
    const { location, query } = await seed();
    const detail = LocationDetailSchema.parse(
      await (await call(alice, "GET", `/locations/${location.id}`)).json(),
    );
    expect(detail.location.id).toBe(location.id);
    expect(detail.queries.map((q) => q.id)).toEqual([query.id]);
    expect(detail.latest_scan).toBeNull();
    expect(detail.window).toEqual({ size: 7, scans: 0, cells: [], answers: 0, sources: [] });
    // Sample data covers every surface.
    expect(detail.surfaces).toHaveLength(7);
    expect(detail.recommendations).toEqual([]);
  });

  it("lists only the surfaces the organization's plan covers", async () => {
    const { location } = await seed();
    const organization = db.organizations.find((o) => o.id === location.organization_id);
    if (!organization) throw new Error("no organization");
    organization.surfaces = ["claude", "google_local_pack"];

    const detail = LocationDetailSchema.parse(
      await (await call(alice, "GET", `/locations/${location.id}`)).json(),
    );
    expect(detail.surfaces).toEqual(["claude", "google_local_pack"]);
  });

  it("returns how often the business was named over the recent successful scans", async () => {
    const { location, query } = await seed();
    const worker = memoryStore(db, null);
    const result = (mentioned: boolean) => ({
      tracked_query_id: query.id,
      surface: "chatgpt" as const,
      mentioned,
      position: mentioned ? 1 : null,
      competitors: [],
      cited_urls: ["https://reviews.example/best-pizza"],
      answer_excerpt: null,
    });
    for (const mentioned of [true, false, true]) {
      const scan = await worker.createScan(location.id, "scheduled", null);
      await worker.markScanRunning(scan.id, true);
      await worker.completeScan(scan.id, {
        score: 0,
        results: [result(mentioned)],
        recommendations: [],
      });
    }
    // A failed scan and one of the other kind are not counted.
    const failed = await worker.createScan(location.id, "scheduled", null);
    await worker.markScanRunning(failed.id, true);
    await worker.failScan(failed.id, "upstream 503");
    const real = await worker.createScan(location.id, "scheduled", null);
    await worker.markScanRunning(real.id, false);
    await worker.completeScan(real.id, { score: 0, results: [result(false)], recommendations: [] });

    const detail = LocationDetailSchema.parse(
      await (await call(alice, "GET", `/locations/${location.id}`)).json(),
    );
    expect(detail.window).toEqual({
      size: 7,
      scans: 3,
      cells: [
        {
          tracked_query_id: query.id,
          surface: "chatgpt",
          checks: 3,
          mentions: 2,
          history: [true, false, true],
        },
      ],
      // The sites those three answers cited, and how many of the answers named the business.
      answers: 3,
      sources: [
        {
          host: "reviews.example",
          answers: 3,
          named: 2,
          own: false,
          urls: ["https://reviews.example/best-pizza"],
        },
      ],
    });
  });

  it("returns the action plan and the website check from the latest successful scan", async () => {
    const { location, query } = await seed();
    const worker = memoryStore(db, null);
    const site = {
      url: "https://joes.example/",
      status: 200,
      checks: [
        { id: "reachable" as const, passed: true },
        { id: "text_content" as const, passed: false },
      ],
      blocked_crawlers: [],
      words: 12,
    };
    const answer = (mentioned: boolean, cited: string) => ({
      tracked_query_id: query.id,
      surface: "chatgpt" as const,
      mentioned,
      position: mentioned ? 1 : null,
      competitors: ["Tony's Slice House"],
      cited_urls: [cited],
      answer_excerpt: null,
    });
    for (const result of [
      answer(false, "https://yelp.example/raleigh"),
      answer(false, "https://yelp.example/raleigh"),
      answer(true, "https://maps.example/joes"),
    ]) {
      const scan = await worker.createScan(location.id, "scheduled", null);
      await worker.markScanRunning(scan.id, true);
      await worker.completeScan(scan.id, {
        score: 0,
        results: [result],
        recommendations: [],
        site,
      });
    }

    const detail = LocationDetailSchema.parse(
      await (await call(alice, "GET", `/locations/${location.id}`)).json(),
    );
    expect(detail.site).toEqual(site);
    expect(
      detail.actions.map((action) => [action.id, action.items.map((item) => item.label)]),
    ).toEqual([
      ["get_listed", ["yelp.example"]],
      ["keep_listings", ["maps.example"]],
      ["competitors", ["Tony's Slice House"]],
    ]);

    // A stranger sees neither.
    expect((await call(bob, "GET", `/locations/${location.id}`)).status).toBe(404);
    expect(await memoryStore(db, bob).getSiteCheck(location.id)).toBeNull();
  });

  it("hides another organization's location as a 404, for reads and writes", async () => {
    const { location, query } = await seed();
    for (const [method, path, body] of [
      ["GET", `/locations/${location.id}`, undefined],
      ["PATCH", `/locations/${location.id}`, { name: "Defaced", city: "Raleigh" }],
      ["DELETE", `/locations/${location.id}`, undefined],
      ["POST", `/locations/${location.id}/queries`, { kind: "ai_prompt", text: "x" }],
      ["PATCH", `/queries/${query.id}`, { is_active: false }],
      ["GET", `/locations/${location.id}/scans`, undefined],
      ["POST", `/locations/${location.id}/scans`, undefined],
    ] as const) {
      const response = await call(bob, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(db.locations).toHaveLength(1);
    expect(db.locations[0]?.name).toBe(location.name);
    expect(db.queries).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it("treats a malformed ID as not found", async () => {
    const response = await call(alice, "GET", "/locations/not-a-uuid");
    expect(response.status).toBe(404);
  });

  it("reports a duplicate query as a conflict", async () => {
    const { location } = await seed();
    const response = await call(alice, "POST", `/locations/${location.id}/queries`, {
      kind: "ai_prompt",
      text: "best pizza in Raleigh",
    });
    expect(response.status).toBe(409);
  });

  it("retires a prompt and restores it, without deleting anything", async () => {
    const { query } = await seed();
    const retired = await call(alice, "PATCH", `/queries/${query.id}`, { is_active: false });
    expect(retired.status).toBe(200);
    expect(await retired.json()).toMatchObject({ id: query.id, is_active: false });
    expect(db.queries).toHaveLength(1);

    const restored = await call(alice, "PATCH", `/queries/${query.id}`, { is_active: true });
    expect(await restored.json()).toMatchObject({ id: query.id, is_active: true });
  });

  it("has no way to delete a prompt", async () => {
    const { query } = await seed();
    expect((await call(alice, "DELETE", `/queries/${query.id}`)).status).toBe(404);
    expect(db.queries).toHaveLength(1);
  });

  it("restores a retired prompt when the same wording is added again", async () => {
    const { location, query } = await seed();
    await call(alice, "PATCH", `/queries/${query.id}`, { is_active: false });

    const added = await call(alice, "POST", `/locations/${location.id}/queries`, {
      kind: query.kind,
      text: query.text,
    });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ id: query.id, is_active: true });
    expect(db.queries).toHaveLength(1);
  });

  it("rejects an update that does not say whether the prompt is active", async () => {
    const { query } = await seed();
    expect((await call(alice, "PATCH", `/queries/${query.id}`, {})).status).toBe(422);
  });

  it("refuses a location past the organization's limit, saying what the limit is", async () => {
    const { location } = await seed();
    const organization = db.organizations.find((o) => o.id === location.organization_id);
    if (!organization) throw new Error("no organization");
    organization.max_locations = 1;

    const response = await call(alice, "POST", `/organizations/${organization.id}/locations`, {
      name: "Second Shop",
      city: "Durham",
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("limit_reached");
    expect(body.error.message).toContain("1 location");
    expect(db.locations).toHaveLength(1);
  });

  it("counts only active prompts toward the limit, so retiring one makes room", async () => {
    const { location, query } = await seed();
    const organization = db.organizations.find((o) => o.id === location.organization_id);
    if (!organization) throw new Error("no organization");
    organization.max_queries_per_location = 1;
    const add = (text: string) =>
      call(alice, "POST", `/locations/${location.id}/queries`, { kind: "ai_prompt", text });

    const refused = await add("another prompt");
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("limit_reached");

    await call(alice, "PATCH", `/queries/${query.id}`, { is_active: false });
    expect((await add("another prompt")).status).toBe(201);
    // Restoring the first would make two active, which is over the limit again.
    const restore = await call(alice, "PATCH", `/queries/${query.id}`, { is_active: true });
    expect(restore.status).toBe(409);
    expect(await errorCode(restore)).toBe("limit_reached");
  });

  it("shows a test organization its generated results, in a deployment that is live", async () => {
    env.PROVIDER_MODE = "live";
    db.testAccounts.add(bob);
    const organization = OrganizationSchema.parse(
      await (await call(bob, "POST", "/organizations", { name: "Smoke test" })).json(),
    );
    expect(organization.is_test).toBe(true);
    const location = LocationSchema.parse(
      await (
        await call(bob, "POST", `/organizations/${organization.id}/locations`, {
          name: "Joe's Pizza",
          city: "Raleigh",
        })
      ).json(),
    );
    const detail = LocationDetailSchema.parse(
      await (await call(bob, "GET", `/locations/${location.id}`)).json(),
    );
    // No live provider is set up here, yet every surface is listed: generated data covers them.
    expect(detail.surfaces).toEqual([...SURFACES]);

    // An ordinary organization in the same deployment is told only what is really checked.
    const real = await seed();
    const theirs = LocationDetailSchema.parse(
      await (await call(alice, "GET", `/locations/${real.location.id}`)).json(),
    );
    expect(real.organization.is_test).toBe(false);
    expect(theirs.surfaces).toEqual([]);
  });

  it("tells an account its platform role, which nearly nobody has", async () => {
    await seed();
    const role = async (user: string) =>
      MeSchema.parse(await (await call(user, "GET", "/me")).json()).platform_role;
    expect(await role(alice)).toBeNull();
    db.operators.add(alice);
    db.testAccounts.add(bob);
    expect(await role(alice)).toBe("operator");
    expect(await role(bob)).toBe("test");
  });

  it("shows the operator every organization, and nobody else that there is anything to show", async () => {
    const { organization, location } = await seed();
    await call(bob, "POST", "/organizations", { name: "Bob's Bakery" });

    // To anyone else the operator's routes do not exist.
    for (const path of ["/operator/overview", `/operator/organizations/${organization.id}`]) {
      expect((await call(alice, "GET", path)).status, path).toBe(404);
      expect((await call(null, "GET", path)).status, path).toBe(401);
    }

    db.operators.add(bob);
    const overview = OperatorOverviewSchema.parse(
      await (await call(bob, "GET", "/operator/overview")).json(),
    );
    expect(overview.totals).toMatchObject({ organizations: 2, locations: 1 });
    expect(overview.organizations.map((row) => [row.name, row.is_yours])).toEqual([
      ["Bob's Bakery", true],
      ["Raleigh Pizza Group", false],
    ]);
    expect(overview.deployment).toEqual({
      sample_data: true,
      models: { chatgpt: "test-gpt", claude: "test-claude" },
      commit: "abc1234",
    });
    expect(
      OrganizationSchema.parse(
        await (await call(bob, "GET", `/operator/organizations/${organization.id}`)).json(),
      ).name,
    ).toBe("Raleigh Pizza Group");

    // The operator reads a customer's pages and can change nothing on them.
    expect((await call(bob, "GET", `/locations/${location.id}`)).status).toBe(200);
    expect((await call(bob, "GET", `/organizations/${organization.id}/locations`)).status).toBe(
      200,
    );
    for (const [method, path, body] of [
      ["PATCH", `/locations/${location.id}`, { name: "Defaced", city: "Raleigh" }],
      ["DELETE", `/locations/${location.id}`, undefined],
      ["PATCH", `/organizations/${organization.id}`, { name: "Defaced" }],
      ["POST", `/locations/${location.id}/queries`, { kind: "ai_prompt", text: "best pizza" }],
      ["POST", `/locations/${location.id}/scans`, undefined],
      ["POST", `/organizations/${organization.id}/locations`, { name: "Planted", city: "X" }],
    ] as const) {
      const response = await call(bob, method, path, body);
      expect([403, 404], `${method} ${path}`).toContain(response.status);
    }
    expect(db.locations.map((row) => row.name)).toEqual(["Joe's Pizza"]);
    expect(db.organizations.map((row) => row.name).sort()).toEqual([
      "Bob's Bakery",
      "Raleigh Pizza Group",
    ]);
    // And being able to read them all does not make them the operator's.
    const me = MeSchema.parse(await (await call(bob, "GET", "/me")).json());
    expect(me.organizations.map((row) => row.name)).toEqual(["Bob's Bakery"]);
  });

  it("tells the operator what each month cost, and nobody else, without the rates", async () => {
    const { organization } = await seed();
    await call(bob, "POST", "/organizations", { name: "Bob's Bakery" });
    const used = (model: string, searches: number) => ({
      surface: "chatgpt" as const,
      model,
      calls: 1,
      input_tokens: 1_000_000,
      cached_input_tokens: 0,
      output_tokens: 0,
      searches,
      created_at: new Date().toISOString(),
    });
    const scan = { organization_id: organization.id, scan_id: crypto.randomUUID() };
    db.usage.push(
      { ...scan, ...used("test-gpt", 100) },
      { ...scan, ...used("unknown-model", 0) },
      { audit_id: crypto.randomUUID(), ...used("test-gpt", 0) },
      // Long ago: outside the months shown.
      { ...scan, ...used("test-gpt", 0), created_at: "2020-01-01T00:00:00.000Z" },
    );

    expect((await call(alice, "GET", "/operator/spend")).status).toBe(404);
    expect((await call(null, "GET", "/operator/spend")).status).toBe(401);

    db.operators.add(bob);
    const response = await call(bob, "GET", "/operator/spend");
    const text = await response.text();
    const spend = OperatorSpendSchema.parse(JSON.parse(text));
    expect(spend.months).toHaveLength(3);
    expect(spend.months[0]).toEqual({
      month: new Date().toISOString().slice(0, 7),
      total: 5,
      organizations: [
        { organization_id: organization.id, name: "Raleigh Pizza Group", is_yours: false, cost: 3 },
      ],
      audits: 2,
      deleted: 0,
      unpriced: [{ model: "unknown-model", calls: 1 }],
    });
    expect(spend.months.slice(1).map((month) => month.total)).toEqual([0, 0]);
    // Dollars leave the server. What a model costs does not, here or on the overview.
    expect(text).not.toContain("per_million");
    expect(await (await call(bob, "GET", "/operator/overview")).text()).not.toContain(
      "per_million",
    );
  });

  it("lets the operator change an organization's limits, and nobody else", async () => {
    const { organization } = await seed();
    const path = `/operator/organizations/${organization.id}/limits`;
    const limits = {
      max_locations: 3,
      max_queries_per_location: 20,
      max_manual_scans_per_month: 10,
      scan_every_days: 1,
    };

    // Not its owner, and not by reaching the route signed out.
    expect((await call(alice, "PUT", path, limits)).status).toBe(404);
    expect((await call(null, "PUT", path, limits)).status).toBe(401);
    expect(db.organizations[0]).toMatchObject({ max_locations: organization.max_locations });

    db.operators.add(bob);
    for (const bad of [
      { ...limits, scan_every_days: 0 },
      { ...limits, max_locations: -1 },
      { ...limits, max_queries_per_location: 2.5 },
      { max_locations: 3 },
    ]) {
      expect((await call(bob, "PUT", path, bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect(
      (await call(bob, "PUT", `/operator/organizations/${crypto.randomUUID()}/limits`, limits))
        .status,
    ).toBe(404);

    // Limits set by hand take the organization off any plan, so nothing puts the plan's back.
    const mine = db.organizations.find((row) => row.id === organization.id);
    if (mine) mine.plan_key = "standard";
    const changed = OrganizationSchema.parse(await (await call(bob, "PUT", path, limits)).json());
    expect(changed).toEqual({ ...organization, ...limits, plan_key: null });
    // The owner now has room for a second location, which the default plan refused.
    const me = MeSchema.parse(await (await call(alice, "GET", "/me")).json());
    expect(me.organizations[0]).toMatchObject(limits);
  });

  it("lets the operator make an audit and queues each prompt, and nobody else", async () => {
    await seed();
    env.APP_URL = "https://app.example/";
    const input = {
      business_name: " Tony's Slice House ",
      website: "tonys.example",
      city: "Raleigh",
      region: "",
      prompts: ["best pizza in Raleigh", "late night food"],
      samples: 2,
    };

    expect((await call(alice, "POST", "/operator/audits", input)).status).toBe(404);
    expect((await call(null, "POST", "/operator/audits", input)).status).toBe(401);

    db.operators.add(bob);
    // A prospect reads an audit as a measurement, so it is never made from sample data.
    const refused = await call(bob, "POST", "/operator/audits", input);
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("audits_unavailable");

    env.PROVIDER_MODE = "live";
    for (const bad of [
      { ...input, prompts: [] },
      { ...input, prompts: ["best pizza", "Best Pizza"] },
      { ...input, prompts: Array.from({ length: 6 }, (_, i) => `prompt number ${i}`) },
      { ...input, samples: 6 },
      { ...input, business_name: "" },
      { ...input, website: "not a site" },
    ]) {
      expect((await call(bob, "POST", "/operator/audits", bad)).status, JSON.stringify(bad)).toBe(
        422,
      );
    }
    expect(db.audits).toEqual([]);
    expect(sent).toEqual([]);

    const response = await call(bob, "POST", "/operator/audits", input);
    expect(response.status).toBe(201);
    const made = OperatorAuditSchema.parse(await response.json());
    expect(made).toMatchObject({
      business_name: "Tony's Slice House",
      city: "Raleigh",
      region: null,
      status: "queued",
    });
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      website: "https://tonys.example",
      country_code: "US",
      prompts: input.prompts,
      samples: 2,
    });
    expect(made.link).toBe(`https://app.example/audit/${db.audits[0]?.token}`);
    expect(sent).toEqual([
      { audit_id: made.id, prompt_index: 0 },
      { audit_id: made.id, prompt_index: 1 },
    ]);
    // And it is on the operator's list.
    const list = OperatorAuditSchema.array().parse(
      await (await call(bob, "GET", "/operator/audits")).json(),
    );
    expect(list.map((audit) => audit.id)).toEqual([made.id]);
  });

  it("lists every account and every audit for the operator, and for nobody else", async () => {
    const { organization } = await seed();
    db.operators.add(bob);
    db.accounts.push(
      {
        user_id: alice,
        email: "alice@example.com",
        created_at: "2026-10-01T00:00:00.000Z",
        last_sign_in_at: "2026-10-07T00:00:00.000Z",
      },
      {
        user_id: bob,
        email: "bob@example.com",
        created_at: "2026-09-01T00:00:00.000Z",
        last_sign_in_at: null,
      },
    );
    db.audits.push({
      id: "c0000000-0000-4000-8000-000000000003",
      token: "ab".repeat(32),
      business_name: "Tony's Slice House",
      website: null,
      city: "Raleigh",
      region: "NC",
      country_code: "US",
      prompts: ["best pizza"],
      samples: 3,
      status: "ready",
      parts: {},
      error: null,
      revoked_at: null,
      created_at: "2026-10-07T00:00:00.000Z",
      expires_at: "2999-01-01T00:00:00.000Z",
    });
    env.APP_URL = "https://app.example/";

    for (const path of ["/operator/accounts", "/operator/audits"]) {
      expect((await call(alice, "GET", path)).status, path).toBe(404);
    }

    const accounts = OperatorAccountsSchema.parse(
      await (await call(bob, "GET", "/operator/accounts")).json(),
    );
    expect(
      accounts.accounts.map((account) => [account.email, account.stage, account.platform_role]),
    ).toEqual([
      ["alice@example.com", "location", null],
      ["bob@example.com", "signed_up", "operator"],
    ]);
    expect(accounts.accounts[0]).toMatchObject({
      organization_id: organization.id,
      organization_name: "Raleigh Pizza Group",
    });
    expect(accounts.funnel).toEqual([
      { stage: "signed_up", count: 2 },
      { stage: "organization", count: 1 },
      { stage: "location", count: 1 },
      { stage: "scanned", count: 0 },
      { stage: "active", count: 0 },
    ]);

    const audits = OperatorAuditSchema.array().parse(
      await (await call(bob, "GET", "/operator/audits")).json(),
    );
    expect(audits).toEqual([
      expect.objectContaining({
        business_name: "Tony's Slice House",
        city: "Raleigh",
        status: "ready",
        link: `https://app.example/audit/${"ab".repeat(32)}`,
      }),
    ]);
    // A revoked audit is still listed, and its link, which now leads nowhere, is not.
    const [audit] = db.audits;
    if (audit) audit.revoked_at = "2026-10-08T00:00:00.000Z";
    const after = OperatorAuditSchema.array().parse(
      await (await call(bob, "GET", "/operator/audits")).json(),
    );
    expect(after[0]).toMatchObject({ revoked_at: "2026-10-08T00:00:00.000Z", link: null });
  });

  it("renames an organization, and only for someone in it", async () => {
    const { organization } = await seed();
    const path = `/organizations/${organization.id}`;

    const renamed = await call(alice, "PATCH", path, { name: "  Triangle Pizza Group " });
    expect(renamed.status).toBe(200);
    expect(OrganizationSchema.parse(await renamed.json())).toEqual({
      ...organization,
      name: "Triangle Pizza Group",
    });
    const me = MeSchema.parse(await (await call(alice, "GET", "/me")).json());
    expect(me.organizations[0]?.name).toBe("Triangle Pizza Group");

    // A blank name is refused, and a stranger's rename finds nothing to rename.
    expect((await call(alice, "PATCH", path, { name: "   " })).status).toBe(422);
    expect((await call(bob, "PATCH", path, { name: "Defaced" })).status).toBe(404);
    expect((await call(alice, "PATCH", "/organizations/not-an-id", { name: "x" })).status).toBe(
      404,
    );
    expect(db.organizations[0]?.name).toBe("Triangle Pizza Group");
  });

  it("edits every field of a location, and the change shows on the next load", async () => {
    const { location } = await seed();
    const edit = {
      name: "  Joe's Pizzeria ",
      website: "https://joespizzeria.example",
      phone: "(416) 555-0100",
      address_line: "12 Queen St W",
      city: "Toronto",
      region: "ON",
      postal_code: "m5h2n2",
      country_code: "ca",
      google_place_id: "ChIJN1t_tDeuEmsRUsoyG83frY4",
      primary_category: "Pizza restaurant",
      scan_frequency: "weekly",
    };
    const response = await call(alice, "PATCH", `/locations/${location.id}`, edit);
    expect(response.status).toBe(200);
    // Stored tidied: the name trimmed, the phone with its country code, the codes in upper case.
    const saved = {
      ...edit,
      name: "Joe's Pizzeria",
      phone: "+14165550100",
      postal_code: "M5H 2N2",
      country_code: "CA",
    };
    expect(LocationSchema.parse(await response.json())).toEqual({ ...location, ...saved });

    const loaded = LocationDetailSchema.parse(
      await (await call(alice, "GET", `/locations/${location.id}`)).json(),
    );
    expect(loaded.location).toMatchObject(saved);
  });

  it("clears a field left blank, and refuses an edit that would not pass as a new location", async () => {
    const { location } = await seed();
    const cleared = await call(alice, "PATCH", `/locations/${location.id}`, {
      name: location.name,
      city: location.city,
      website: "",
    });
    expect(LocationSchema.parse(await cleared.json()).website).toBeNull();

    const invalid = await call(alice, "PATCH", `/locations/${location.id}`, {
      name: "",
      city: location.city,
    });
    expect(invalid.status).toBe(422);
    expect(db.locations[0]?.name).toBe(location.name);
  });

  it("deletes a location", async () => {
    const { location } = await seed();
    expect((await call(alice, "DELETE", `/locations/${location.id}`)).status).toBe(204);
    expect((await call(alice, "DELETE", `/locations/${location.id}`)).status).toBe(404);
  });
});

describe("scans", () => {
  it("queues a manual scan and puts its ID on the queue", async () => {
    const { location } = await seed();
    const response = await call(alice, "POST", `/locations/${location.id}/scans`);
    expect(response.status).toBe(202);
    const scan = ScanSchema.parse(await response.json());
    expect(scan).toMatchObject({ status: "queued", trigger: "manual" });
    expect(sent).toEqual([{ scan_id: scan.id }]);
  });

  it("refuses a second scan when the database reports one in flight, even if the check missed it", async () => {
    const { location } = await seed();
    // Two requests arriving together both pass the read; the second insert is what fails.
    const racing = memoryStore(db, alice);
    const store: Store = { ...racing, listScans: async () => [] };
    await store.createScan(location.id, "manual", alice);

    const racingApp = createApp({
      authenticate: async () => ({ user: { id: alice, email: "alice@example.com" }, store }),
    });
    const response = await racingApp.request(
      `/api/locations/${location.id}/scans`,
      { method: "POST" },
      env,
    );
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("scan_in_progress");
    expect(sent).toEqual([]);
  });

  it("refuses a manual scan past the daily limit, and says so", async () => {
    const { location } = await seed();
    const organization = db.organizations.find((o) => o.id === location.organization_id);
    if (!organization) throw new Error("no organization");
    organization.max_manual_scans_per_month = 1;

    const first = await call(alice, "POST", `/locations/${location.id}/scans`);
    expect(first.status).toBe(202);
    const scan = ScanSchema.parse(await first.json());
    await memoryStore(db, null).failScan(scan.id, "upstream 503");

    const second = await call(alice, "POST", `/locations/${location.id}/scans`);
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe("limit_reached");
    expect(sent).toHaveLength(1);
  });

  it("refuses a second scan while one is under way", async () => {
    const { location } = await seed();
    await call(alice, "POST", `/locations/${location.id}/scans`);
    const response = await call(alice, "POST", `/locations/${location.id}/scans`);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("scan_in_progress");
    expect(sent).toHaveLength(1);
  });

  it("returns a scan with its results to a member and a 404 to anyone else", async () => {
    const { location } = await seed();
    const scan = ScanSchema.parse(
      await (await call(alice, "POST", `/locations/${location.id}/scans`)).json(),
    );
    expect((await call(alice, "GET", `/scans/${scan.id}`)).status).toBe(200);
    expect((await call(bob, "GET", `/scans/${scan.id}`)).status).toBe(404);
  });
});

describe("recommendations", () => {
  it("lets a member change the status and hides it from anyone else", async () => {
    const { location } = await seed();
    const id = crypto.randomUUID();
    db.recommendations.push({
      id,
      location_id: location.id,
      scan_id: null,
      rule: "add_website",
      title: "Add the website",
      detail: "Detail",
      status: "open",
      created_at: "2026-10-01T00:00:00Z",
    });

    expect((await call(bob, "PATCH", `/recommendations/${id}`, { status: "done" })).status).toBe(
      404,
    );
    expect(
      (await call(alice, "PATCH", `/recommendations/${id}`, { status: "nonsense" })).status,
    ).toBe(422);
    const response = await call(alice, "PATCH", `/recommendations/${id}`, { status: "done" });
    expect(response.status).toBe(200);
    expect(db.recommendations[0]?.status).toBe("done");
  });
});
