import {
  ConnectionSchema,
  LocationReviewRequestsSchema,
  LocationSchema,
  OrganizationSchema,
  ReviewRequestSettingsSchema,
  type TrackedQuery,
  TrackedQuerySchema,
} from "@nearcited/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { removeConnection } from "../src/connections";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const carol = "c0000000-0000-4000-8000-000000000003";
const dave = "d0000000-0000-4000-8000-000000000004";
const erin = "e0000000-0000-4000-8000-000000000005";

const GOOGLE = "https://g.page/r/joes-pizza/review";
const BBB = "https://www.bbb.org/us/nc/raleigh/profile/pizza/joes-pizza-0593-1234";

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

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string } }).error;

const worker = () => memoryStore(db, null);

/**
 * Alice's organization, with Bob a member, Dave an admin and Erin the operator, its review
 * requests given to it by hand, and a location with a time zone and listings on Google and BBB.
 */
async function withLocation({
  allowed = true,
  details = {} as Record<string, unknown>,
  listings = { "google.com": GOOGLE, "bbb.org": BBB } as Record<string, string>,
} = {}) {
  const organization = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  db.memberships.push({ organization_id: organization.id, user_id: bob, role: "member" });
  db.memberships.push({ organization_id: organization.id, user_id: dave, role: "admin" });
  db.operators.add(erin);
  db.emails.set(alice, "alice@example.com");
  db.emails.set(dave, `${dave}@example.com`);
  const kept = db.organizations.find((candidate) => candidate.id === organization.id);
  if (kept) {
    Object.assign(kept, {
      max_locations: 5,
      allowances: allowed ? { ...kept.allowances, review_requests: 100 } : {},
    });
  }
  const location = LocationSchema.parse(
    await (
      await call(alice, "POST", `/organizations/${organization.id}/locations`, {
        name: "Joe's Pizza",
        city: "Raleigh",
        region: "NC",
        primary_category: "Pizza restaurant",
        time_zone: "America/New_York",
        ...details,
      })
    ).json(),
  );
  for (const [site, url] of Object.entries(listings)) {
    const set = await call(alice, "PUT", `/locations/${location.id}/listings/${site}`, { url });
    expect(set.status, site).toBe(200);
  }
  return { organization, location };
}

/** A finished scan of the location with an answer for each list of hosts, citing a page on each. */
async function scanThatCited(locationId: string, answers: string[][]) {
  const queries: TrackedQuery[] = [];
  for (const [index] of answers.entries()) {
    queries.push(
      TrackedQuerySchema.parse(
        await (
          await call(alice, "POST", `/locations/${locationId}/queries`, {
            kind: "ai_prompt",
            text: `best pizza in Raleigh number ${index + 1}`,
          })
        ).json(),
      ),
    );
  }
  const scan = await worker().createScan(locationId, "scheduled", null);
  await worker().markScanRunning(scan.id, true);
  await worker().completeScan(scan.id, {
    score: 0,
    results: answers.map((hosts, index) => ({
      tracked_query_id: queries[index]?.id ?? "",
      surface: "chatgpt" as const,
      mentioned: false,
      position: null,
      competitors: [],
      cited_urls: hosts.map((host) => `https://${host}/somewhere`),
      answer_excerpt: null,
      phones: [],
    })),
    recommendations: [],
  });
}

const standing = async (user: string, locationId: string) =>
  LocationReviewRequestsSchema.parse(
    await (await call(user, "GET", `/locations/${locationId}/review-requests`)).json(),
  );
const turnOn = (user: string | null, locationId: string, body: Record<string, unknown> = {}) =>
  call(user, "POST", `/locations/${locationId}/review-requests`, {
    site: "google.com",
    reply_to: "alice@example.com",
    confirmed: true,
    ...body,
  });

beforeEach(() => {
  db = createMemoryDb();
  env = {
    PROVIDER_MODE: "mock",
    SCAN_QUEUE: { send: async () => {}, sendBatch: async () => {} },
  } as unknown as Env;
});

