import {
  AuditJobSchema,
  LocationSchema,
  OperatorAuditSchema,
  OrganizationSchema,
  PlanSchema,
  type PlatformRole,
  PlatformRoleSchema,
  RecommendationSchema,
  ScanResultSchema,
  ScanSchema,
  SiteCheckSchema,
  StoredAuditSchema,
  TrackedQuerySchema,
  UsageByMonthSchema,
} from "@nearcited/shared";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Env } from "../env";
import { type Store, StoreError, type StoreErrorKind } from "./types";

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

/** A client that acts as the signed-in user: every query runs under their row-level security. */
export function createUserClient(env: Env, accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    ...clientOptions,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * A client for a caller who is not signed in. It can reach only what the database grants the
 * anonymous role, which is the one function that looks an audit up by its token.
 */
export function createAnonClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, clientOptions);
}

/** A client that bypasses row-level security. Never construct this on a request path. */
export function createAdminClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, clientOptions);
}

interface DbError {
  code?: string;
  message: string;
}

const ERROR_KINDS: Record<string, StoreErrorKind> = {
  "23505": "conflict", // unique_violation
  "42501": "forbidden", // insufficient_privilege, including a row-level security rejection
  // Raised by the usage-cap triggers, each with a message written for the user.
  NC001: "limit", // locations per organization
  NC002: "limit", // active prompts per location
  NC003: "limit", // manual scans per month
  NC004: "limit", // a choice of assistants the plan does not allow
  NC005: "limit", // a location paused by the plan, or no room to bring one back
  NC006: "limit", // a second organization for one account
  NC007: "limit", // taking the free plan off sale
  NC008: "limit", // a price for the free plan
};

function fail(action: string, error: DbError): never {
  const kind = ERROR_KINDS[error.code ?? ""] ?? "unexpected";
  // A limit's message goes to the user as it is. Anything else is for the logs.
  const message = kind === "limit" ? error.message : `${action}: ${error.message}`;
  throw new StoreError(kind, message, { cause: error });
}

/** The rows the operator's overview reads, as the database returns them. */
const OperatorScanSchema = ScanSchema.pick({
  id: true,
  location_id: true,
  status: true,
  trigger: true,
  error: true,
  sample_data: true,
  created_at: true,
}).extend({ site_check: SiteCheckSchema.nullable() });

const ListedAuditSchema = OperatorAuditSchema.omit({ link: true }).extend({ token: z.string() });

const AccountRowSchema = z.object({
  user_id: z.uuid(),
  email: z.string().nullable(),
  created_at: z.string(),
  last_sign_in_at: z.string().nullable(),
});

const PLAN_COLUMNS =
  "key, name, position, on_sale, price_cents, included_locations, extra_location_price_cents, max_queries_per_location, assistants, scan_every_days, max_manual_scans_per_month, emails_report, stronger_models";

const PLAN_PRICE_COLUMNS =
  "key, on_sale, included_locations, price_cents, extra_location_price_cents, stripe_price_id, stripe_extra_location_price_id";
const PlanPriceRowSchema = z.object({
  key: z.string(),
  on_sale: z.boolean(),
  included_locations: z.number().int().positive(),
  price_cents: z.number().int().nonnegative(),
  extra_location_price_cents: z.number().int().positive().nullable(),
  stripe_price_id: z.string().nullable(),
  stripe_extra_location_price_id: z.string().nullable(),
});

const PRICE_VERSION_COLUMNS =
  "plan_key, price_cents, extra_location_price_cents, stripe_price_id, stripe_extra_location_price_id";
const PriceVersionRowSchema = z.object({
  plan_key: z.string(),
  price_cents: z.number().int().positive(),
  extra_location_price_cents: z.number().int().positive().nullable(),
  stripe_price_id: z.string(),
  stripe_extra_location_price_id: z.string().nullable(),
});

const ManualScansSchema = z.object({
  manual_scans_month: z.string().nullable(),
  manual_scans_used: z.number().int().nonnegative(),
});

