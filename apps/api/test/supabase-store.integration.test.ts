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
const carol = "c0000000-0000-4000-8000-000000000003";

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
      // What the plan includes comes with it.
      allowances: { drafts: 30 },
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
      sells_stronger: false,
      current: null,
      versions: [],
    });
    // Enterprise sells stronger models; it has no price for them here either.
    expect(
      (await aliceStore.listPlanPrices()).find((plan) => plan.key === "enterprise")?.sells_stronger,
    ).toBe(true);
    // Setting one is the operator's alone.
    expect(
      await aliceStore.setPlanPrices("standard", {
        price_cents: 100,
        extra_location_price_cents: null,
        stripe_price_id: `price_${crypto.randomUUID()}`,
        stripe_extra_location_price_id: null,
        stronger_price_cents: null,
        stripe_stronger_price_ids: null,
      }),
    ).toBeNull();
    expect(
      (await worker.listPlanPrices()).find((plan) => plan.key === "standard")?.versions,
    ).toEqual([]);
    // Which assistants are on Stronger comes with the plan, from what the subscription pays for,
    // and only on a plan that sells it.
    expect(
      (await worker.applyPlan(fresh.id, "enterprise", undefined, ["claude"]))?.stronger_surfaces,
    ).toEqual(["claude"]);
    expect((await worker.applyPlan(fresh.id, "enterprise"))?.stronger_surfaces).toEqual(["claude"]);
    const organization = await worker.applyPlan(fresh.id, "starter", undefined, ["claude"]);
    if (!organization) throw new Error("The plan was not applied.");
    // Starter sells none, whatever the subscription says it pays for.
    expect(organization.stronger_surfaces).toEqual([]);
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
    // An account connected from a location is matched there by its first sync, when it reaches
    // one thing. Only from a location of the organization's own.
    const fromLocation = { ...account, id: crypto.randomUUID(), for_location: location.id };
    expect(
      await aliceStore.createConnection({ ...fromLocation, for_location: crypto.randomUUID() }),
    ).toBeNull();
    await aliceStore.createConnection(fromLocation);
    await worker.recordConnectionSync(fromLocation.id, [{ id: "site", label: "The site" }]);
    expect(await aliceStore.listLocationConnections(location.id)).toEqual([
      {
        connection_id: fromLocation.id,
        kind: "sample",
        label: "Sample account",
        external_label: "The site",
      },
    ]);
    await aliceStore.unmatchConnectionLocation(fromLocation.id, location.id);
    await aliceStore.requestConnectionRemoval(fromLocation.id);
    await worker.finishConnectionRemoval(fromLocation.id);
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
    // Taking back what was done is a member's ask, made as a new action already approved.
    expect(await bobStore.takeBackAction(again.id)).toBeNull();
    const back = await aliceStore.takeBackAction(again.id);
    expect(back).toMatchObject({
      status: "approved",
      takes_back: again.id,
      // What it put there, which a member had changed before saying yes.
      seen: { text: "Changed line" },
      proposed_text: null,
    });
    await expect(aliceStore.takeBackAction(again.id)).rejects.toMatchObject({ kind: "limit" });
    expect(await worker.claimAction(back?.id ?? "")).toBe(1);
    expect(await worker.finishAction(back?.id ?? "", "done")).toBe(true);
    await worker.markActionsTold([back?.id ?? ""], "done", new Date().toISOString());
    // Standing permission: shown to a member, given and ended by an owner or admin through the
    // functions that refuse it until three were approved as proposed, and told by the worker.
    expect(await aliceStore.getPermissionState(location.id)).toEqual({
      permissions: [],
      permission_included: false,
      may_change_permission: true,
    });
    expect(await bobStore.getPermissionState(location.id)).toBeNull();
    expect(await bobStore.giveStandingPermission(organization.id, "sample")).toBeNull();
    await expect(
      aliceStore.giveStandingPermission(organization.id, "sample"),
    ).rejects.toMatchObject({ kind: "limit" });
    expect(await bobStore.endStandingPermission(organization.id, "sample")).toBeNull();
    await expect(aliceStore.endStandingPermission(organization.id, "sample")).rejects.toMatchObject(
      { kind: "limit" },
    );
    expect(await bobStore.listPermissionsToTell()).toEqual([]);
    await expect(
      aliceStore.markPermissionsTold([organization.id], "given", new Date().toISOString()),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(
      (await worker.listPermissionsToTell()).filter(
        (row) => row.organization_id === organization.id,
      ),
    ).toEqual([]);
    // Three approved as proposed and done, on a plan that includes it.
    await client(await token({ role: "service_role" }))
      .from("organizations")
      .update({ allowances: { standing_permission: true } })
      .eq("id", organization.id)
      .throwOnError();
    const earned: string[] = [];
    for (const n of [1, 2, 3]) {
      const one = await worker.proposeAction({ ...proposal, subject: `standing:${n}` });
      await aliceStore.approveAction(one?.id ?? "");
      await worker.claimAction(one?.id ?? "");
      await worker.finishAction(one?.id ?? "", "done");
      earned.push(one?.id ?? "");
    }
    await worker.markActionsTold(earned, "done", new Date().toISOString());
    const given = await aliceStore.giveStandingPermission(organization.id, "sample");
    expect(given).toMatchObject({ kind: "sample", given_by_email: "alice@example.com" });
    expect(await bobStore.getPermissionState(location.id)).toBeNull();
    expect(await aliceStore.getPermissionState(location.id)).toEqual({
      permissions: [{ kind: "sample", counted: 3, standing: given }],
      permission_included: true,
      may_change_permission: true,
    });
    const underIt = await worker.proposeAction({ ...proposal, subject: "standing:4" });
    expect(underIt).toMatchObject({
      status: "approved",
      approved_under: given?.id,
      approved_under_by_email: "alice@example.com",
    });
    expect(
      (await worker.listPermissionsToTell()).filter(
        (row) => row.organization_id === organization.id,
      ),
    ).toEqual([
      {
        permission: given,
        organization_id: organization.id,
        given_untold: true,
        ended_untold: false,
      },
    ]);
    await worker.markPermissionsTold([given?.id ?? ""], "given", new Date().toISOString());
    expect(await aliceStore.endStandingPermission(organization.id, "sample")).toMatchObject({
      end_reason: "switched_off",
      ended_by_email: "alice@example.com",
    });
    expect(await aliceStore.getAction(underIt?.id ?? "")).toMatchObject({
      status: "proposed",
      approved_under: null,
    });
    await aliceStore.declineAction(underIt?.id ?? "");
    expect(
      (await worker.listPermissionsToTell()).filter(
        (row) => row.organization_id === organization.id,
      ),
    ).toMatchObject([{ given_untold: false, ended_untold: true }]);
    await worker.markPermissionsTold([given?.id ?? ""], "ended", new Date().toISOString());
    // One that always asks is proposed so, and waits.
    const asks = await worker.proposeAction({
      ...proposal,
      subject: "opening-line:asks",
      always_asks: true,
    });
    expect(asks).toMatchObject({ status: "proposed", always_asks: true, approved_under: null });
    await aliceStore.declineAction(asks?.id ?? "");
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

    // The point Google is checked from is the worker's to keep. A member's write leaves it.
    const point = {
      latitude: 35.7796,
      longitude: -78.6382,
      point_source: "address" as const,
      geocoded_from: "1 Main St, Raleigh, US",
    };
    await worker.setLocationPoint(location.id, point);
    await aliceStore.setLocationPoint(location.id, { ...point, latitude: 1, longitude: 1 });
    expect(await aliceStore.getLocation(location.id)).toMatchObject(point);

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
          tier: "stronger",
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
        {
          tracked_query_id: query.id,
          surface: "google_ai_overview",
          shown: false,
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
          tier: surface === "chatgpt" ? ("stronger" as const) : ("standard" as const),
          facts: { prompt: query.text, missed: 3, checks_before: 4, named_before: 4 },
          since: "2026-10-05T09:00:00Z",
        })),
      },
    });

    const finished = await aliceStore.getScan(scan.id);
    expect(finished).toMatchObject({ status: "succeeded", visibility_score: 62.5, error: null });
    // The scan keeps the tier it asked each surface on.
    expect(finished?.tiers).toEqual({
      chatgpt: "stronger",
      gemini: "standard",
      google_ai_overview: "standard",
    });
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
      ["google_ai_overview", false, null],
    ]);
    // A search where Google showed nothing is kept as one; the rest showed something.
    expect(results.map((r) => [r.surface, r.shown]).sort()).toEqual([
      ["chatgpt", true],
      ["gemini", true],
      ["google_ai_overview", false],
    ]);
    expect(results.find((r) => r.surface === "chatgpt")).toMatchObject({
      competitors: ["Tony's Slice House"],
      cited_urls: ["https://joes.example"],
      // The number the answer gave for the business is kept with the result.
      phones: ["+19195550123"],
    });
    expect(results.find((r) => r.surface === "gemini")?.phones).toEqual([]);
    // Each keeps the tier it was asked on, Standard where the worker did not say.
    expect(results.map((r) => [r.surface, r.tier]).sort()).toEqual([
      ["chatgpt", "stronger"],
      ["gemini", "standard"],
      ["google_ai_overview", "standard"],
    ]);

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
      tier: "stronger",
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

    // Downloading everything: its owner is given all of it, the scan's answers and alerts
    // included, in the shape the app is sent them. Nobody else is given any, the worker included.
    const exported = await aliceStore.exportOrganization(fresh.id);
    expect(exported?.organization.id).toBe(fresh.id);
    expect(exported?.locations.map((row) => row.id)).toContain(location.id);
    expect(exported?.answers.map((row) => row.scan_id)).toContain(scan.id);
    expect(exported?.alerts.map((row) => row.id).sort()).toEqual(
      raised.map((row) => row.id).sort(),
    );
    expect(await bobStore.exportOrganization(fresh.id)).toBeNull();
    expect(await worker.exportOrganization(fresh.id)).toBeNull();

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
    const service = client(await token({ role: "service_role" }));
    // On a plan with none, as the free plan is, there is nothing to ask for.
    await service
      .from("organizations")
      .update({ allowances: {} })
      .eq("id", organization.id)
      .throwOnError();
    await expect(aliceStore.askDraft(recommendation.id)).rejects.toMatchObject({ kind: "limit" });
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
      .update({ allowances: organization.allowances, max_locations: organization.max_locations })
      .eq("id", organization.id)
      .throwOnError();

    // A listing is given by a member, kept one for a site, and read by whoever reads the location.
    const page = "https://www.bbb.org/us/nc/raleigh/profile/pizza/joes-pizza-0593-1234";
    expect(await aliceStore.listListings(location.id)).toEqual([]);
    expect(await bobStore.setListing(location.id, "bbb.org", page)).toBeNull();
    expect(await worker.setListing(location.id, "bbb.org", page)).toBeNull();
    const listing = await aliceStore.setListing(location.id, "bbb.org", page);
    expect(listing).toEqual({
      location_id: location.id,
      site: "bbb.org",
      url: page,
      set_by_email: "alice@example.com",
      set_at: expect.any(String),
    });
    expect(await aliceStore.setListing(location.id, "bbb.org", `${page}-2`)).toMatchObject({
      url: `${page}-2`,
    });
    await aliceStore.setListing(location.id, "angi.com", "https://www.angi.com/joes");
    expect((await aliceStore.listListings(location.id)).map((kept) => kept.site)).toEqual([
      "angi.com",
      "bbb.org",
    ]);
    expect(await bobStore.listListings(location.id)).toEqual([]);
    // What is not an address to follow over https is refused by the table itself.
    await expect(
      aliceStore.setListing(location.id, "houzz.com", "javascript:alert(1)"),
    ).rejects.toBeInstanceOf(StoreError);
    expect(await bobStore.removeListing(location.id, "bbb.org")).toBe(false);
    expect(await aliceStore.removeListing(location.id, "bbb.org")).toBe(true);
    expect(await aliceStore.removeListing(location.id, "bbb.org")).toBe(false);
    expect(await aliceStore.removeListing(location.id, "angi.com")).toBe(true);
    expect(await aliceStore.listListings(location.id)).toEqual([]);

    // Where a page for a prompt is: given by a member, for a page task only.
    const { data: pageTask } = await service
      .from("recommendations")
      .insert({
        location_id: location.id,
        rule: `page:${crypto.randomUUID()}`,
        title: "Publish a page",
        detail: "Detail",
      })
      .select("id")
      .single()
      .throwOnError();
    const pageAt = "https://joespizza.example/late-night";
    expect(await bobStore.setPromptPage(pageTask.id, pageAt)).toBeNull();
    expect(await aliceStore.setPromptPage(pageTask.id, pageAt)).toEqual({
      recommendation_id: pageTask.id,
      url: pageAt,
      set_by_email: "alice@example.com",
      set_at: expect.any(String),
      action_id: null,
    });
    expect((await aliceStore.listPromptPages(location.id)).map((kept) => kept.url)).toEqual([
      pageAt,
    ]);
    expect(await bobStore.listPromptPages(location.id)).toEqual([]);
    // Where a page an action published is kept by the worker alone.
    await expect(aliceStore.keepPublishedPage(crypto.randomUUID(), pageAt)).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(await worker.keepPublishedPage(crypto.randomUUID(), pageAt)).toBe(false);
    expect(await bobStore.removePromptPage(pageTask.id)).toBe(false);
    expect(await aliceStore.removePromptPage(pageTask.id)).toBe(true);
    expect(await aliceStore.listPromptPages(location.id)).toEqual([]);
    await service.from("recommendations").delete().eq("id", pageTask.id).throwOnError();

    // A visit is counted for whoever holds the site's key, signed in or not: on a plan that
    // includes visits, for a page on the location's own site.
    const anyone = createSupabaseStore(client(await token({ role: "anon" })));
    const { data: line } = await service
      .from("visit_lines")
      .select("key")
      .eq("location_id", location.id)
      .single()
      .throwOnError();
    const visit = {
      key: line.key as string,
      host: "www.joes-pizza.example",
      assistant: "chatgpt",
      path: "/menu?table=4",
    } as const;
    await service
      .from("locations")
      .update({ website: "https://joes-pizza.example/" })
      .eq("id", location.id)
      .throwOnError();
    await service
      .from("organizations")
      .update({ allowances: {} })
      .eq("id", organization.id)
      .throwOnError();
    expect(await anyone.recordVisit(visit)).toBe(false);
    expect(await anyone.checkVisitLine(visit)).toBe(false);
    await service
      .from("organizations")
      .update({ allowances: { visits: true } })
      .eq("id", organization.id)
      .throwOnError();
    expect(await anyone.recordVisit(visit)).toBe(true);
    expect(await bobStore.recordVisit({ ...visit, path: "/menu" })).toBe(true);
    expect(await anyone.recordVisit({ ...visit, host: "elsewhere.example" })).toBe(false);
    expect(await anyone.recordVisit({ ...visit, key: "0".repeat(32) })).toBe(false);
    expect(await anyone.checkVisitLine({ ...visit, host: "elsewhere.example" })).toBe(false);
    expect(await anyone.checkVisitLine(visit)).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect(
      (
        await service
          .from("visits")
          .select("day, assistant, path, count")
          .eq("location_id", location.id)
          .throwOnError()
      ).data,
    ).toEqual([{ day: today, assistant: "chatgpt", path: "/menu", count: 2 }]);
    expect(
      (
        await service
          .from("visit_lines")
          .select("checked_on")
          .eq("location_id", location.id)
          .single()
          .throwOnError()
      ).data,
    ).toEqual({ checked_on: today });
    // Nobody but the worker reads or writes the count directly: a stranger holds only the key.
    expect(
      (
        await client(await token({ role: "anon" }))
          .from("visits")
          .select("day")
      ).error,
    ).not.toBeNull();
    // The counts are read added up, by whoever reads the location.
    expect(await aliceStore.getLocationVisits(location.id, 30)).toEqual({
      since: new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10),
      days: [{ day: today, assistant: "chatgpt", count: 2 }],
      pages: [{ path: "/menu", count: 2 }],
      other_pages: 0,
    });
    expect(await bobStore.getLocationVisits(location.id, 30)).toMatchObject({
      days: [],
      pages: [],
      other_pages: 0,
    });

    // The line is read by whoever reads the location, and its key replaced by an owner or admin.
    expect(await aliceStore.getVisitLine(location.id)).toEqual({
      location_id: location.id,
      key: visit.key,
      key_made_at: expect.any(String),
      checked_on: today,
    });
    expect(await bobStore.getVisitLine(location.id)).toBeNull();
    expect(await bobStore.replaceSiteKey(location.id)).toBeNull();
    expect(await worker.replaceSiteKey(location.id)).toBeNull();
    const replaced = await aliceStore.replaceSiteKey(location.id);
    expect(replaced).toMatchObject({ location_id: location.id, checked_on: null });
    expect(replaced?.key).not.toBe(visit.key);
    expect(await anyone.recordVisit(visit)).toBe(false);
    expect(await anyone.recordVisit({ ...visit, key: replaced?.key ?? "" })).toBe(true);
    await service.from("visits").delete().eq("location_id", location.id).throwOnError();
    await service
      .from("organizations")
      .update({ allowances: organization.allowances })
      .eq("id", organization.id)
      .throwOnError();
    await service
      .from("locations")
      .update({ website: location.website })
      .eq("id", location.id)
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

    // Answer subdomains: made by an owner or admin, read by members, checked by the worker.
    const included = await aliceStore.getOrganization(organization.id);
    await admin
      .from("organizations")
      .update({
        max_locations: 20,
        allowances: { ...included?.allowances, hosted_pages: true },
      })
      .eq("id", organization.id)
      .throwOnError();
    const answering = {
      name: "Answering Pizza",
      website: "https://www.answering-pizza.example/menu",
      phone: null,
      address_line: null,
      city: "Raleigh",
      region: "NC",
      postal_code: null,
      country_code: "US",
      google_place_id: null,
      primary_category: null,
    };
    const site = await aliceStore.createLocation(organization.id, answering);
    const subdomain = {
      id: crypto.randomUUID(),
      location_id: site.id,
      label: "answers",
      target: "abcdefabcdef",
    };
    expect(await bobStore.createAnswerSubdomain(subdomain)).toBeNull();
    expect(await aliceStore.createAnswerSubdomain(subdomain)).toMatchObject({
      id: subdomain.id,
      kind: "hosted_pages",
      label: "answers.answering-pizza.example",
    });
    // Matched to its location at once.
    expect(await aliceStore.listLocationConnections(site.id)).toEqual([
      {
        connection_id: subdomain.id,
        kind: "hosted_pages",
        label: "answers.answering-pizza.example",
        external_label: "answers.answering-pizza.example",
      },
    ]);
    // One for a location.
    await expect(
      aliceStore.createAnswerSubdomain({
        ...subdomain,
        id: crypto.randomUUID(),
        target: "b".repeat(12),
      }),
    ).rejects.toMatchObject({ kind: "limit" });
    // A member reads it, but not what the worker keeps for itself.
    expect(await aliceStore.getLocationAnswerSubdomain(site.id)).toMatchObject({
      connection_id: subdomain.id,
      hostname: "answers.answering-pizza.example",
      target: "abcdefabcdef",
      record: null,
      cloudflare_id: null,
      status: "working",
    });
    expect(await bobStore.getLocationAnswerSubdomain(site.id)).toBeNull();
    expect(await worker.listAnswerSubdomainsToCheck(new Date().toISOString())).toContain(
      subdomain.id,
    );
    expect(
      await worker.recordAnswerSubdomainCheck(subdomain.id, {
        record: "ours",
        cloudflare_id: "ch-1",
        live: true,
        home_links: false,
      }),
    ).toBe(true);
    const checked = await worker.getAnswerSubdomain(subdomain.id);
    expect(checked).toMatchObject({ record: "ours", cloudflare_id: "ch-1", home_links: false });
    expect(checked?.registered_at).not.toBeNull();
    expect(checked?.live_at).not.toBeNull();
    expect(checked?.live_told_at).toBeNull();
    await worker.markAnswerSubdomainTold(subdomain.id);
    // A page published on it by an approved action, and taken back.
    const [publishing] = (
      await admin
        .from("actions")
        .insert({
          location_id: site.id,
          kind: "hosted_page",
          connection_id: subdomain.id,
          subject: "page:integration",
          basis: "Late night\n\nWords.",
          summary: "Publish the page",
          seen: { text: null },
          proposed_text: "Late night\n\nWords.",
          written_by: "model",
          status: "approved",
        })
        .select("id")
        .throwOnError()
    ).data as { id: string }[];
    if (!publishing) throw new Error("no action to publish with");
    const hosted = { slug: "late-night", title: "Late night", copy: "Late night\n\nWords." };
    expect(await worker.publishHostedPage(publishing.id, hosted)).toBe(
      "https://answers.answering-pizza.example/late-night",
    );
    expect(await worker.getHostedPage(subdomain.id, "late-night")).toMatchObject({
      ...hosted,
      action_id: publishing.id,
      taken_back_at: null,
    });
    await expect(worker.publishHostedPage(publishing.id, hosted)).rejects.toMatchObject({
      kind: "conflict",
    });
    // Fetches of it are read added up, by members of its organization alone.
    const published = await worker.getHostedPage(subdomain.id, "late-night");
    const fetchedOn = new Date().toISOString().slice(0, 10);
    await admin
      .from("hosted_page_fetches")
      .insert([
        {
          hosted_page_id: published?.id,
          location_id: site.id,
          day: fetchedOn,
          fetcher: "claudebot",
          count: 3,
        },
        {
          hosted_page_id: published?.id,
          location_id: site.id,
          day: "2026-01-01",
          fetcher: "claudebot",
          count: 9,
        },
      ])
      .throwOnError();
    await admin
      .from("hosted_pages")
      .update({ recommendation_id: null })
      .eq("id", published?.id ?? "")
      .throwOnError();
    // A page that does no task is not shown on one.
    expect(await aliceStore.listLocationPageFetches(site.id, "2026-01-01")).toEqual([]);
    const [task] = (
      await admin
        .from("recommendations")
        .insert({
          location_id: site.id,
          rule: "page:integration",
          title: "Publish a page",
          detail: "Detail",
        })
        .select("id")
        .throwOnError()
    ).data as { id: string }[];
    await admin
      .from("hosted_pages")
      .update({ recommendation_id: task?.id })
      .eq("id", published?.id ?? "")
      .throwOnError();
    expect(await aliceStore.listLocationPageFetches(site.id, "2026-06-01")).toEqual([
      { recommendation_id: task?.id, fetcher: "claudebot", count: 3, last_on: fetchedOn },
    ]);
    expect(await bobStore.listLocationPageFetches(site.id, "2026-01-01")).toEqual([]);
    expect(await worker.takeBackHostedPage(publishing.id)).toBe(true);
    // A paused one's owners are told once.
    await admin
      .from("connections")
      .update({ status: "paused", paused_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", subdomain.id)
      .throwOnError();
    expect(await worker.listPausedAnswerSubdomainsUntold()).toContain(subdomain.id);
    await worker.markAnswerSubdomainPauseTold(subdomain.id);
    expect(await worker.listPausedAnswerSubdomainsUntold()).not.toContain(subdomain.id);
    await admin
      .from("connections")
      .update({ status: "working", paused_at: null })
      .eq("id", subdomain.id)
      .throwOnError();
    expect(await worker.getHostedPage(subdomain.id, "late-night")).toBeNull();
    expect((await worker.getAnswerSubdomain(subdomain.id))?.live_told_at).not.toBeNull();
    expect(await worker.listAnswerSubdomainsToCheck(new Date().toISOString())).not.toContain(
      subdomain.id,
    );
    expect(await worker.expireUnclaimedAnswerSubdomains()).toEqual([]);
    // A name is held by one connection at a time, across every organization.
    const sameDomain = await aliceStore.createLocation(organization.id, {
      ...answering,
      name: "Answering Pizza North",
    });
    await expect(
      aliceStore.createAnswerSubdomain({
        id: crypto.randomUUID(),
        location_id: sameDomain.id,
        label: "answers",
        target: "c".repeat(12),
      }),
    ).rejects.toMatchObject({ kind: "conflict" });
    // Removed, the name is free again.
    await aliceStore.requestConnectionRemoval(subdomain.id);
    expect(await worker.finishConnectionRemoval(subdomain.id)).toBe(true);
    // The last one is still read, as removed, until another is set up.
    expect(await aliceStore.getLocationAnswerSubdomain(site.id)).toMatchObject({
      connection_id: subdomain.id,
      status: "removed",
      removal_reason: "asked",
    });
    expect(
      await aliceStore.createAnswerSubdomain({
        id: crypto.randomUUID(),
        location_id: sameDomain.id,
        label: "answers",
        target: "c".repeat(12),
      }),
    ).toMatchObject({ label: "answers.answering-pizza.example" });
    // The next test counts the locations it makes.
    for (const made of [site, sameDomain]) await aliceStore.deleteLocation(made.id);
  });

  it("closes an account: the owner's ask, the worker's record of it, and the organization's deletion", async () => {
    const carolStore = await storeFor(carol);
    const bobStore = await storeFor(bob);
    const worker = await workerStore();
    const organization = await carolStore.createOrganization("Carol's Cafe");

    expect(await bobStore.requestClosing(organization.id, "Carol's Cafe")).toEqual({
      refused: "owners_only",
    });
    expect(await carolStore.requestClosing(organization.id, "Carol's")).toEqual({
      refused: "name_mismatch",
    });
    const asked = await carolStore.requestClosing(organization.id, "Carol's Cafe");
    if (!("closing_id" in asked)) throw new Error("not asked");
    expect(await carolStore.requestClosing(organization.id, "Carol's Cafe")).toEqual(asked);
    // From the ask, the organization is out of its members' reach.
    expect(await carolStore.listOrganizations()).toEqual([]);
    // Only the worker reads the closing.
    await expect(carolStore.getClosing(asked.closing_id)).rejects.toThrow();
    const closing = await worker.getClosing(asked.closing_id);
    expect(closing).toMatchObject({
      organization_id: organization.id,
      organization_name: "Carol's Cafe",
      owner_id: carol,
      owner_email: "carol@example.com",
      member_emails: [],
      finished_at: null,
    });
    expect(await worker.listStalledClosings(new Date(Date.now() + 60_000).toISOString())).toContain(
      asked.closing_id,
    );

    // One worker at a time, until it lets go.
    expect(await worker.claimClosing(asked.closing_id)).toBe(true);
    expect(await worker.claimClosing(asked.closing_id)).toBe(false);
    await worker.releaseClosing(asked.closing_id);
    expect(await worker.claimClosing(asked.closing_id)).toBe(true);

    await worker.recordClosingProgress(asked.closing_id, {
      cancelled_at: new Date().toISOString(),
      left_at_sites: ["carolscafe.example"],
    });
    expect(await worker.getClosing(asked.closing_id)).toMatchObject({
      left_at_sites: ["carolscafe.example"],
    });
    await expect(carolStore.deleteClosedOrganization(organization.id)).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(await worker.deleteClosedOrganization(organization.id)).toBe(true);
    expect(await worker.getOrganization(organization.id)).toBeNull();

    expect(await worker.finishClosing(asked.closing_id)).toBe(true);
    expect(await worker.finishClosing(asked.closing_id)).toBe(false);
    expect(await worker.getClosing(asked.closing_id)).toMatchObject({
      organization_name: null,
      owner_id: null,
      owner_email: null,
      member_emails: [],
      left_at_sites: [],
    });
    expect(await worker.dropFinishedClosings(new Date(Date.now() + 60_000).toISOString())).toBe(1);
    expect(await worker.getClosing(asked.closing_id)).toBeNull();
  });

  it("brings a teammate in by invitation, and keeps an owner", async () => {
    // Carol's first organization was closed above, so she may make another.
    const carolStore = await storeFor(carol);
    const bobStore = await storeFor(bob);
    const aliceStore = await storeFor(alice);
    const admin = client(await token({ role: "service_role" }));
    const organization = await carolStore.createOrganization("Carol's Bakery");

    // Only an owner invites.
    expect(await bobStore.inviteMember(organization.id, "x@example.com", "member")).toBeNull();
    const first = await carolStore.inviteMember(organization.id, " Bob@Example.com", "admin");
    if (!first) throw new Error("not invited");
    expect(first).toMatchObject({
      email: "bob@example.com",
      role: "admin",
      invited_by_email: "carol@example.com",
      outcome: null,
    });
    await expect(carolStore.sendInvitationAgain(organization.id, first.id)).rejects.toMatchObject({
      kind: "limit",
      message: expect.stringContaining("less than an hour ago"),
    });
    expect((await carolStore.listInvitations(organization.id)).map((i) => i.id)).toEqual([
      first.id,
    ]);
    expect(await bobStore.listInvitations(organization.id)).toEqual([]);
    expect(await bobStore.listMyInvitations()).toEqual([
      expect.objectContaining({ id: first.id, organization_name: "Carol's Bakery", role: "admin" }),
    ]);

    // Cancelled, it is gone for him; invited again, he accepts and is in with its role.
    expect(await carolStore.cancelInvitation(organization.id, first.id)).toMatchObject({
      outcome: "cancelled",
    });
    expect(await bobStore.listMyInvitations()).toEqual([]);
    // An address is written to at most once an hour, whatever became of the last invitation.
    await expect(
      carolStore.inviteMember(organization.id, "bob@example.com", "member"),
    ).rejects.toMatchObject({ kind: "limit", message: expect.stringContaining("an hour ago") });
    const backdate = () =>
      admin
        .from("invitations")
        .update({ sent_at: new Date(Date.now() - 2 * 3_600_000).toISOString() })
        .eq("organization_id", organization.id)
        .throwOnError();
    await backdate();
    const second = await carolStore.inviteMember(organization.id, "bob@example.com", "member");
    if (!second) throw new Error("not invited");
    expect(await carolStore.acceptInvitation(second.id)).toBeNull();
    expect(await bobStore.acceptInvitation(second.id)).toMatchObject({ outcome: "accepted" });
    expect(await bobStore.listMyRoles()).toEqual({ [organization.id]: "member" });
    expect((await bobStore.listMembers(organization.id))?.map((m) => [m.email, m.role])).toEqual([
      ["carol@example.com", "owner"],
      ["bob@example.com", "member"],
    ]);
    expect(await aliceStore.listMembers(organization.id)).toBeNull();

    // Roles change only by an owner, and never so that no owner is left.
    expect(await bobStore.changeMemberRole(organization.id, bob, "owner")).toBe(false);
    expect(await carolStore.changeMemberRole(organization.id, bob, "owner")).toBe(true);
    expect(await carolStore.changeMemberRole(organization.id, carol, "admin")).toBe(true);
    await expect(bobStore.leaveOrganization(organization.id)).rejects.toMatchObject({
      kind: "limit",
      message: expect.stringContaining("needs an owner"),
    });
    expect(await bobStore.changeMemberRole(organization.id, carol, "owner")).toBe(true);
    expect(await bobStore.leaveOrganization(organization.id)).toBe(true);

    // A declined invitation stays on the owner's list until it is sent again or removed.
    await backdate();
    const third = await carolStore.inviteMember(organization.id, "bob@example.com", "admin");
    if (!third) throw new Error("not invited");
    expect(await bobStore.declineInvitation(third.id)).toMatchObject({ outcome: "declined" });
    expect((await carolStore.listInvitations(organization.id)).map((i) => i.outcome)).toEqual([
      "declined",
    ]);

    // An owner removes someone; nobody else can.
    await backdate();
    const fourth = await carolStore.inviteMember(organization.id, "bob@example.com", "member");
    if (!fourth) throw new Error("not invited");
    await bobStore.acceptInvitation(fourth.id);
    expect(await bobStore.removeMember(organization.id, carol)).toBe(false);
    expect(await carolStore.removeMember(organization.id, bob)).toBe(true);
    expect(await bobStore.listMyRoles()).toEqual({});
  });

  it("reads a list that reaches across organizations a page at a time, and gets the same list", async () => {
    // Bob becomes the operator, so the lists only the operator reads have rows to page through.
    const admin = client(await token({ role: "service_role" }));
    await admin.from("platform_roles").insert({ user_id: bob, role: "operator" }).throwOnError();

    let requests = 0;
    const counting = async (jwt: Promise<string>, pageSize?: number) =>
      createSupabaseStore(
        createClient(url ?? "", await jwt, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: {
            fetch: (input, init) => {
              requests += 1;
              return fetch(String(input).replace("/rest/v1", ""), init);
            },
          },
        }),
        pageSize === undefined ? {} : { pageSize },
      );
    const asOperator = token({ role: "authenticated", sub: bob });
    const asWorker = token({ role: "service_role" });
    const whole = { operator: await counting(asOperator), worker: await counting(asWorker) };
    // One row to a page: every list of two rows or more takes more than one request.
    const paged = { operator: await counting(asOperator, 1), worker: await counting(asWorker, 1) };

    // Something to page through: two locations, each with two prompts and a scan.
    const [organization] = await whole.operator.listEveryOrganization();
    if (!organization) throw new Error("no organization to read");
    await admin
      .from("organizations")
      .update({ max_locations: 3, max_queries_per_location: 5 })
      .eq("id", organization.id)
      .throwOnError();
    const aliceStore = await storeFor(alice);
    for (const name of ["Paged One", "Paged Two"]) {
      const location = await aliceStore.createLocation(organization.id, {
        name,
        website: null,
        phone: null,
        address_line: null,
        city: "Raleigh",
        region: "NC",
        postal_code: null,
        country_code: "US",
        google_place_id: null,
        primary_category: null,
      });
      for (const text of ["best pizza", "late night pizza"]) {
        await aliceStore.createQuery(location.id, { kind: "ai_prompt", text });
      }
      await whole.worker.createScan(location.id, "scheduled", null);
    }

    const since = "2000-01-01T00:00:00.000Z";
    const [plan] = (await whole.operator.listPlans()).filter((each) => each.key === "standard");
    const reads: [
      string,
      "operator" | "worker",
      (store: typeof whole.operator) => Promise<unknown>,
    ][] = [
      ["organizations", "operator", (store) => store.listEveryOrganization()],
      ["locations", "operator", (store) => store.listEveryLocation()],
      ["active prompts", "operator", (store) => store.countActiveQueries()],
      ["scans", "operator", (store) => store.listScansSince(since)],
      ["usage by month", "operator", (store) => store.listUsageByMonth(since)],
      ["audits", "operator", (store) => store.listEveryAudit()],
      ["accounts", "operator", (store) => store.listAccounts()],
      ["memberships", "operator", (store) => store.listEveryMembership()],
      ["platform roles", "operator", (store) => store.listPlatformRoles()],
      ["subscriptions", "operator", (store) => store.listEverySubscription()],
      ["untold actions", "operator", (store) => store.listUntoldActions()],
      ["a plan's subscribers", "worker", (store) => store.listPlanSubscribers(plan?.key ?? "")],
      ["a plan's organizations", "worker", (store) => store.listPlanOrganizations("starter")],
      ["actions to tell of", "worker", (store) => store.listActionsToTell()],
      ["standing permissions to tell of", "worker", (store) => store.listPermissionsToTell()],
    ];
    for (const [what, who, read] of reads) {
      requests = 0;
      const all = await read(whole[who]);
      const one = requests;
      requests = 0;
      expect(await read(paged[who]), what).toEqual(all);
      // A list of several rows was really read in several requests.
      const rows = Array.isArray(all) ? all.length : Object.keys(all as object).length;
      if (Array.isArray(all) && rows > 1) expect(requests, what).toBeGreaterThan(one);
    }

    // The lists this test is here for have more than a page of rows in them at one to a page.
    expect((await whole.operator.listAccounts()).length).toBeGreaterThan(1);
    expect((await whole.operator.listEveryLocation()).length).toBeGreaterThan(1);
    expect((await whole.operator.listScansSince(since)).length).toBeGreaterThan(1);
    // Four prompts, a row each, counted two to a location whichever way they were read.
    expect(Object.values(await paged.operator.countActiveQueries())).toEqual([2, 2]);
    // Newest first, as before, whichever way the pages were read.
    const scans = await paged.operator.listScansSince(since);
    expect(scans.map((scan) => scan.created_at)).toEqual(
      scans.map((scan) => scan.created_at).sort((a, b) => b.localeCompare(a)),
    );
    const accounts = await paged.operator.listAccounts();
    expect(accounts.map((account) => account.created_at)).toEqual(
      accounts.map((account) => account.created_at).sort((a, b) => b.localeCompare(a)),
    );

    // The notices of an announcement are kept one to an organization, and read the same way.
    expect(await paged.worker.listPriceChangeNotices(crypto.randomUUID())).toEqual([]);
    expect(await paged.worker.listLimitChangeNotices(crypto.randomUUID())).toEqual([]);
  });
});