describe("turning review requests on", () => {
  it("offers the sites the location has a listing with a review form on, the one cited most first", async () => {
    const { location } = await withLocation();
    await scanThatCited(location.id, [["www.bbb.org", "maps.google.com"], ["www.bbb.org"]]);
    expect(await standing(bob, location.id)).toEqual({
      barred: null,
      can_manage: false,
      settings: null,
      sites: [
        {
          site: "bbb.org",
          name: "BBB",
          link: `${BBB}/leave-a-review`,
          cited: 2,
        },
        { site: "google.com", name: "Google", link: GOOGLE, cited: 1 },
      ],
      reply_to: `${bob}@example.com`,
    });
  });

  it("is for an owner or admin, with the site chosen, and gives the location a receipt address", async () => {
    const { location } = await withLocation();
    for (const user of [bob, erin]) {
      const refused = await turnOn(user, location.id);
      expect(refused.status, user).toBe(403);
      expect((await errorOf(refused)).code).toBe("owners_and_admins_only");
    }
    expect((await turnOn(carol, location.id)).status).toBe(404);
    expect((await turnOn(null, location.id)).status).toBe(401);
    expect((await standing(alice, location.id)).settings).toBeNull();

    const made = await turnOn(dave, location.id, { reply_to: " Owner@Joes.example " });
    expect(made.status).toBe(201);
    const settings = ReviewRequestSettingsSchema.parse(await made.json());
    expect(settings).toMatchObject({
      location_id: location.id,
      site: "google.com",
      reply_to: "owner@joes.example",
      turned_on_by_email: `${dave}@example.com`,
      status: "working",
    });
    expect(settings.receipt_address).toMatch(/^[0-9a-f]{32}@receipts\.nearcited\.com$/);
    // Any member reads them, and the operator too.
    for (const user of [bob, erin]) {
      expect((await standing(user, location.id)).settings, user).toEqual(settings);
    }
    expect((await call(carol, "GET", `/locations/${location.id}/review-requests`)).status).toBe(
      404,
    );
    // Once for a location.
    expect((await turnOn(alice, location.id)).status).toBe(409);
  });

  it("takes another site that qualifies, and no site that does not", async () => {
    const { location } = await withLocation();
    await scanThatCited(location.id, [["maps.google.com"]]);
    const other = await turnOn(alice, location.id, { site: "trustpilot.com" });
    expect(other.status).toBe(422);
    expect((await errorOf(other)).code).toBe("not_a_site");
    const made = await turnOn(alice, location.id, { site: "bbb.org" });
    expect(made.status).toBe(201);
    expect(ReviewRequestSettingsSchema.parse(await made.json()).site).toBe("bbb.org");
  });

  it("is refused without a time zone, for a confidential category, without a site, and without the confirmation", async () => {
    const cases = [
      [{ details: { time_zone: "" } }, "no_time_zone"],
      [{ details: { primary_category: "Family dentist" } }, "confidential"],
      // A review site with no form known, which is all this location has a listing on.
      [{ listings: { "houzz.com": "https://www.houzz.com/professionals/joes" } }, "no_site"],
      [{ allowed: false }, "connection_unavailable"],
    ] as const;
    for (const [setUp, code] of cases) {
      db = createMemoryDb();
      const { location } = await withLocation(setUp);
      expect((await standing(alice, location.id)).barred, code).toBe(
        code === "connection_unavailable" ? "not_included" : code,
      );
      const refused = await turnOn(alice, location.id);
      expect(refused.status, code).toBe(422);
      expect((await errorOf(refused)).code).toBe(code);
    }

    db = createMemoryDb();
    const { location } = await withLocation();
    for (const confirmed of [false, undefined]) {
      const refused = await turnOn(alice, location.id, { confirmed });
      expect(refused.status).toBe(422);
      expect((await errorOf(refused)).message).toMatch(/customer list is not confidential/);
    }
    expect((await turnOn(alice, location.id, { reply_to: "nobody" })).status).toBe(422);
    expect((await standing(alice, location.id)).settings).toBeNull();
  });
});

describe("a receipt address", () => {
  it("is replaced by an owner or admin, and the old one no longer belongs to the location", async () => {
    const { location } = await withLocation();
    const path = `/locations/${location.id}/review-requests/address`;
    expect((await call(alice, "POST", path)).status).toBe(404);
    await turnOn(alice, location.id);
    const before = (await standing(alice, location.id)).settings?.receipt_address;

    for (const user of [bob, erin]) expect((await call(user, "POST", path)).status, user).toBe(403);
    expect((await call(carol, "POST", path)).status).toBe(404);
    expect((await standing(alice, location.id)).settings?.receipt_address).toBe(before);

    const replaced = await call(dave, "POST", path);
    expect(replaced.status).toBe(200);
    const after = ReviewRequestSettingsSchema.parse(await replaced.json()).receipt_address;
    expect(after).not.toBe(before);
    expect((await standing(bob, location.id)).settings?.receipt_address).toBe(after);
    const names = db.reviewRequests.map((kept) => kept.receipt_address);
    expect(names.some((name) => before?.startsWith(name))).toBe(false);
  });
});

describe("turning review requests off", () => {
  it("removes them as a connection, after which they can be turned on again with a new address", async () => {
    const { location } = await withLocation();
    const settings = ReviewRequestSettingsSchema.parse(
      await (await turnOn(alice, location.id)).json(),
    );
    // A plain member does not turn them off.
    expect((await call(bob, "DELETE", `/connections/${settings.connection_id}`)).status).toBe(404);
    const asked = await call(dave, "DELETE", `/connections/${settings.connection_id}`);
    expect(ConnectionSchema.parse(await asked.json()).status).toBe("removing");
    // While they are being turned off, the address is not replaced.
    expect(
      (await call(alice, "POST", `/locations/${location.id}/review-requests/address`)).status,
    ).toBe(404);

    expect(await removeConnection(settings.connection_id, { store: worker(), key: null })).toBe(
      "removed",
    );
    expect((await standing(alice, location.id)).settings).toBeNull();
    const again = ReviewRequestSettingsSchema.parse(
      await (await turnOn(alice, location.id)).json(),
    );
    expect(again.receipt_address).not.toBe(settings.receipt_address);
  });

  it("are not matched to another location by hand", async () => {
    const { organization, location } = await withLocation();
    const settings = ReviewRequestSettingsSchema.parse(
      await (await turnOn(alice, location.id)).json(),
    );
    const other = LocationSchema.parse(
      await (
        await call(alice, "POST", `/organizations/${organization.id}/locations`, {
          name: "Joe's Pizza Downtown",
          city: "Raleigh",
        })
      ).json(),
    );
    const moved = await call(
      alice,
      "PUT",
      `/connections/${settings.connection_id}/locations/${other.id}`,
      { external_id: other.id },
    );
    expect(moved.status).toBe(422);
    expect((await errorOf(moved)).code).toBe("not_matched_by_hand");
  });
});