const SUBSCRIPTION_COLUMNS = "stripe_customer_id, stripe_subscription_id, status";
const SubscriptionRecordSchema = z.object({
  stripe_customer_id: z.string(),
  stripe_subscription_id: z.string().nullable(),
  status: z.string().nullable(),
});
const BillingStateSchema = z.object({
  organization_id: z.uuid(),
  is_test: z.boolean(),
  plan_key: z.string().nullable(),
  stripe_customer_id: z.string().nullable(),
  stripe_subscription_id: z.string().nullable(),
  status: z.string().nullable(),
});

const LISTED_AUDIT_COLUMNS =
  "id, token, business_name, city, region, status, error, created_at, expires_at, revoked_at";

const ORGANIZATION_COLUMNS =
  "id, name, max_locations, max_queries_per_location, max_manual_scans_per_month, scan_every_days, surfaces, is_test, emails_report, plan_key, created_at";

const LOCATION_COLUMNS =
  "id, organization_id, name, website, phone, address_line, city, region, postal_code, country_code, google_place_id, primary_category, scan_frequency, paused_by_plan, last_scanned_at, created_at";
const SCAN_COLUMNS =
  "id, location_id, status, trigger, visibility_score, error, sample_data, created_at, started_at, finished_at";

const RESULT_COLUMNS =
  "id, scan_id, tracked_query_id, surface, mentioned, position, competitors, cited_urls, answer_excerpt, sampled_at";

