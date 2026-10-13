import {
  type Listing,
  ListingSchema,
  LocationDetailSchema,
  LocationSchema,
  OrganizationSchema,
  TrackedQuerySchema,
} from "@nearcited/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const carol = "c0000000-0000-4000-8000-000000000003";
const dave = "d0000000-0000-4000-8000-000000000004";

const PAGE = "https://www.tripadvisor.com/Restaurant_Review-g1-d2-Joes_Pizza.html";
const OTHER = "https://www.tripadvisor.com/Restaurant_Review-g1-d3-Joes_Pizza_Downtown.html";

let db: MemoryDb;
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

async function problem(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

const worker = () => memoryStore(db, null);

/**
 * Alice's organization, with Bob in it as a member, and a location whose scan read a review site
 * that lets a business ask, one that forbids it and a guide, without naming the business. So it
 * has a task that asks for a listing and two that do not.
 */
async function withTasks() {
  const organization = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  db.memberships.push({ organization_id: organization.id, user_id: bob, role: "member" });
  db.emails.set(alice, "alice@example.com");
  db.emails.set(bob, "bob@example.com");

  const location = LocationSchema.parse(
    await (
      await call(alice, "POST", `/organizations/${organization.id}/locations`, {
        name: "Joe's Pizza",
        city: "Raleigh",
        region: "NC",
        website: "joespizza.example",
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
  await scanThatRead(location.id, query.id, ["m.tripadvisor.com", "yelp.com", "usnews.com"]);
  return { organization, location, query };
}

/** A finished scan whose answer cited a page on each of `hosts` and did not name the business. */
async function scanThatRead(locationId: string, queryId: string, hosts: string[]) {
  const scan = await worker().createScan(locationId, "scheduled", null);
  await worker().markScanRunning(scan.id, true);
  await worker().completeScan(scan.id, {
    score: 0,
    results: [
      {
        tracked_query_id: queryId,
        surface: "chatgpt",
        mentioned: false,
        position: null,
        competitors: [],
        cited_urls: hosts.map((host) => `https://${host}/somewhere`),
        answer_excerpt: null,
        phones: [],
      },
    ],
    recommendations: hosts.map((host) => ({
      rule: `source:${host}`,
      title: "Title",
      detail: "Detail",
    })),
  });
}

const detailOf = async (user: string, locationId: string) =>
  LocationDetailSchema.parse(await (await call(user, "GET", `/locations/${locationId}`)).json());
const listingOn = async (user: string, locationId: string, host: string) =>
  (await detailOf(user, locationId)).tasks.find((task) => task.host === host)?.listing;
const set = (user: string | null, locationId: string, site: string, url: unknown = PAGE) =>
  call(user, "PUT", `/locations/${locationId}/listings/${site}`, { url });
const remove = (user: string | null, locationId: string, site: string) =>
  call(user, "DELETE", `/locations/${locationId}/listings/${site}`);

beforeEach(() => {
  db = createMemoryDb();
  env = { PROVIDER_MODE: "mock" } as Env;
});

describe("a task that asks for the business's listing", () => {
  it("is one for a site that lets a business ask for reviews, and holds none to begin with", async () => {
    const { location } = await withTasks();
    const tasks = (await detailOf(alice, location.id)).tasks;
    expect(Object.fromEntries(tasks.map((task) => [task.host, task.listing]))).toEqual({
      // The subdomain an answer cited is the same site.
      "m.tripadvisor.com": { site: "tripadvisor.com", url: null },
      "yelp.com": null,
      "usnews.com": null,
    });
  });
});

describe("giving a listing", () => {
  it("keeps the address, who gave it and when, and the task then carries it", async () => {
    const { location } = await withTasks();
    db.now = "2026-10-13T09:00:00.000Z";

    const response = await set(alice, location.id, "tripadvisor.com");
    expect(response.status).toBe(200);
    expect(ListingSchema.parse(await response.json())).toEqual({
      location_id: location.id,
      site: "tripadvisor.com",
      url: PAGE,
      set_by_email: "alice@example.com",
      set_at: "2026-10-13T09:00:00.000Z",
    });
    expect(await listingOn(alice, location.id, "m.tripadvisor.com")).toEqual({
      site: "tripadvisor.com",
      url: PAGE,
    });
  });

  it("is any member's to do, and a second one takes the place of the first", async () => {
    const { location } = await withTasks();
    await set(alice, location.id, "tripadvisor.com");
    db.now = "2026-10-14T09:00:00.000Z";

    const response = await set(bob, location.id, "tripadvisor.com", OTHER);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      url: OTHER,
      set_by_email: "bob@example.com",
      set_at: "2026-10-14T09:00:00.000Z",
    });
    expect(db.listings).toHaveLength(1);
    expect((await listingOn(alice, location.id, "m.tripadvisor.com"))?.url).toBe(OTHER);
  });

  it("keeps the address a browser would follow, however it was pasted", async () => {
    const { location } = await withTasks();
    const pasted = "  www.tripadvisor.com/Restaurant_Review-g1-d2-Joes_Pizza.html#REVIEWS ";
    expect(await (await set(alice, location.id, "tripadvisor.com", pasted)).json()).toMatchObject({
      url: PAGE,
    });
  });

  it("is kept for the location and the site, so a task that comes later finds it", async () => {
    const { location, query } = await withTasks();
    const page = "https://www.bbb.org/us/nc/raleigh/profile/pizza/joes-pizza-0593-1234";
    // No answer has cited the site yet, so there is no task to show it on.
    expect((await set(alice, location.id, "bbb.org", page)).status).toBe(200);
    expect(await listingOn(alice, location.id, "bbb.org")).toBeUndefined();

    await scanThatRead(location.id, query.id, ["bbb.org"]);
    expect(await listingOn(alice, location.id, "bbb.org")).toEqual({ site: "bbb.org", url: page });
  });

  it("refuses an address that is not a page on the site, and keeps nothing", async () => {
    const { location } = await withTasks();
    for (const [pasted, said] of [
      ["https://www.yelp.com/biz/joes-pizza-raleigh", /is not on tripadvisor\.com/],
      ["https://tripadvisor.com.example.com/Joes", /is not on tripadvisor\.com/],
      ["https://www.tripadvisor.com/", /front page of tripadvisor\.com/],
      ["javascript:alert(1)", /starting with https/],
      ["Joe's Pizza", /starting with https/],
      [`https://www.tripadvisor.com/${"a".repeat(600)}`, /500 characters or fewer/],
    ] as const) {
      const response = await set(alice, location.id, "tripadvisor.com", pasted);
      expect(response.status, pasted).toBe(422);
      expect(await problem(response), pasted).toMatchObject({
        code: "validation_failed",
        message: expect.stringMatching(said),
      });
    }
    for (const body of ["", 7, null]) {
      expect((await set(alice, location.id, "tripadvisor.com", body)).status).toBe(422);
    }
    expect(db.listings).toEqual([]);
  });

  it("has nowhere to keep one for a site no task asks for one on", async () => {
    const { location } = await withTasks();
    for (const site of [
      // Forbids asking, a directory, a page somebody wrote, a site not known.
      "yelp.com",
      "yellowpages.com",
      "usnews.com",
      "somewhere.example",
      // Its review form is reached by the place ID a location holds.
      "google.com",
      // A site goes by the name the list gives it and no other.
      "www.tripadvisor.com",
      "TripAdvisor.com",
    ]) {
      const response = await set(alice, location.id, site, `https://${site}/joes`);
      expect(response.status, site).toBe(404);
      expect((await remove(alice, location.id, site)).status, site).toBe(404);
    }
    expect(db.listings).toEqual([]);
  });
});

describe("taking a listing away", () => {
  it("leaves the task asking for one again", async () => {
    const { location } = await withTasks();
    await set(alice, location.id, "tripadvisor.com");

    const response = await remove(bob, location.id, "tripadvisor.com");
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(db.listings).toEqual([]);
    expect(await listingOn(alice, location.id, "m.tripadvisor.com")).toEqual({
      site: "tripadvisor.com",
      url: null,
    });
  });

  it("finds nothing where there is none", async () => {
    const { location } = await withTasks();
    expect((await remove(alice, location.id, "tripadvisor.com")).status).toBe(404);
  });
});

describe("who a listing answers", () => {
  it("is not somebody outside the organization, to whom the location is not found", async () => {
    const { location } = await withTasks();
    await set(alice, location.id, "tripadvisor.com");

    expect((await set(carol, location.id, "tripadvisor.com", OTHER)).status).toBe(404);
    expect((await remove(carol, location.id, "tripadvisor.com")).status).toBe(404);
    expect((await set(null, location.id, "tripadvisor.com", OTHER)).status).toBe(401);
    expect((await remove(null, location.id, "tripadvisor.com")).status).toBe(401);
    expect(db.listings.map((listing) => listing.url)).toEqual([PAGE]);
  });

  it("is not the operator, who reads it and changes nothing", async () => {
    const { location } = await withTasks();
    await set(alice, location.id, "tripadvisor.com");
    db.operators.add(dave);

    expect(await listingOn(dave, location.id, "m.tripadvisor.com")).toEqual({
      site: "tripadvisor.com",
      url: PAGE,
    });
    const refused = await set(dave, location.id, "tripadvisor.com", OTHER);
    expect(refused.status).toBe(404);
    expect((await problem(refused)).message).toBe("Listing not found");
    expect((await remove(dave, location.id, "tripadvisor.com")).status).toBe(404);
    expect(db.listings.map((listing) => listing.url)).toEqual([PAGE]);
  });

  it("is not a location that is not there", async () => {
    await withTasks();
    const nowhere = "00000000-0000-4000-8000-000000000000";
    expect((await set(alice, nowhere, "tripadvisor.com")).status).toBe(404);
    expect((await set(alice, "not-a-location", "tripadvisor.com")).status).toBe(404);
  });
});

describe("how many listings a location holds", () => {
  it("is bounded, whatever a member names as a site", async () => {
    const { location } = await withTasks();
    const store = memoryStore(db, alice);
    const kept: (Listing | null)[] = [];
    for (let site = 0; site < 50; site += 1) {
      kept.push(await store.setListing(location.id, `site-${site}.example`, "https://x.example/a"));
    }
    expect(kept.every((listing) => listing !== null)).toBe(true);

    await expect(
      store.setListing(location.id, "one-more.example", "https://x.example/a"),
    ).rejects.toMatchObject({ kind: "limit" });
    // One already held can still be changed.
    expect(
      await store.setListing(location.id, "site-0.example", "https://x.example/b"),
    ).toMatchObject({ url: "https://x.example/b" });
    expect(db.listings).toHaveLength(50);
  });
});
