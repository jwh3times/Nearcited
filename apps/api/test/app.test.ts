import {
  LocationDetailSchema,
  LocationSchema,
  MeSchema,
  OrganizationSchema,
  type ScanMessage,
  ScanSchema,
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
    SCAN_QUEUE: {
      send: async (message: ScanMessage) => {
        sent.push(message);
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
      max_manual_scans_per_day: expect.any(Number),
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

  it("edits every field of a location, and the change shows on the next load", async () => {
    const { location } = await seed();
    const edit = {
      name: "  Joe's Pizzeria ",
      website: "https://joespizzeria.example",
      phone: "919-555-0100",
      address_line: "12 Fayetteville St",
      city: "Durham",
      region: "NC",
      postal_code: "27701",
      country_code: "ca",
      google_place_id: "ChIJ-example",
      primary_category: "Pizza restaurant",
      scan_frequency: "weekly",
    };
    const response = await call(alice, "PATCH", `/locations/${location.id}`, edit);
    expect(response.status).toBe(200);
    const saved = { ...edit, name: "Joe's Pizzeria", country_code: "CA" };
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
    organization.max_manual_scans_per_day = 1;

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
