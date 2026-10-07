import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createSupabaseStore } from "../src/store/supabase";
import { StoreError } from "../src/store/types";

/**
 * Runs the real Supabase store against PostgREST and Postgres, which is what a Supabase project
 * is underneath. Skipped unless POSTGREST_URL is set; see "Integration tests" in the README.
 *
 * Not covered: `listOwnerEmails`, which calls the Auth admin API and needs a real project.
 */

declare const process: { env: Record<string, string | undefined> };

const url = process.env.POSTGREST_URL;
const secret = process.env.POSTGREST_JWT_SECRET ?? "";

// Created by scripts/integration-db.sh.
const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";

const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array | string) =>
  btoa(typeof bytes === "string" ? bytes : String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function token(claims: Record<string, unknown>): Promise<string> {
  const body = `${base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 }),
  )}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

/** supabase-js expects the REST API under /rest/v1; bare PostgREST serves it at the root. */
function client(jwt: string): SupabaseClient {
  return createClient(url ?? "", jwt, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => fetch(String(input).replace("/rest/v1", ""), init),
    },
  });
}

const storeFor = async (userId: string) =>
  createSupabaseStore(client(await token({ role: "authenticated", sub: userId })));
const workerStore = async () => createSupabaseStore(client(await token({ role: "service_role" })));

describe.skipIf(!url)("Supabase store against PostgREST", () => {
  it("round-trips every table and keeps tenants apart", async () => {
    const aliceStore = await storeFor(alice);
    const bobStore = await storeFor(bob);
    const worker = await workerStore();

    // Organizations
    const organization = await aliceStore.createOrganization(`Integration ${crypto.randomUUID()}`);
    expect((await aliceStore.listOrganizations()).map((o) => o.id)).toContain(organization.id);
    expect((await bobStore.listOrganizations()).map((o) => o.id)).not.toContain(organization.id);

    // Locations
    const location = await aliceStore.createLocation(organization.id, {
      name: "Joe's Pizza",
      website: "https://joes.example",
      phone: null,
      address_line: null,
      city: "Raleigh",
      region: "NC",
      postal_code: null,
      country_code: "US",
      google_place_id: null,
      primary_category: null,
      scan_frequency: "daily",
    });
    expect(location).toMatchObject({ organization_id: organization.id, last_scanned_at: null });
    expect(await aliceStore.listLocations(organization.id)).toEqual([location]);
    expect(await aliceStore.getLocation(location.id)).toEqual(location);

    expect(await bobStore.getLocation(location.id)).toBeNull();
    expect(await bobStore.listLocations(organization.id)).toEqual([]);
    expect(await bobStore.deleteLocation(location.id)).toBe(false);
    await expect(
      bobStore.createLocation(organization.id, { ...location, name: "Planted" }),
    ).rejects.toMatchObject({ kind: "forbidden" });

    // Tracked queries
    const query = await aliceStore.createQuery(location.id, {
      kind: "ai_prompt",
      text: "best pizza in Raleigh",
    });
    expect(await aliceStore.listQueries(location.id)).toEqual([query]);
    await expect(
      aliceStore.createQuery(location.id, { kind: "ai_prompt", text: "best pizza in Raleigh" }),
    ).rejects.toMatchObject({ kind: "conflict" });
    await expect(
      bobStore.createQuery(location.id, { kind: "ai_prompt", text: "planted" }),
    ).rejects.toBeInstanceOf(StoreError);

    // Scheduling sees the location as due, then not once a scan is in flight.
    expect(await worker.listLocationsDueForScan(100)).toContain(location.id);
    await expect(aliceStore.listLocationsDueForScan(100)).rejects.toMatchObject({
      kind: "forbidden",
    });

    // Scans
    const scan = await aliceStore.createScan(location.id, "manual", alice);
    expect(scan).toMatchObject({ status: "queued", trigger: "manual", visibility_score: null });
    await expect(aliceStore.createScan(location.id, "scheduled", null)).rejects.toMatchObject({
      kind: "forbidden",
    });
    await expect(bobStore.createScan(location.id, "manual", bob)).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(await worker.listLocationsDueForScan(100)).not.toContain(location.id);

    // One scan in flight per location, enforced by the unique index, for the worker too.
    await expect(aliceStore.createScan(location.id, "manual", alice)).rejects.toMatchObject({
      kind: "conflict",
    });
    await expect(worker.createScan(location.id, "scheduled", null)).rejects.toMatchObject({
      kind: "conflict",
    });
    // Nothing is stale yet, and a signed-in user cannot run the sweep.
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    expect(await worker.failStaleScans(anHourAgo, "abandoned")).toBe(0);
    await expect(aliceStore.failStaleScans(anHourAgo, "abandoned")).rejects.toMatchObject({
      kind: "forbidden",
    });
    // With a cutoff in the future the queued scan counts as stale, which frees the location.
    const soon = new Date(Date.now() + 60_000).toISOString();
    expect(await worker.failStaleScans(soon, "abandoned")).toBe(1);
    expect(await aliceStore.getScan(scan.id)).toMatchObject({
      status: "failed",
      error: "abandoned",
    });

    await worker.markScanRunning(scan.id, false);
    expect(await aliceStore.getScan(scan.id)).toMatchObject({ status: "running" });

    await worker.failScan(scan.id, "upstream 503");
    expect(await aliceStore.getScan(scan.id)).toMatchObject({
      status: "failed",
      error: "upstream 503",
    });

    await worker.completeScan(scan.id, {
      score: 62.5,
      results: [
        {
          tracked_query_id: query.id,
          surface: "chatgpt",
          mentioned: true,
          position: 2,
          competitors: ["Tony's Slice House"],
          cited_urls: ["https://joes.example"],
          answer_excerpt: "Try Tony's Slice House or Joe's Pizza.",
        },
        {
          tracked_query_id: query.id,
          surface: "gemini",
          mentioned: false,
          position: null,
          competitors: [],
          cited_urls: [],
          answer_excerpt: null,
        },
      ],
      recommendations: [{ rule: "absent:gemini", title: "Not named on Gemini", detail: "Detail" }],
    });

    const finished = await aliceStore.getScan(scan.id);
    expect(finished).toMatchObject({ status: "succeeded", visibility_score: 62.5, error: null });
    expect(await aliceStore.listScans(location.id, 5)).toEqual([finished]);
    expect((await aliceStore.getLocation(location.id))?.last_scanned_at).not.toBeNull();

    const results = await aliceStore.listScanResults(scan.id);
    // The window: this location's successful scans of one kind, newest first, and nobody else's.
    expect(await aliceStore.listRecentResults(location.id, 7, false)).toEqual([
      expect.arrayContaining(results),
    ]);
    expect(await aliceStore.listRecentResults(location.id, 7, true)).toEqual([]);
    expect(await aliceStore.listRecentResults(location.id, 0, false)).toEqual([]);
    expect(await bobStore.listRecentResults(location.id, 7, false)).toEqual([]);
    expect(results.map((r) => [r.surface, r.mentioned, r.position]).sort()).toEqual([
      ["chatgpt", true, 2],
      ["gemini", false, null],
    ]);
    expect(results.find((r) => r.surface === "chatgpt")).toMatchObject({
      competitors: ["Tony's Slice House"],
      cited_urls: ["https://joes.example"],
    });

    expect(await bobStore.getScan(scan.id)).toBeNull();
    expect(await bobStore.listScans(location.id, 5)).toEqual([]);
    expect(await bobStore.listScanResults(scan.id)).toEqual([]);

    // Recommendations
    const [recommendation] = await aliceStore.listRecommendations(location.id);
    expect(recommendation).toMatchObject({ rule: "absent:gemini", status: "open" });
    if (!recommendation) throw new Error("recommendation missing");
    expect(await bobStore.listRecommendations(location.id)).toEqual([]);
    expect(await bobStore.setRecommendationStatus(recommendation.id, "done")).toBeNull();
    expect(await aliceStore.setRecommendationStatus(recommendation.id, "dismissed")).toMatchObject({
      id: recommendation.id,
      status: "dismissed",
    });

    // Usage caps come from the database with a message for the user. The organization's own
    // limits are read back with it, and a member cannot raise them.
    const [mine] = await aliceStore.listOrganizations();
    expect(mine).toMatchObject({
      max_locations: 1,
      max_queries_per_location: 10,
      max_manual_scans_per_day: 5,
    });
    const {
      id: _id,
      organization_id: _org,
      last_scanned_at: _scanned,
      created_at: _at,
      ...input
    } = location;
    await expect(
      aliceStore.createLocation(organization.id, { ...input, name: "Second Shop" }),
    ).rejects.toMatchObject({ kind: "limit", message: expect.stringContaining("1 location") });

    // Retiring a prompt keeps its results; a non-member cannot do it.
    expect(await bobStore.setQueryActive(query.id, false)).toBeNull();
    expect(await aliceStore.setQueryActive(query.id, false)).toMatchObject({
      id: query.id,
      is_active: false,
    });
    expect(await aliceStore.listScanResults(scan.id)).toHaveLength(results.length);
    expect(await aliceStore.setQueryActive(query.id, true)).toMatchObject({ is_active: true });

    // Deleting the location cascades.
    expect(await aliceStore.deleteLocation(location.id)).toBe(true);
    expect(await aliceStore.getScan(scan.id)).toBeNull();
  });
});
