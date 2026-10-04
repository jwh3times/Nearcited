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
    expect(detail.recommendations).toEqual([]);
  });

  it("hides another organization's location as a 404, for reads and writes", async () => {
    const { location, query } = await seed();
    for (const [method, path, body] of [
      ["GET", `/locations/${location.id}`, undefined],
      ["DELETE", `/locations/${location.id}`, undefined],
      ["POST", `/locations/${location.id}/queries`, { kind: "ai_prompt", text: "x" }],
      ["DELETE", `/queries/${query.id}`, undefined],
      ["GET", `/locations/${location.id}/scans`, undefined],
      ["POST", `/locations/${location.id}/scans`, undefined],
    ] as const) {
      const response = await call(bob, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(db.locations).toHaveLength(1);
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

  it("deletes a query and a location", async () => {
    const { location, query } = await seed();
    expect((await call(alice, "DELETE", `/queries/${query.id}`)).status).toBe(204);
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
