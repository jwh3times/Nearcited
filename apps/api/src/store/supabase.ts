import {
  LocationSchema,
  OrganizationSchema,
  RecommendationSchema,
  ScanResultSchema,
  ScanSchema,
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
};

function fail(action: string, error: DbError): never {
  const kind = ERROR_KINDS[error.code ?? ""] ?? "unexpected";
  throw new StoreError(kind, `${action}: ${error.message}`, { cause: error });
}

const LOCATION_COLUMNS =
  "id, organization_id, name, website, phone, address_line, city, region, postal_code, country_code, google_place_id, primary_category, scan_frequency, last_scanned_at, created_at";
const SCAN_COLUMNS =
  "id, location_id, status, trigger, visibility_score, error, created_at, started_at, finished_at";

export function createSupabaseStore(db: SupabaseClient): Store {
  return {
    async listOrganizations() {
      const { data, error } = await db
        .from("organizations")
        .select("id, name, created_at")
        .order("created_at");
      if (error) fail("List organizations", error);
      return OrganizationSchema.array().parse(data);
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

    async deleteQuery(id) {
      const { data, error } = await db.from("tracked_queries").delete().eq("id", id).select("id");
      if (error) fail("Delete tracked query", error);
      return (data?.length ?? 0) > 0;
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
        .select(
          "id, scan_id, tracked_query_id, surface, mentioned, position, competitors, cited_urls, answer_excerpt, sampled_at",
        )
        .eq("scan_id", scanId);
      if (error) fail("List scan results", error);
      return ScanResultSchema.array().parse(data);
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

    async markScanRunning(id) {
      const { error } = await db
        .from("scans")
        .update({ status: "running", started_at: new Date().toISOString(), error: null })
        .eq("id", id);
      if (error) fail("Mark scan running", error);
    },

    async completeScan(id, outcome) {
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