export function createSupabaseStore(db: SupabaseClient): Store {
  return {
    async listOrganizations() {
      // By membership, not by what the caller can read: the operator can read every organization
      // and still belongs only to their own.
      const { data, error } = await db.rpc("my_organizations");
      if (error) fail("List organizations", error);
      return OrganizationSchema.array().parse(data);
    },

    async getOrganization(id) {
      const { data, error } = await db
        .from("organizations")
        .select(ORGANIZATION_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) fail("Get organization", error);
      return data ? OrganizationSchema.parse(data) : null;
    },

    async createOrganization(name) {
      const { data, error } = await db.rpc("create_organization", { org_name: name });
      if (error) fail("Create organization", error);
      return OrganizationSchema.parse(data);
    },

    async listPlans() {
      // Named columns: no page needs the payment provider's price IDs.
      const { data, error } = await db.from("plans").select(PLAN_COLUMNS).order("position");
      if (error) fail("List plans", error);
      return PlanSchema.array().parse(data);
    },

    async getManualScansUsed(organizationId) {
      const { data, error } = await db
        .from("organizations")
        .select("manual_scans_month, manual_scans_used")
        .eq("id", organizationId)
        .maybeSingle();
      if (error) fail("Get manual scans used", error);
      if (!data) return null;
      const counted = ManualScansSchema.parse(data);
      // The count is for the month it names. In any other month nothing has been used yet.
      const thisMonth = `${new Date().toISOString().slice(0, 7)}-01`;
      return counted.manual_scans_month === thisMonth ? counted.manual_scans_used : 0;
    },

    async listPlanPrices() {
      const [plans, versions] = await Promise.all([
        db.from("plans").select(PLAN_PRICE_COLUMNS).order("position"),
        db.from("plan_prices").select(PRICE_VERSION_COLUMNS).order("created_at", {
          ascending: false,
        }),
      ]);
      if (plans.error) fail("List plan prices", plans.error);
      if (versions.error) fail("List the prices plans have been sold at", versions.error);
      const sold = PriceVersionRowSchema.array().parse(versions.data);
      return PlanPriceRowSchema.array()
        .parse(plans.data)
        .map((plan) => {
          const own = sold
            .filter((version) => version.plan_key === plan.key)
            .map(({ plan_key: _, ...version }) => version);
          return {
            key: plan.key,
            on_sale: plan.on_sale,
            included_locations: plan.included_locations,
            current:
              own.find((version) => version.stripe_price_id === plan.stripe_price_id) ?? null,
            versions: own,
          };
        });
    },

    async getBillingState(organizationId) {
      const { data, error } = await db.rpc("billing_state", { org: organizationId }).maybeSingle();
      if (error) fail("Get billing state", error);
      return data ? BillingStateSchema.parse(data) : null;
    },

    async getSubscription(organizationId) {
      const { data, error } = await db
        .from("subscriptions")
        .select(SUBSCRIPTION_COLUMNS)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (error) fail("Get subscription", error);
      return data ? SubscriptionRecordSchema.parse(data) : null;
    },

    async recordSubscription(organizationId, subscription) {
      const { error } = await db.from("subscriptions").upsert({
        organization_id: organizationId,
        ...subscription,
        updated_at: new Date().toISOString(),
      });
      if (error) fail("Record subscription", error);
    },

    async chooseAssistants(id, surfaces) {
      const { data, error } = await db
        .rpc("choose_assistants", { org: id, chosen: [...surfaces] })
        .select(ORGANIZATION_COLUMNS)
        .maybeSingle();
      if (error) fail("Choose assistants", error);
      return data ? OrganizationSchema.parse(data) : null;
    },

    async applyPlan(organizationId, planKey, locations) {
      const { data, error } = await db
        .rpc("apply_plan", { org: organizationId, plan: planKey, locations: locations ?? null })
        .select(ORGANIZATION_COLUMNS)
        .maybeSingle();
      if (error) fail("Apply plan", error);
      // The function returns one organization, so "none" arrives as a row of nulls.
      return data?.id ? OrganizationSchema.parse(data) : null;
    },

    async renameOrganization(id, name) {
      const { data, error } = await db
        .from("organizations")
        .update({ name })
        .eq("id", id)
        .select(ORGANIZATION_COLUMNS)
        .maybeSingle();
      if (error) fail("Rename organization", error);
      return data ? OrganizationSchema.parse(data) : null;
    },

    async setOrganizationLimits(id, limits) {
      const { data, error } = await db
        .rpc("operator_set_limits", {
          org: id,
          locations: limits.max_locations,
          queries_per_location: limits.max_queries_per_location,
          manual_scans_per_month: limits.max_manual_scans_per_month,
          every_days: limits.scan_every_days,
        })
        .select(ORGANIZATION_COLUMNS)
        .maybeSingle();
      if (error) fail("Set organization limits", error);
      return data ? OrganizationSchema.parse(data) : null;
    },

    async listEverySubscription() {
      const { data, error } = await db
        .from("subscriptions")
        .select("organization_id, stripe_subscription_id");
      if (error) fail("List subscriptions", error);
      return z
        .array(
          z.object({ organization_id: z.uuid(), stripe_subscription_id: z.string().nullable() }),
        )
        .parse(data ?? [])
        .map((row) => ({
          organization_id: row.organization_id,
          subscribed: row.stripe_subscription_id !== null,
        }));
    },

    async setPlan(key, settings) {
      const { data, error } = await db
        .rpc("operator_set_plan", {
          plan: key,
          new_name: settings.name,
          sale: settings.on_sale,
          queries_per_location: settings.max_queries_per_location,
          plan_assistants: settings.assistants,
          every_days: settings.scan_every_days,
          manual_scans_per_month: settings.max_manual_scans_per_month,
          report: settings.emails_report,
        })
        .select(PLAN_COLUMNS)
        .maybeSingle();
      if (error) fail("Set plan", error);
      return data ? PlanSchema.parse(data) : null;
    },

    async setPlanPrices(key, version) {
      const { data, error } = await db
        .rpc("operator_set_plan_prices", {
          plan: key,
          price: version.price_cents,
          extra_location_price: version.extra_location_price_cents,
          stripe_price: version.stripe_price_id,
          stripe_extra_location_price: version.stripe_extra_location_price_id,
        })
        .select(PLAN_COLUMNS)
        .maybeSingle();
      if (error) fail("Set plan prices", error);
      return data ? PlanSchema.parse(data) : null;
    },

    async getPlatformRole(userId) {
      // By the account's ID, not by what is readable: the operator can read everyone's role.
      const { data, error } = await db
        .from("platform_roles")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) fail("Get platform role", error);
      return data ? PlatformRoleSchema.parse(data.role) : null;
    },

    async listEveryOrganization() {
      const { data, error } = await db
        .from("organizations")
        .select(ORGANIZATION_COLUMNS)
        .order("created_at");
      if (error) fail("List every organization", error);
      return OrganizationSchema.array().parse(data);
    },

    async listEveryLocation() {
      const { data, error } = await db.from("locations").select(LOCATION_COLUMNS).order("name");
      if (error) fail("List every location", error);
      return LocationSchema.array().parse(data);
    },

    async countActiveQueries() {
      const { data, error } = await db
        .from("tracked_queries")
        .select("location_id")
        .eq("is_active", true);
      if (error) fail("Count active queries", error);
      const counts: Record<string, number> = {};
      for (const row of data ?? []) {
        const id = String(row.location_id);
        counts[id] = (counts[id] ?? 0) + 1;
      }
      return counts;
    },

    async listScansSince(since) {
      const { data, error } = await db
        .from("scans")
        .select("id, location_id, status, trigger, error, sample_data, created_at, site_check")
        .gte("created_at", since)
        .order("created_at", { ascending: false });
      if (error) fail("List recent scans", error);
      return OperatorScanSchema.array().parse(data);
    },

    async listUsageByMonth(since) {
      const { data, error } = await db.rpc("usage_by_month", { since });
      if (error) fail("List usage by month", error);
      return UsageByMonthSchema.array().parse(data);
    },

    async listEveryAudit() {
      const { data, error } = await db
        .from("audits")
        .select(LISTED_AUDIT_COLUMNS)
        .order("created_at", { ascending: false });
      if (error) fail("List every audit", error);
      return ListedAuditSchema.array().parse(data);
    },

    async createAudit(input) {
      const { data, error } = await db
        .rpc("operator_create_audit", {
          p_business_name: input.business_name,
          p_website: input.website,
          p_city: input.city,
          p_region: input.region,
          p_country_code: input.country_code,
          p_prompts: input.prompts,
          p_samples: input.samples,
        })
        .select(LISTED_AUDIT_COLUMNS)
        .maybeSingle();
      if (error) fail("Create audit", error);
      return data ? ListedAuditSchema.parse(data) : null;
    },

    async listAccounts() {
      const { data, error } = await db.rpc("operator_accounts");
      if (error) fail("List accounts", error);
      return AccountRowSchema.array().parse(data);
    },

    async listEveryMembership() {
      const { data, error } = await db
        .from("memberships")
        .select("user_id, organization_id")
        .order("created_at");
      if (error) fail("List every membership", error);
      return z.array(z.object({ user_id: z.uuid(), organization_id: z.uuid() })).parse(data);
    },

    async listPlatformRoles() {
      const { data, error } = await db.from("platform_roles").select("user_id, role");
      if (error) fail("List platform roles", error);
      const roles: Record<string, PlatformRole> = {};
      for (const row of data ?? []) roles[String(row.user_id)] = PlatformRoleSchema.parse(row.role);
      return roles;
    },

    async listLocations(organizationId) {
      const { data, error } = await db
        .from("locations")
        .select(LOCATION_COLUMNS)
        .eq("organization_id", organizationId)
        .order("name");
      if (error) fail("List locations", error);
      return LocationSchema.array().parse(data);
    },

    async createLocation(organizationId, input) {
      const { data, error } = await db
        .from("locations")
        .insert({ ...input, organization_id: organizationId })
        .select(LOCATION_COLUMNS)
        .single();
      if (error) fail("Create location", error);
      return LocationSchema.parse(data);
    },

    async getLocation(id) {
      const { data, error } = await db
        .from("locations")
        .select(LOCATION_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) fail("Get location", error);
      return data ? LocationSchema.parse(data) : null;
    },

    async activateLocation(id, insteadOf) {
      const { data, error } = await db
        .rpc("activate_location", { location: id, instead_of: insteadOf ?? null })
        .select(LOCATION_COLUMNS)
        .maybeSingle();
      if (error) fail("Activate location", error);
      return data ? LocationSchema.parse(data) : null;
    },

    async updateLocation(id, input) {
      const { data, error } = await db
        .from("locations")
        .update(input)
        .eq("id", id)
        .select(LOCATION_COLUMNS)
        .maybeSingle();
      if (error) fail("Update location", error);
      return data ? LocationSchema.parse(data) : null;
    },

    async deleteLocation(id) {
      const { data, error } = await db.from("locations").delete().eq("id", id).select("id");
      if (error) fail("Delete location", error);
      return (data?.length ?? 0) > 0;
    },

    async listQueries(locationId) {
      const { data, error } = await db
        .from("tracked_queries")
        .select("id, location_id, kind, text, is_active, set_aside_by_plan, created_at")
        .eq("location_id", locationId)
        .order("created_at");
      if (error) fail("List tracked queries", error);
      return TrackedQuerySchema.array().parse(data);
    },

    async createQuery(locationId, input) {
      const { data, error } = await db
        .from("tracked_queries")
        .insert({ ...input, location_id: locationId })
        .select("id, location_id, kind, text, is_active, set_aside_by_plan, created_at")
        .single();
      if (error) fail("Create tracked query", error);
      return TrackedQuerySchema.parse(data);
    },

    async setQueryActive(id, active) {
      const { data, error } = await db
        .from("tracked_queries")
        .update({ is_active: active })
        .eq("id", id)
        .select("id, location_id, kind, text, is_active, set_aside_by_plan, created_at")
        .maybeSingle();
      if (error) fail("Update tracked query", error);
      return data ? TrackedQuerySchema.parse(data) : null;
    },

    async createScan(locationId, trigger, requestedBy) {
      const { data, error } = await db
        .from("scans")
        .insert({ location_id: locationId, trigger, requested_by: requestedBy })
        .select(SCAN_COLUMNS)
        .single();
      if (error) fail("Create scan", error);
      return ScanSchema.parse(data);
    },

    async listScans(locationId, limit) {
      const { data, error } = await db
        .from("scans")
        .select(SCAN_COLUMNS)
        .eq("location_id", locationId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) fail("List scans", error);
      return ScanSchema.array().parse(data);
    },

    async getScan(id) {
      const { data, error } = await db
        .from("scans")
        .select(SCAN_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) fail("Get scan", error);
      return data ? ScanSchema.parse(data) : null;
    },

    async listScanResults(scanId) {
      const { data, error } = await db
        .from("scan_results")
        .select(RESULT_COLUMNS)
        .eq("scan_id", scanId);
      if (error) fail("List scan results", error);
      return ScanResultSchema.array().parse(data);
    },

    async listRecentResults(locationId, scans, sampleData) {
      if (scans <= 0) return [];
      const recent = await db
        .from("scans")
        .select("id")
        .eq("location_id", locationId)
        .eq("status", "succeeded")
        .eq("sample_data", sampleData)
        .order("created_at", { ascending: false })
        .limit(scans);
      if (recent.error) fail("List recent scans", recent.error);
      const ids = (recent.data ?? []).map((scan) => String(scan.id));
      if (ids.length === 0) return [];

      const { data, error } = await db
        .from("scan_results")
        .select(RESULT_COLUMNS)
        .in("scan_id", ids);
      if (error) fail("List recent results", error);
      const results = ScanResultSchema.array().parse(data);
      return ids.map((id) => results.filter((result) => result.scan_id === id));
    },

    async listRecommendations(locationId) {
      const { data, error } = await db
        .from("recommendations")
        .select("id, location_id, scan_id, rule, title, detail, status, created_at")
        .eq("location_id", locationId)
        .order("created_at");
      if (error) fail("List recommendations", error);
      return RecommendationSchema.array().parse(data);
    },

    async setRecommendationStatus(id, status) {
      const { data, error } = await db
        .from("recommendations")
        .update({ status })
        .eq("id", id)
        .select("id, location_id, scan_id, rule, title, detail, status, created_at")
        .maybeSingle();
      if (error) fail("Update recommendation", error);
      return data ? RecommendationSchema.parse(data) : null;
    },

    async getAuditByToken(token) {
      const { data, error } = await db.rpc("get_audit", { p_token: token });
      if (error) fail("Get audit by token", error);
      return data ? StoredAuditSchema.parse(data) : null;
    },

    async getAudit(id) {
      const { data, error } = await db
        .from("audits")
        .select(
          "id, business_name, website, city, region, country_code, prompts, samples, status, revoked_at",
        )
        .eq("id", id)
        .maybeSingle();
      if (error) fail("Get audit", error);
      return data ? AuditJobSchema.parse(data) : null;
    },

    async recordAuditPart(id, promptIndex, part) {
      const { error } = await db.rpc("record_audit_part", {
        p_audit_id: id,
        p_index: promptIndex,
        p_part: part,
      });
      if (error) fail("Record audit part", error);
    },

    async failAudit(id, message) {
      const { error } = await db
        .from("audits")
        .update({ status: "failed", error: message.slice(0, 500) })
        .eq("id", id);
      if (error) fail("Fail audit", error);
    },

    async failStaleAudits(olderThan, message) {
      const { data, error } = await db
        .from("audits")
        .update({ status: "failed", error: message.slice(0, 500) })
        .eq("status", "queued")
        .lt("created_at", olderThan)
        .select("id");
      if (error) fail("Fail stale audits", error);
      return data?.length ?? 0;
    },

    async recordUsage(source, usage) {
      if (usage.length === 0) return;
      const { error } = await db
        .from("provider_usage")
        .insert(usage.map((row) => ({ ...source, ...row })));
      if (error) fail("Record usage", error);
    },

    async markScanRunning(id, sampleData) {
      const { error } = await db
        .from("scans")
        .update({
          status: "running",
          started_at: new Date().toISOString(),
          error: null,
          sample_data: sampleData,
        })
        .eq("id", id);
      if (error) fail("Mark scan running", error);
    },

    async getSiteCheck(locationId) {
      const { data, error } = await db
        .from("scans")
        .select("site_check")
        .eq("location_id", locationId)
        .eq("status", "succeeded")
        .order("finished_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail("Get site check", error);
      return data?.site_check ? SiteCheckSchema.parse(data.site_check) : null;
    },

    async completeScan(id, outcome) {
      // Written first: if completing then fails, the scan is retried and this is written again.
      const saved = await db
        .from("scans")
        .update({ site_check: outcome.site ?? null })
        .eq("id", id);
      if (saved.error) fail("Save site check", saved.error);

      const { error } = await db.rpc("complete_scan", {
        p_scan_id: id,
        p_score: outcome.score,
        p_results: outcome.results,
        p_recommendations: outcome.recommendations,
      });
      if (error) fail("Complete scan", error);
    },

    async failScan(id, message) {
      const { error } = await db
        .from("scans")
        .update({
          status: "failed",
          error: message.slice(0, 500),
          finished_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) fail("Fail scan", error);
    },

    async failStaleScans(olderThan, message) {
      const abandoned = {
        status: "failed",
        error: message.slice(0, 500),
        finished_at: new Date().toISOString(),
      };
      // A queued scan is timed from when it was requested, a running one from when it started.
      const queued = await db
        .from("scans")
        .update(abandoned)
        .eq("status", "queued")
        .lt("created_at", olderThan)
        .select("id");
      if (queued.error) fail("Fail stale queued scans", queued.error);
      const running = await db
        .from("scans")
        .update(abandoned)
        .eq("status", "running")
        .lt("started_at", olderThan)
        .select("id");
      if (running.error) fail("Fail stale running scans", running.error);
      return (queued.data?.length ?? 0) + (running.data?.length ?? 0);
    },

    async listLocationsDueForScan(limit) {
      const { data, error } = await db.rpc("locations_due_for_scan", { max_rows: limit });
      if (error) fail("List locations due for scan", error);
      return z.array(z.uuid()).parse(data ?? []);
    },

    async listOwnerEmails(organizationId) {
      const { data, error } = await db
        .from("memberships")
        .select("user_id")
        .eq("organization_id", organizationId)
        .eq("role", "owner");
      if (error) fail("List owners", error);

      const emails: string[] = [];
      for (const { user_id } of z.array(z.object({ user_id: z.uuid() })).parse(data ?? [])) {
        const { data: found, error: userError } = await db.auth.admin.getUserById(user_id);
        if (userError) fail("Look up owner", userError);
        if (found.user?.email) emails.push(found.user.email);
      }
      return emails;
    },
  };
}
