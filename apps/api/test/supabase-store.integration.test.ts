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
    const fresh = await aliceStore.createOrganization(`Integration ${crypto.randomUUID()}`);
    // An ordinary account's organization is a real one. Only a test account makes test ones.
    expect(fresh.is_test).toBe(false);
    // One for each account: a second would be a second free plan.
    await expect(aliceStore.createOrganization("Another")).rejects.toMatchObject({
      kind: "limit",
      message: "This account already has an organization.",
    });
    // It starts on the free plan, with that plan's limits, and cannot move itself off it.
    expect(fresh).toMatchObject({
      plan_key: "free",
      max_locations: 1,
      max_queries_per_location: 2,
      max_manual_scans_per_month: 0,
      scan_every_days: 14,
      emails_report: false,
      surfaces: ["chatgpt"],
    });
    await expect(aliceStore.applyPlan(fresh.id, "enterprise")).rejects.toThrow();
    // The worker moves it, as it will when a subscription starts. The rest of this test needs
    // the room a paid plan gives.
    // Its owner chooses the one assistant the free plan checks. A stranger's choice finds no row.
    expect(await bobStore.chooseAssistants(fresh.id, ["claude"])).toBeNull();
    expect(await aliceStore.chooseAssistants(fresh.id, ["claude"])).toMatchObject({
      surfaces: ["claude"],
    });
    await expect(
      aliceStore.chooseAssistants(fresh.id, ["chatgpt", "claude"]),
    ).rejects.toMatchObject({ kind: "limit", message: expect.stringContaining("1 assistant") });
    // More locations than a plan includes are the ones paid for.
    expect(await worker.applyPlan(fresh.id, "standard", 4)).toMatchObject({
      plan_key: "standard",
      max_locations: 4,
      max_queries_per_location: 10,
      max_manual_scans_per_month: 10,
      emails_report: true,
      surfaces: ["chatgpt", "claude"],
    });
    // Billing: only the owner is told where the organization stands, and only the worker
    // keeps what the payment provider said.
    expect(await bobStore.getBillingState(fresh.id)).toBeNull();
    expect(await aliceStore.getBillingState(fresh.id)).toEqual({
      organization_id: fresh.id,
      is_test: false,
      plan_key: "standard",
      stripe_customer_id: null,
      stripe_subscription_id: null,
      status: null,
    });
    expect(await aliceStore.getManualScansUsed(fresh.id)).toBe(0);
    expect(await bobStore.getManualScansUsed(fresh.id)).toBeNull();
    expect(await worker.getSubscription(fresh.id)).toBeNull();
    const customer = `cus_${crypto.randomUUID()}`;
    await expect(
      aliceStore.recordSubscription(fresh.id, {
        stripe_customer_id: customer,
        stripe_subscription_id: null,
        status: null,
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    for (const status of ["active", "past_due"]) {
      const kept = {
        stripe_customer_id: customer,
        stripe_subscription_id: `sub_${customer}`,
        status,
      };
      await worker.recordSubscription(fresh.id, kept);
      expect(await worker.getSubscription(fresh.id)).toEqual(kept);
    }
    expect(await aliceStore.getSubscription(fresh.id)).toBeNull();
    expect(await aliceStore.getBillingState(fresh.id)).toMatchObject({
      stripe_customer_id: customer,
      status: "past_due",
    });
    expect((await aliceStore.listPlanPrices()).find((plan) => plan.key === "standard")).toEqual({
      key: "standard",
      on_sale: true,
      included_locations: 3,
      stripe_price_id: null,
      stripe_extra_location_price_id: null,
    });
    const organization = await worker.applyPlan(fresh.id, "starter");
    if (!organization) throw new Error("The plan was not applied.");
    expect(await worker.applyPlan(crypto.randomUUID(), "standard")).toBeNull();
    expect((await aliceStore.listOrganizations()).map((o) => o.id)).toContain(organization.id);
    expect((await bobStore.listOrganizations()).map((o) => o.id)).not.toContain(organization.id);
    // Its owner may rename it; a stranger's rename finds no row, and the name stays.
    const renamed = `Renamed ${crypto.randomUUID()}`;
    expect(await bobStore.renameOrganization(organization.id, "Defaced")).toBeNull();
    expect(await aliceStore.renameOrganization(organization.id, renamed)).toEqual({
      ...organization,
      name: renamed,
    });
    expect(await aliceStore.renameOrganization(organization.id, organization.name)).toEqual(
      organization,
    );

    // The price list is read by anyone signed in.
    expect((await aliceStore.listPlans()).map((plan) => plan.key)).toEqual([
      "free",
      "starter",
      "standard",
      "pro",
      "enterprise",
    ]);

    // Only the operator changes limits. An owner's own call changes nothing.
    expect(
      await aliceStore.setOrganizationLimits(organization.id, {
        max_locations: 50,
        max_queries_per_location: 50,
        max_manual_scans_per_month: 50,
        scan_every_days: 1,
      }),
    ).toBeNull();
    expect(await aliceStore.getOrganization(organization.id)).toEqual(organization);

    // What was used is the operator's to read. A member is told nothing.
    expect(await aliceStore.listUsageByMonth("2000-01-01T00:00:00.000Z")).toEqual([]);

    // And only the operator makes an audit.
    expect(
      await aliceStore.createAudit({
        business_name: "Planted",
        website: null,
        city: "Raleigh",
        region: null,
        country_code: "US",
        prompts: ["best pizza"],
        samples: 1,
      }),
    ).toBeNull();

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
    // The operator's reads return what the caller may read: for a member, only their own.
    expect(await aliceStore.getPlatformRole(alice)).toBeNull();
    expect(await aliceStore.listPlatformRoles()).toEqual({});
    // The accounts function answers the operator. A member is told nothing, not even about herself.
    expect(await aliceStore.listAccounts()).toEqual([]);
    expect(await aliceStore.listEveryMembership()).toEqual([
      { user_id: alice, organization_id: organization.id },
    ]);
    expect((await aliceStore.listEveryOrganization()).map((o) => o.id)).toEqual([organization.id]);
    expect(await aliceStore.listEveryLocation()).toEqual([location]);
    expect((await bobStore.listEveryLocation()).map((l) => l.id)).not.toContain(location.id);

    expect(await bobStore.getLocation(location.id)).toBeNull();
    expect(await bobStore.listLocations(organization.id)).toEqual([]);
    expect(await bobStore.deleteLocation(location.id)).toBe(false);
    // An edit replaces what a user may set; a stranger's edit finds no row and changes nothing.
    const { id: _locationId, organization_id, last_scanned_at, created_at, ...fields } = location;
    expect(await bobStore.updateLocation(location.id, { ...fields, name: "Defaced" })).toBeNull();
    expect(
      await aliceStore.updateLocation(location.id, { ...fields, phone: "919-555-0100" }),
    ).toEqual({ ...location, phone: "919-555-0100" });
    expect(await aliceStore.updateLocation(location.id, fields)).toEqual(location);
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
    expect(await aliceStore.countActiveQueries()).toMatchObject({ [location.id]: 1 });
    expect(await aliceStore.listScansSince(new Date(Date.now() - 3_600_000).toISOString())).toEqual(
      [expect.objectContaining({ id: scan.id, status: "queued", site_check: null })],
    );
    expect(await bobStore.listScansSince("2000-01-01T00:00:00Z")).toEqual([]);

    // What a scan used is the worker's to record. A member cannot, even for their own scan.
    const used = {
      surface: "chatgpt" as const,
      model: "gpt-x",
      calls: 1,
      input_tokens: 1000,
      cached_input_tokens: 0,
      output_tokens: 50,
      searches: 2,
    };
    const source = { organization_id: organization.id, scan_id: scan.id };
    await worker.recordUsage(source, [used]);
    await worker.recordUsage(source, []);
    await expect(aliceStore.recordUsage(source, [used])).rejects.toBeInstanceOf(StoreError);

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
      plan_key: "starter",
      max_locations: 1,
      max_queries_per_location: 5,
      max_manual_scans_per_month: 2,
      scan_every_days: 2,
      surfaces: ["chatgpt"],
    });
    // A member reads their own organization, the worker reads any, and a non-member reads none.
    expect(await aliceStore.getOrganization(organization.id)).toEqual(mine);
    expect(await worker.getOrganization(organization.id)).toEqual(mine);
    expect(await bobStore.getOrganization(organization.id)).toBeNull();
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

    // A location in use is returned as it is; a stranger's call finds nothing to bring back.
    expect(await aliceStore.activateLocation(location.id)).toMatchObject({
      id: location.id,
      paused_by_plan: false,
    });
    expect(await bobStore.activateLocation(location.id)).toBeNull();

    // The on-page check is kept with the scan that made it. Members read it, a non-member does
    // not, and it follows the latest successful scan.
    const check = {
      url: "https://joes.example/",
      status: 200,
      checks: [{ id: "reachable" as const, passed: true }],
      blocked_crawlers: [],
      words: 120,
    };
    await worker.completeScan(scan.id, { score: 80, results, recommendations: [], site: check });
    expect(await aliceStore.getSiteCheck(location.id)).toEqual(check);
    expect(await worker.getSiteCheck(location.id)).toEqual(check);
    expect(await bobStore.getSiteCheck(location.id)).toBeNull();

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

    // A shareable audit belongs to nobody. The owner's script creates it with the secret key,
    // the worker fills it in, and anyone holding its token reads it, signed in or not.
    const admin = client(await token({ role: "service_role" }));
    const created = await admin
      .from("audits")
      .insert({
        business_name: "Joe's Pizza",
        city: "Raleigh",
        prompts: ["best pizza"],
        samples: 2,
      })
      .select("id, token")
      .single();
    expect(created.error).toBeNull();
    const audit = created.data as { id: string; token: string };
    const visitor = createSupabaseStore(client(await token({ role: "anon" })));

    expect(await worker.getAudit(audit.id)).toMatchObject({
      id: audit.id,
      prompts: ["best pizza"],
      samples: 2,
      status: "queued",
      revoked_at: null,
    });
    // A signed-in account may ask the table and is told nothing: only the operator's policy
    // answers. Writing is still refused outright.
    expect(await bobStore.getAudit(audit.id)).toBeNull();
    await expect(visitor.recordAuditPart(audit.id, 0, { cells: [] })).rejects.toBeInstanceOf(
      StoreError,
    );

    // The sweep fails an audit left queued, only for the worker, and only past the cutoff.
    const beforeAudit = new Date(Date.now() - 3_600_000).toISOString();
    expect(await worker.failStaleAudits(beforeAudit, "unfinished")).toBe(0);
    await expect(bobStore.failStaleAudits(beforeAudit, "unfinished")).rejects.toBeInstanceOf(
      StoreError,
    );
    expect(
      await worker.failStaleAudits(new Date(Date.now() + 60_000).toISOString(), "unfinished"),
    ).toBe(1);
    expect(await visitor.getAuditByToken(audit.token)).toMatchObject({ status: "failed" });

    // Listing audits answers the worker, and would answer the operator. Nobody else.
    expect((await worker.listEveryAudit()).map((row) => row.id)).toContain(audit.id);
    expect(await bobStore.listEveryAudit()).toEqual([]);

    await worker.failAudit(audit.id, "upstream 503");
    expect(await visitor.getAuditByToken(audit.token)).toMatchObject({ status: "failed" });

    const cell = {
      surface: "chatgpt" as const,
      checks: 2,
      mentions: 1,
      positions: [2],
      weight: 0.8,
      competitors: [{ name: "Tony's Slice House", count: 2 }],
      excerpt: "Try Tony's Slice House or Joe's Pizza.",
      cited_urls: ["https://example.com/best-pizza"],
      sources: [
        {
          host: "example.com",
          answers: 2,
          named: 1,
          own: false,
          urls: ["https://example.com/best-pizza"],
        },
      ],
    };
    await worker.recordAuditPart(audit.id, 0, { cells: [cell] });
    for (const reader of [visitor, bobStore]) {
      expect(await reader.getAuditByToken(audit.token)).toMatchObject({
        business_name: "Joe's Pizza",
        status: "ready",
        parts: { "0": { cells: [cell] } },
      });
    }
    expect(await visitor.getAuditByToken("ab".repeat(32))).toBeNull();

    expect(
      (
        await admin
          .from("audits")
          .update({ revoked_at: new Date().toISOString() })
          .eq("id", audit.id)
      ).error,
    ).toBeNull();
    expect(await visitor.getAuditByToken(audit.token)).toBeNull();
  });
});
