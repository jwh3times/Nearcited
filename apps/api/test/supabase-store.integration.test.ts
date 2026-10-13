import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createSupabaseStore } from "../src/store/supabase";
import { StoreError } from "../src/store/types";

/**
 * Runs the real Supabase store against PostgREST and Postgres, which is what a Supabase project
 * is underneath. Skipped unless POSTGREST_URL is set; see "Integration tests" in the README.
 *
 * Not covered: `listOwnerEmails` and `listManagerEmails`, which call the Auth admin API and need
 * a real project.
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
      allowances: {},
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
      allowances: {},
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
    // The operator's two plan methods answer nobody else: a member reads no subscriptions and
    // changes no plan.
    expect(await aliceStore.listEverySubscription()).toEqual([]);
    expect(
      await aliceStore.setPlan("standard", {
        name: "Mine now",
        on_sale: true,
        max_queries_per_location: 99,
        assistants: 2,
        scan_every_days: 1,
        max_manual_scans_per_month: 99,
        emails_report: true,
        allowances: {},
      }),
    ).toBeNull();
    expect((await aliceStore.listPlans()).find((plan) => plan.key === "standard")?.name).toBe(
      "Standard",
    );
    // Price changes: anyone signed in may ask whether one is open; announcing and calling off
    // answer only the operator; what was done for each organization is kept by the worker.
    expect(await aliceStore.getOpenPriceChange("standard")).toBeNull();
    expect(await aliceStore.announcePriceChange("standard", "2099-01-01T00:00:00.000Z")).toBeNull();
    expect(await aliceStore.callOffPriceChange("standard")).toBeNull();
    expect(await worker.listOpenPriceChanges()).toEqual([]);
    expect(await worker.listPlanSubscribers("standard")).not.toContain(fresh.id);
    expect(await worker.getPriceChange(crypto.randomUUID())).toBeNull();
    expect(await aliceStore.listPriceChangeNotices(crypto.randomUUID())).toEqual([]);
    await expect(
      aliceStore.recordPriceChangeNotice(crypto.randomUUID(), fresh.id, { skipped: "mine" }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await worker.markPriceChange(crypto.randomUUID(), "completed", new Date().toISOString());
    // Reductions: anyone signed in may ask whether one is open; announcing and calling off
    // answer only the operator; who was told is kept by the worker, which alone makes one.
    const lowerStandard = {
      max_queries_per_location: 1,
      assistants: 2,
      scan_every_days: 2,
      max_manual_scans_per_month: 10,
      emails_report: true,
      allowances: {},
    };
    expect(await aliceStore.getOpenLimitChange("standard")).toBeNull();
    expect(
      await aliceStore.announceLimitChange("standard", lowerStandard, "2099-01-01T00:00:00.000Z"),
    ).toBeNull();
    expect(await aliceStore.callOffLimitChange("standard")).toBeNull();
    expect(await worker.listOpenLimitChanges()).toEqual([]);
    expect(await worker.getLatestMadeLimitChange("standard")).toBeNull();
    expect(await worker.getLimitChange(crypto.randomUUID())).toBeNull();
    expect(await worker.listPlanOrganizations("standard")).toContain(fresh.id);
    expect(await bobStore.listPlanOrganizations("standard")).not.toContain(fresh.id);
    expect(await aliceStore.listLimitChangeNotices(crypto.randomUUID())).toEqual([]);
    await expect(
      aliceStore.recordLimitChangeNotice(crypto.randomUUID(), fresh.id, {
        announced_at: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await worker.markLimitChangeReminded(crypto.randomUUID(), new Date().toISOString());
    expect(await worker.applyLimitChange(crypto.randomUUID())).toBe(false);
    await expect(aliceStore.applyLimitChange(crypto.randomUUID())).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(await aliceStore.getManualScansUsed(fresh.id)).toBe(0);
    expect(await bobStore.getManualScansUsed(fresh.id)).toBeNull();
    // Use of an allowance is read by a member and taken by the worker alone. No kind exists yet,
    // so there is none to read and nothing to take.
    expect(await aliceStore.getAllowanceUse(fresh.id)).toEqual({});
    expect(await bobStore.getAllowanceUse(fresh.id)).toEqual({});
    expect(await worker.claimAllowance(fresh.id, "nonesuch")).toEqual({
      claimed: false,
      allowed: 0,
      used: 0,
    });
    expect(await worker.claimAllowance(crypto.randomUUID(), "nonesuch")).toBeNull();
    await expect(aliceStore.claimAllowance(fresh.id, "nonesuch")).rejects.toMatchObject({
      kind: "forbidden",
    });
    // Connections: made and asked to be removed by the owner, read by members, and finished by
    // the worker, which alone reads the sign-in.
    const connectionId = crypto.randomUUID();
    const sample = {
      id: connectionId,
      organization_id: fresh.id,
      kind: "sample" as const,
      label: "Sample account",
      sealed: "sealed-text",
    };
    expect(await bobStore.createConnection(sample)).toBeNull();
    const connection = await aliceStore.createConnection(sample);
    expect(connection).toMatchObject({ id: connectionId, kind: "sample", status: "working" });
    expect(await aliceStore.listConnections(fresh.id)).toEqual([connection]);
    expect(await bobStore.listConnections(fresh.id)).toEqual([]);
    expect(await aliceStore.getConnection(connectionId)).toEqual(connection);
    expect(await bobStore.getConnection(connectionId)).toBeNull();
    expect(await aliceStore.managesConnections(fresh.id)).toBe(true);
    expect(await bobStore.managesConnections(fresh.id)).toBe(false);
    await expect(aliceStore.getConnectionSecret(connectionId)).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(await worker.getConnectionSecret(connectionId)).toBe("sealed-text");
    // Syncing is the worker's, and matching a location is the owner's, from what a sync found.
    expect(await worker.listConnectionsDueForSync(100)).toContain(connectionId);
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const hourAhead = new Date(Date.now() + 3_600_000).toISOString();
    expect(await worker.listConnectionsAwaitingFirstSync(hourAgo, hourAhead)).toContain(
      connectionId,
    );
    await expect(aliceStore.recordConnectionSync(connectionId, [])).rejects.toMatchObject({
      kind: "forbidden",
    });
    const reached = [{ id: "listing-a", label: "Main Street" }];
    expect(await worker.recordConnectionSync(connectionId, reached)).toBe(true);
    expect(await worker.listConnectionsDueForSync(100)).not.toContain(connectionId);
    // A failed sync, who is told, and what a plan no longer includes are all the worker's.
    await expect(aliceStore.recordConnectionFailure(connectionId, true)).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(await worker.recordConnectionFailure(connectionId, false)).toEqual({
      status: "working",
      newly_broken: false,
    });
    expect(await worker.recordConnectionFailure(crypto.randomUUID(), false)).toBeNull();
    await worker.markConnectionTold(connectionId, "told", new Date().toISOString());
    const aMinuteOn = new Date(Date.now() + 60_000).toISOString();
    expect(await worker.listBrokenConnectionsToRemind(aMinuteOn)).not.toContain(connectionId);
    expect(await worker.listBrokenConnectionsUntold()).not.toContain(connectionId);
    expect(await worker.expirePausedConnections()).toEqual([]);
    await expect(aliceStore.expirePausedConnections()).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(await aliceStore.getConnection(connectionId)).toMatchObject({
      status: "working",
      broken_reason: null,
      paused_at: null,
      removal_reason: null,
    });
    expect(await bobStore.requestConnectionRemoval(connectionId)).toBeNull();
    // Nobody has asked yet, so the worker has nothing to finish.
    expect(await worker.finishConnectionRemoval(connectionId)).toBe(false);
    expect(await aliceStore.requestConnectionRemoval(connectionId)).toMatchObject({
      status: "removing",
    });
    const afterAsking = new Date(Date.now() + 60_000).toISOString();
    expect(await worker.listStalledRemovals(afterAsking)).toContain(connectionId);
    await expect(aliceStore.finishConnectionRemoval(connectionId)).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(await worker.finishConnectionRemoval(connectionId)).toBe(true);
    expect(await worker.getConnectionSecret(connectionId)).toBeNull();
    // What was synced went with the sign-in.
    expect(await aliceStore.getConnection(connectionId)).toMatchObject({
      status: "removed",
      removal_reason: "asked",
      choices: [],
      matches: [],
    });
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
    // The thanks for a subscription starting are claimed once for each subscription.
    expect(await worker.claimSubscriptionStart(fresh.id, "sub_first")).toBe(true);
    expect(await worker.claimSubscriptionStart(fresh.id, "sub_first")).toBe(false);
    expect(await worker.claimSubscriptionStart(fresh.id, "sub_second")).toBe(true);
    await expect(aliceStore.claimSubscriptionStart(fresh.id, "sub_third")).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(await worker.claimSubscriptionStart(crypto.randomUUID(), "sub_first")).toBe(false);
    expect(await aliceStore.getBillingState(fresh.id)).toMatchObject({
      stripe_customer_id: customer,
      status: "past_due",
    });
    // No plan has been set up at the payment provider here, so none has a price to pay.
    expect((await aliceStore.listPlanPrices()).find((plan) => plan.key === "standard")).toEqual({
      key: "standard",
      on_sale: true,
      included_locations: 3,
      current: null,
      versions: [],
    });
    // Setting one is the operator's alone.
    expect(
      await aliceStore.setPlanPrices("standard", {
        price_cents: 100,
        extra_location_price_cents: null,
        stripe_price_id: `price_${crypto.randomUUID()}`,
        stripe_extra_location_price_id: null,
      }),
    ).toBeNull();
    expect(
      (await worker.listPlanPrices()).find((plan) => plan.key === "standard")?.versions,
    ).toEqual([]);
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
    // Each carries its allowances, whatever kinds of work it includes.
    for (const plan of await aliceStore.listPlans()) {
      expect(plan.allowances, plan.key).toBeTypeOf("object");
    }

    // Only the operator changes limits. An owner's own call changes nothing.
    expect(
      await aliceStore.setOrganizationLimits(organization.id, {
        max_locations: 50,
        max_queries_per_location: 50,
        max_manual_scans_per_month: 50,
        scan_every_days: 1,
        allowances: {},
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
    });
    expect(location).toMatchObject({ organization_id: organization.id, last_scanned_at: null });
    expect(await aliceStore.listLocations(organization.id)).toEqual([location]);

    // Matching a location to what a connected account reaches is the owner's, from what the
    // worker's sync found. It is read with the location and goes when the account is removed.
    const account = {
      id: crypto.randomUUID(),
      organization_id: organization.id,
      kind: "sample" as const,
      label: "Sample account",
      sealed: "sealed-text",
    };
    await aliceStore.createConnection(account);
    await worker.recordConnectionSync(account.id, [{ id: "listing-a", label: "Main Street" }]);
    expect(await bobStore.matchConnectionLocation(account.id, location.id, "listing-a")).toBeNull();
    await expect(
      aliceStore.matchConnectionLocation(account.id, location.id, "nonesuch"),
    ).rejects.toMatchObject({ kind: "limit" });
    expect(
      await aliceStore.matchConnectionLocation(account.id, location.id, "listing-a"),
    ).toMatchObject({ location_id: location.id, external_label: "Main Street" });
    expect(await aliceStore.getConnection(account.id)).toMatchObject({
      matches: [{ location_id: location.id, external_id: "listing-a" }],
    });
    expect(await aliceStore.listLocationConnections(location.id)).toEqual([
      {
        connection_id: account.id,
        kind: "sample",
        label: "Sample account",
        external_label: "Main Street",
      },
    ]);
    expect(await bobStore.listLocationConnections(location.id)).toEqual([]);
    expect(await bobStore.unmatchConnectionLocation(account.id, location.id)).toBe(false);
    expect(await aliceStore.unmatchConnectionLocation(account.id, location.id)).toBe(true);
    await aliceStore.matchConnectionLocation(account.id, location.id, "listing-a");

    // Actions: proposed and carried out by the worker, answered by a member of the organization.
    const proposal = {
      location_id: location.id,
      kind: "sample" as const,
      connection_id: account.id,
      subject: "opening-line:listing-a",
      basis: "first",
      summary: "Set the opening line",
      seen: { text: null },
      proposed_text: "New line",
      written_by: "rule" as const,
    };
    await expect(aliceStore.proposeAction(proposal)).rejects.toMatchObject({ kind: "forbidden" });
    const proposed = await worker.proposeAction(proposal);
    if (!proposed) throw new Error("nothing was proposed");
    expect(proposed).toMatchObject({ status: "proposed", proposed_text: "New line" });
    // One open proposal for a thing.
    expect(await worker.proposeAction(proposal)).toBeNull();
    expect(await aliceStore.listLocationActions(location.id)).toEqual([proposed]);
    expect(await bobStore.listLocationActions(location.id)).toEqual([]);
    expect(await aliceStore.countWaitingActions(organization.id)).toEqual({ [location.id]: 1 });
    expect(await bobStore.countWaitingActions(organization.id)).toEqual({});
    expect(await aliceStore.getAction(proposed.id)).toEqual(proposed);
    expect(await bobStore.getAction(proposed.id)).toBeNull();
    // Nothing is carried out that nobody approved, and a stranger approves nothing.
    expect(await worker.claimAction(proposed.id)).toBe(0);
    expect(await bobStore.approveAction(proposed.id)).toBeNull();
    expect(await aliceStore.approveAction(proposed.id, "Changed line")).toMatchObject({
      status: "approved",
      approved_text: "Changed line",
    });
    await expect(aliceStore.declineAction(proposed.id)).rejects.toMatchObject({ kind: "limit" });
    await expect(aliceStore.claimAction(proposed.id)).rejects.toMatchObject({
      kind: "forbidden",
    });
    const inAMinute = new Date(Date.now() + 60_000).toISOString();
    expect(await worker.listStalledActions(inAMinute)).toContain(proposed.id);
    expect(await worker.claimAction(proposed.id)).toBe(1);
    // Taken a moment ago, it is not stalled yet. Left for longer than a hold lasts, it is.
    const aMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    expect(await worker.listStalledActions(aMinuteAgo)).not.toContain(proposed.id);
    expect(await worker.listStalledActions(inAMinute)).toContain(proposed.id);
    // The sample account's listings are the worker's alone.
    expect(await worker.getSampleLine(account.id, "listing-a")).toBeNull();
    await worker.setSampleLine(account.id, "listing-a", "Changed line");
    expect(await worker.getSampleLine(account.id, "listing-a")).toBe("Changed line");
    await expect(aliceStore.getSampleLine(account.id, "listing-a")).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(await worker.finishAction(proposed.id, "failed", "It could not be done.")).toBe(true);
    expect(await aliceStore.getAction(proposed.id)).toMatchObject({
      status: "failed",
      failure: "It could not be done.",
    });
    // Asked for again, it is a new action that points at the one that failed.
    expect(await bobStore.retryAction(proposed.id)).toBeNull();
    const again = await aliceStore.retryAction(proposed.id);
    if (!again) throw new Error("nothing was asked for again");
    expect(again).toMatchObject({ status: "approved", retry_of: proposed.id });
    expect(await worker.claimAction(again.id)).toBe(1);
    expect(await worker.finishAction(again.id, "done")).toBe(true);
    const other = await worker.proposeAction({ ...proposal, subject: "opening-line:other" });
    expect(await aliceStore.declineAction(other?.id ?? "", "Not this one")).toMatchObject({
      status: "declined",
      decline_reason: "Not this one",
    });
    expect(await worker.lapseActions()).toBe(0);
    // What an action replaced is dropped by the worker alone, and not before its day.
    await expect(aliceStore.dropExpiredSeen()).rejects.toMatchObject({ kind: "forbidden" });
    expect(await worker.dropExpiredSeen()).toBe(0);
    expect(await aliceStore.getAction(again.id)).toMatchObject({
      seen: { text: null },
      seen_dropped_at: null,
    });
    // Telling the owners, and holding back while they have not been told, are the worker's: no
    // member can keep that they were told, and a stranger reads nothing of what there is to tell.
    await expect(
      aliceStore.markActionsTold([again.id], "done", new Date().toISOString()),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(await bobStore.listActionsToTell()).toEqual([]);
    const untold = (await worker.listActionsToTell()).filter(
      (row) => row.organization_id === organization.id,
    );
    expect(untold.map((row) => [row.action.id, row.location_name])).toEqual([
      [again.id, location.name],
    ]);
    expect(await aliceStore.listUntoldActions()).toEqual([
      { location_id: location.id, done_at: expect.any(String) },
    ]);
    expect(await bobStore.listUntoldActions()).toEqual([]);
    expect(await worker.isOrganizationHeld(organization.id)).toBe(false);
    await expect(aliceStore.isOrganizationHeld(organization.id)).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(await aliceStore.isLocationHeld(location.id)).toBe(false);
    expect(await bobStore.isLocationHeld(location.id)).toBe(false);
    await worker.markActionsTold([again.id], "done", new Date().toISOString());
    expect(
      (await worker.listActionsToTell()).filter((row) => row.organization_id === organization.id),
    ).toEqual([]);
    expect(await aliceStore.listUntoldActions()).toEqual([]);
    await aliceStore.requestConnectionRemoval(account.id);
    expect(await worker.finishConnectionRemoval(account.id)).toBe(true);
    expect(await aliceStore.listLocationConnections(location.id)).toEqual([]);
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
    // What the business says it does is written when given and left alone when left out.
    const { what_we_do: _said, ...unsaid } = fields;
    expect(
      await aliceStore.updateLocation(location.id, { ...unsaid, what_we_do: "Wood-fired pizza." }),
    ).toEqual({ ...location, what_we_do: "Wood-fired pizza." });
    expect(await aliceStore.updateLocation(location.id, unsaid)).toEqual({
      ...location,
      what_we_do: "Wood-fired pizza.",
    });
    expect(await aliceStore.updateLocation(location.id, fields)).toEqual(location);
    await expect(
      aliceStore.updateLocation(location.id, { ...unsaid, what_we_do: "a".repeat(601) }),
    ).rejects.toThrow();
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
          phones: ["+19195550123"],
        },
        {
          tracked_query_id: query.id,
          surface: "gemini",
          mentioned: false,
          position: null,
          competitors: [],
          cited_urls: [],
          answer_excerpt: null,
          phones: [],
        },
      ],
      recommendations: [{ rule: "absent:gemini", title: "Not named on Gemini", detail: "Detail" }],
      alerts: {
        clear: [],
        raise: (["chatgpt", "gemini"] as const).map((surface) => ({
          kind: "drop" as const,
          subject: `${query.id}|${surface}`,
          tracked_query_id: query.id,
          surface,
          facts: { prompt: query.text, missed: 3, checks_before: 4, named_before: 4 },
          since: "2026-10-05T09:00:00Z",
        })),
      },
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
      // The number the answer gave for the business is kept with the result.
      phones: ["+19195550123"],
    });
    expect(results.find((r) => r.surface === "gemini")?.phones).toEqual([]);

    expect(await bobStore.getScan(scan.id)).toBeNull();
    expect(await bobStore.listScans(location.id, 5)).toEqual([]);
    expect(await bobStore.listScanResults(scan.id)).toEqual([]);

    // Alerts: kept with the scan that raised them, read by the location's members, and
    // dismissed by one of them. A dismissed alert is still current, which the worker is told.
    const raised = await aliceStore.listAlerts(location.id, false);
    const on = (surface: string) =>
      raised.find((candidate) => candidate.kind === "drop" && candidate.surface === surface);
    const alert = on("chatgpt");
    const dismissed = on("gemini");
    if (!alert || !dismissed) throw new Error("alert missing");
    expect(raised).toHaveLength(2);
    expect(alert).toMatchObject({
      kind: "drop",
      tracked_query_id: query.id,
      surface: "chatgpt",
      facts: { prompt: query.text, missed: 3, checks_before: 4, named_before: 4 },
      scan_id: scan.id,
      cleared_at: null,
      dismissed_at: null,
    });
    expect(Date.parse(alert.since)).toBe(Date.parse("2026-10-05T09:00:00Z"));
    expect(await aliceStore.listAlerts(location.id, true)).toEqual([]);
    expect(await bobStore.listAlerts(location.id, false)).toEqual([]);
    expect(await bobStore.dismissAlert(dismissed.id)).toBeNull();
    expect(await worker.dismissAlert(dismissed.id)).toBeNull();
    expect(await aliceStore.dismissAlert(dismissed.id)).toMatchObject({
      id: dismissed.id,
      dismissed_by_email: "alice@example.com",
    });
    expect(await worker.listAlerts(location.id, false)).toContainEqual(
      expect.objectContaining({ id: dismissed.id, dismissed_by_email: "alice@example.com" }),
    );
    // What the owners have not been told of leads the next report: not what a member dismissed
    // first, and nothing of a stranger's. Only the worker keeps that they were told.
    const nothing = { raised: [], named_again: [] };
    expect(await worker.listAlertsToTell(location.id, false)).toEqual({
      raised: [alert],
      named_again: [],
    });
    expect(await worker.listAlertsToTell(location.id, true)).toEqual(nothing);
    expect(await bobStore.listAlertsToTell(location.id, false)).toEqual(nothing);
    const told = { raised: [alert.id], named_again: [] };
    await expect(aliceStore.markAlertsTold(told, new Date().toISOString())).rejects.toMatchObject({
      kind: "forbidden",
    });
    await worker.markAlertsTold(told, new Date().toISOString());
    expect(await worker.listAlertsToTell(location.id, false)).toEqual(nothing);

    // Recommendations
    const [recommendation] = await aliceStore.listRecommendations(location.id);
    expect(recommendation).toMatchObject({ rule: "absent:gemini", status: "open" });
    if (!recommendation) throw new Error("recommendation missing");
    expect(await bobStore.listRecommendations(location.id)).toEqual([]);
    expect(await bobStore.setRecommendationStatus(recommendation.id, "done")).toBeNull();
    // Marking the work done: the database sets the time, whatever the request sent, and the
    // scan that was made before the mark is on its far side.
    expect(await bobStore.setRecommendationActed(recommendation.id, true)).toBeNull();
    const acted = await aliceStore.setRecommendationActed(recommendation.id, true);
    expect(acted?.acted_at).not.toBeNull();
    const around = await aliceStore.listResultsAround(
      location.id,
      acted?.acted_at ?? "",
      7,
      60,
      false,
    );
    expect(around.before.flat().length + around.since.flat().length).toBeGreaterThan(0);
    expect(around.since).toEqual([]);
    expect(
      await bobStore.listResultsAround(location.id, acted?.acted_at ?? "", 7, 60, false),
    ).toEqual({ before: [], since: [] });
    expect(await aliceStore.setRecommendationActed(recommendation.id, false)).toMatchObject({
      acted_at: null,
      acted_by_action: null,
    });

    // Drafts: a member asks, the worker writes, and the month counts what was written.
    expect(await aliceStore.listDrafts(location.id)).toEqual([]);
    await expect(aliceStore.askDraft(recommendation.id)).rejects.toMatchObject({ kind: "limit" });
    const service = client(await token({ role: "service_role" }));
    await service
      .from("organizations")
      .update({ allowances: { drafts: 1 }, max_locations: 1 })
      .eq("id", organization.id)
      .throwOnError();
    expect(await bobStore.askDraft(recommendation.id)).toBeNull();
    expect(await worker.askDraft(recommendation.id)).toBeNull();
    const draft = await aliceStore.askDraft(recommendation.id);
    expect(draft).toMatchObject({
      location_id: location.id,
      recommendation_id: recommendation.id,
      status: "asked",
      asked_by_email: "alice@example.com",
      text: null,
      kind: null,
      sample_data: false,
    });
    if (!draft) throw new Error("draft missing");
    expect((await aliceStore.askDraft(recommendation.id))?.id).toBe(draft.id);
    expect(await aliceStore.listDrafts(location.id)).toEqual([draft]);
    expect(await bobStore.listDrafts(location.id)).toEqual([]);
    expect(await worker.getDraft(draft.id)).toEqual(draft);
    expect(await worker.getDraft(crypto.randomUUID())).toBeNull();
    await expect(aliceStore.claimDraft(draft.id)).rejects.toMatchObject({ kind: "forbidden" });
    await expect(
      aliceStore.finishDraft(draft.id, { outcome: "failed", why: "No." }),
    ).rejects.toMatchObject({ kind: "forbidden" });

    // Not stalled until it has waited, and then it is.
    const afterTheAsk = new Date(Date.now() + 60_000).toISOString();
    expect(await worker.listStalledDrafts(draft.asked_at)).not.toContain(draft.id);
    expect(await worker.listStalledDrafts(afterTheAsk)).toContain(draft.id);

    expect(await worker.claimDraft(draft.id)).toBe(1);
    expect(await worker.claimDraft(draft.id)).toBe(0);
    expect(await aliceStore.getAllowanceUse(organization.id)).toEqual({ drafts: 1 });
    expect(await worker.finishDraft(draft.id, { outcome: "again", why: "Not yet." })).toBe(true);
    expect(await worker.claimDraft(draft.id)).toBe(2);
    expect(
      await worker.finishDraft(draft.id, {
        outcome: "written",
        text: "Hello.",
        kind: "note",
        model: null,
        sample_data: true,
      }),
    ).toBe(true);
    expect(await aliceStore.listDrafts(location.id)).toMatchObject([
      { status: "written", text: "Hello.", kind: "note", sample_data: true, failure: null },
    ]);
    expect(await worker.listStalledDrafts(afterTheAsk)).not.toContain(draft.id);
    // The month is used. What was written stays.
    await expect(aliceStore.askDraft(recommendation.id)).rejects.toMatchObject({
      kind: "limit",
      message: expect.stringContaining("no more drafts"),
    });
    await service
      .from("organizations")
      .update({ allowances: { drafts: 2 } })
      .eq("id", organization.id)
      .throwOnError();
    expect(await aliceStore.askDraft(recommendation.id)).toMatchObject({
      status: "asked",
      text: "Hello.",
    });
    await worker.claimDraft(draft.id);
    expect(await aliceStore.getAllowanceUse(organization.id)).toEqual({ drafts: 2 });
    expect(await worker.finishDraft(draft.id, { outcome: "failed", why: "It failed." })).toBe(true);
    expect(await aliceStore.listDrafts(location.id)).toMatchObject([
      { status: "failed", text: "Hello.", failure: "It failed." },
    ]);
    expect(await aliceStore.getAllowanceUse(organization.id)).toEqual({ drafts: 1 });
    // What a draft used is recorded for its organization, and for no surface.
    const wrote = {
      surface: null,
      model: "draft-model",
      calls: 1,
      input_tokens: 400,
      cached_input_tokens: 0,
      output_tokens: 150,
      searches: 0,
    };
    const forDraft = { organization_id: organization.id, draft_id: draft.id };
    await worker.recordUsage(forDraft, [wrote]);
    await expect(aliceStore.recordUsage(forDraft, [wrote])).rejects.toBeInstanceOf(StoreError);
    expect(
      (await worker.listUsageByMonth(new Date(Date.now() - 86_400_000).toISOString())).filter(
        (month) => month.model === "draft-model",
      ),
    ).toMatchObject([{ organization_id: organization.id, is_audit: false, calls: 1 }]);
    await service
      .from("organizations")
      .update({ allowances: {}, max_locations: organization.max_locations })
      .eq("id", organization.id)
      .throwOnError();
    // An action that does the work marks it when it is carried out, and that mark is not a
    // member's to take back.
    const forTask = await worker.proposeAction({
      ...proposal,
      connection_id: null,
      subject: "opening-line:for-the-task",
      recommendation_id: recommendation.id,
    });
    if (!forTask) throw new Error("nothing was proposed for the task");
    await aliceStore.approveAction(forTask.id);
    expect(await worker.claimAction(forTask.id)).toBe(1);
    expect(await worker.finishAction(forTask.id, "done")).toBe(true);
    await worker.markActionsTold([forTask.id], "done", new Date().toISOString());
    expect(await aliceStore.listRecommendations(location.id)).toContainEqual(
      expect.objectContaining({ id: recommendation.id, acted_by_action: forTask.id }),
    );
    await expect(aliceStore.setRecommendationActed(recommendation.id, false)).rejects.toMatchObject(
      { kind: "limit" },
    );
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
    await worker.completeScan(scan.id, {
      score: 80,
      results,
      recommendations: [],
      site: check,
      // The scan that finishes is also what clears an alert.
      // and what raises the other kinds, which are about no one prompt.
      alerts: {
        clear: [alert.id, dismissed.id].map((id) => ({ id, reason: "named_again" as const })),
        raise: [
          {
            kind: "competitor",
            subject: "oak and ember",
            facts: {
              name: "Oak & Ember",
              answers: 3,
              scans: 2,
              of_scans: 3,
              places: [{ prompt: query.text, surfaces: ["chatgpt"] }],
              prompts: 1,
            },
            since: "2026-10-05T09:00:00Z",
          },
          {
            kind: "site",
            subject: "raleighfood.example",
            facts: {
              host: "raleighfood.example",
              answers: 3,
              scans: 2,
              of_scans: 3,
              named: 0,
              own: false,
              url: "https://raleighfood.example/best-pizza",
            },
            since: "2026-10-05T09:00:00Z",
          },
          {
            kind: "phone",
            subject: "+19195550123",
            facts: {
              number: "+19195550123",
              on_file: "+19195550100",
              country_code: "US",
              answers: 2,
              scans: 2,
              of_scans: 7,
              places: [{ prompt: query.text, surfaces: ["chatgpt"] }],
              prompts: 1,
            },
            since: "2026-10-05T09:00:00Z",
          },
        ],
      },
    });
    const sightings = await aliceStore.listAlerts(location.id, false);
    expect(sightings.map((sighting) => [sighting.kind, sighting.facts]).sort()).toEqual([
      ["competitor", expect.objectContaining({ name: "Oak & Ember", prompts: 1 })],
      ["phone", expect.objectContaining({ number: "+19195550123", on_file: "+19195550100" })],
      ["site", expect.objectContaining({ host: "raleighfood.example", own: false })],
    ]);
    // The owners were told of one of the two drops, so they are told once that it ended.
    const ended = await worker.listAlertsToTell(location.id, false);
    expect(ended.raised.map((sighting) => sighting.kind).sort()).toEqual([
      "competitor",
      "phone",
      "site",
    ]);
    expect(ended.named_again).toMatchObject([{ id: alert.id, clear_reason: "named_again" }]);
    await worker.markAlertsTold(
      { raised: sightings.map((sighting) => sighting.id), named_again: [alert.id] },
      new Date().toISOString(),
    );
    expect(await worker.listAlertsToTell(location.id, false)).toEqual({
      raised: [],
      named_again: [],
    });
    // A first sighting is news, and is cleared as old news by a later scan. A number is cleared
    // when the answers no longer give it.
    await worker.completeScan(scan.id, {
      score: 80,
      results,
      recommendations: [],
      site: check,
      alerts: {
        clear: sightings.map((sighting) => ({
          id: sighting.id,
          reason: sighting.kind === "phone" ? ("no_longer_given" as const) : ("old_news" as const),
        })),
        raise: [],
      },
    });
    expect(await aliceStore.listAlerts(location.id, false)).toEqual([]);
    // "For the first time" is said of the whole record, which only the worker reads: what the
    // written answers of every scan but the newest few named and cited, as it was written.
    expect(await worker.listSeenBefore(location.id, false, 0)).toEqual({
      competitors: ["Tony's Slice House"],
      origins: ["https://joes.example"],
    });
    expect(await worker.listSeenBefore(location.id, false, 1)).toEqual({
      competitors: [],
      origins: [],
    });
    expect(await worker.listSeenBefore(location.id, true, 0)).toEqual({
      competitors: [],
      origins: [],
    });
    await expect(aliceStore.listSeenBefore(location.id, false, 0)).rejects.toMatchObject({
      kind: "forbidden",
    });
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
