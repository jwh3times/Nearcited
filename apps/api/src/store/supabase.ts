import {
  AuditJobSchema,
  LocationSchema,
  OrganizationSchema,
  RecommendationSchema,
  ScanResultSchema,
  ScanSchema,
  SiteCheckSchema,
  StoredAuditSchema,
  TrackedQuerySchema,
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
  NC003: "limit", // manual scans per day
};

function fail(action: string, error: DbError): never {
  const kind = ERROR_KINDS[error.code ?? ""] ?? "unexpected";
  // A limit's message goes to the user as it is. Anything else is for the logs.
  const message = kind === "limit" ? error.message : `${action}: ${error.message}`;
  throw new StoreError(kind, message, { cause: error });
}

const ORGANIZATION_COLUMNS =
  "id, name, max_locations, max_queries_per_location, max_manual_scans_per_day, scan_every_days, surfaces, created_at";

const LOCATION_COLUMNS =
  "id, organization_id, name, website, phone, address_line, city, region, postal_code, country_code, google_place_id, primary_category, scan_frequency, last_scanned_at, created_at";
const SCAN_COLUMNS =
  "id, location_id, status, trigger, visibility_score, error, sample_data, created_at, started_at, finished_at";

const RESULT_COLUMNS =
  "id, scan_id, tracked_query_id, surface, mentioned, position, competitors, cited_urls, answer_excerpt, sampled_at";

export function createSupabaseStore(db: SupabaseClient): Store {
  return {
    async listOrganizations() {
      const { data, error } = await db
        .from("organizations")
        .select(ORGANIZATION_COLUMNS)
        .order("created_at");
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

    async deleteLocation(id) {
      const { data, error } = await db.from("locations").delete().eq("id", id).select("id");
      if (error) fail("Delete location", error);
      return (data?.length ?? 0) > 0;
    },

    async listQueries(locationId) {
      const { data, error } = await db
        .from("tracked_queries")
        .select("id, location_id, kind, text, is_active, created_at")
        .eq("location_id", locationId)
        .order("created_at");
      if (error) fail("List tracked queries", error);
      return TrackedQuerySchema.array().parse(data);
    },

    async createQuery(locationId, input) {
      const { data, error } = await db
        .from("tracked_queries")
        .insert({ ...input, location_id: locationId })
        .select("id, location_id, kind, text, is_active, created_at")
        .single();
      if (error) fail("Create tracked query", error);
      return TrackedQuerySchema.parse(data);
    },

    async setQueryActive(id, active) {
      const { data, error } = await db
        .from("tracked_queries")
        .update({ is_active: active })
        .eq("id", id)
        .select("id, location_id, kind, text, is_active, created_at")
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
