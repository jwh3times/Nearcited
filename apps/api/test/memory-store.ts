import type {
  AuditJob,
  AuditPart,
  Location,
  Organization,
  Recommendation,
  Scan,
  ScanResult,
  SiteCheck,
  TrackedQuery,
} from "@nearcited/shared";
import { type Store, StoreError } from "../src/store/types";

/**
 * An in-memory Store for tests. It mimics the one property of the real database the API relies
 * on: a store made for a user cannot see rows outside that user's organizations. The policies
 * themselves are tested against Postgres in packages/db.
 */

export interface MemoryDb {
  organizations: Organization[];
  memberships: { organization_id: string; user_id: string; role: "owner" | "member" }[];
  locations: Location[];
  queries: TrackedQuery[];
  scans: Scan[];
  results: ScanResult[];
  recommendations: Recommendation[];
  emails: Map<string, string>;
  /** IDs of scans a member asked for, which is what the manual-scan limit counts. */
  requestedBy: Set<string>;
  audits: MemoryAudit[];
  /** Accounts with the `test` platform role. Every organization one creates is a test one. */
  testAccounts: Set<string>;
  /** The on-page check each scan made, by scan ID. */
  siteChecks: Map<string, SiteCheck | null>;
}

export interface MemoryAudit extends AuditJob {
  token: string;
  parts: Record<string, AuditPart>;
  error: string | null;
  created_at: string;
  expires_at: string;
}

export function createMemoryDb(): MemoryDb {
  return {
    testAccounts: new Set(),
    organizations: [],
    memberships: [],
    locations: [],
    queries: [],
    scans: [],
    results: [],
    recommendations: [],
    emails: new Map(),
    requestedBy: new Set(),
    audits: [],
    siteChecks: new Map(),
  };
}

let clock = Date.parse("2026-10-01T00:00:00Z");
/** Strictly increasing, so "latest" is well defined even within one millisecond. */
const timestamp = () => new Date(clock++).toISOString();

/** Roomier than the database's defaults, so tests that are not about limits never meet one. */
export const DEFAULT_LIMITS = {
  max_locations: 10,
  max_queries_per_location: 20,
  max_manual_scans_per_day: 50,
  scan_every_days: 1,
  surfaces: null,
};

/** `userId: null` is the worker's view: no filtering. */
export function memoryStore(db: MemoryDb, userId: string | null): Store {
  const seesOrg = (organizationId: string) =>
    userId === null ||
    db.memberships.some((m) => m.organization_id === organizationId && m.user_id === userId);
  const visibleLocation = (id: string) =>
    db.locations.find((location) => location.id === id && seesOrg(location.organization_id));
  const seesLocation = (id: string) => visibleLocation(id) !== undefined;
  const limits = (organizationId: string) =>
    db.organizations.find((organization) => organization.id === organizationId) ?? DEFAULT_LIMITS;
  /** Mirrors the trigger: only active prompts count, so retiring one makes room. */
  const requireRoomForQuery = (locationId: string) => {
    const organizationId = db.locations.find((l) => l.id === locationId)?.organization_id ?? "";
    const allowed = limits(organizationId).max_queries_per_location;
    const used = db.queries.filter((q) => q.location_id === locationId && q.is_active).length;
    if (used >= allowed) {
      throw new StoreError("limit", `A location can have ${allowed} active prompts.`);
    }
  };
  /** Mirrors the partial unique index: one queued or running scan per location. */
  const inFlight = (locationId: string, exceptId?: string) =>
    db.scans.some(
      (scan) =>
        scan.location_id === locationId &&
        scan.id !== exceptId &&
        (scan.status === "queued" || scan.status === "running"),
    );
  const requireScan = (id: string) => {
    const scan = db.scans.find((candidate) => candidate.id === id);
    if (!scan) throw new StoreError("unexpected", `scan ${id} not found`);
    return scan;
  };

  return {
    async listOrganizations() {
      return db.organizations.filter((organization) => seesOrg(organization.id));
    },

    async getOrganization(id) {
      return db.organizations.find((o) => o.id === id && seesOrg(id)) ?? null;
    },

    async renameOrganization(id, name) {
      const organization = db.organizations.find((o) => o.id === id && seesOrg(id));
      return organization ? Object.assign(organization, { name }) : null;
    },

    async createOrganization(name) {
      if (userId === null) throw new StoreError("forbidden", "not authenticated");
      const organization: Organization = {
        id: crypto.randomUUID(),
        name,
        ...DEFAULT_LIMITS,
        is_test: db.testAccounts.has(userId),
        created_at: timestamp(),
      };
      db.organizations.push(organization);
      db.memberships.push({ organization_id: organization.id, user_id: userId, role: "owner" });
      return organization;
    },

    async listLocations(organizationId) {
      return db.locations.filter(
        (location) => location.organization_id === organizationId && seesOrg(organizationId),
      );
    },

    async createLocation(organizationId, input) {
      if (!seesOrg(organizationId)) throw new StoreError("forbidden", "row-level security");
      const allowed = limits(organizationId).max_locations;
      const used = db.locations.filter((l) => l.organization_id === organizationId).length;
      if (used >= allowed) {
        throw new StoreError("limit", `This organization can have ${allowed} locations.`);
      }
      const location: Location = {
        ...input,
        id: crypto.randomUUID(),
        organization_id: organizationId,
        last_scanned_at: null,
        created_at: timestamp(),
      };
      db.locations.push(location);
      return location;
    },

    async getLocation(id) {
      return visibleLocation(id) ?? null;
    },

    async updateLocation(id, input) {
      const location = visibleLocation(id);
      if (!location) return null;
      return Object.assign(location, input);
    },

    async deleteLocation(id) {
      if (!seesLocation(id)) return false;
      db.locations = db.locations.filter((location) => location.id !== id);
      return true;
    },

    async listQueries(locationId) {
      return seesLocation(locationId)
        ? db.queries.filter((query) => query.location_id === locationId)
        : [];
    },

    async createQuery(locationId, input) {
      if (!seesLocation(locationId)) throw new StoreError("forbidden", "row-level security");
      const duplicate = db.queries.some(
        (query) =>
          query.location_id === locationId &&
          query.kind === input.kind &&
          query.text === input.text,
      );
      if (duplicate) throw new StoreError("conflict", "duplicate tracked query");
      requireRoomForQuery(locationId);
      const query: TrackedQuery = {
        ...input,
        id: crypto.randomUUID(),
        location_id: locationId,
        is_active: true,
        created_at: timestamp(),
      };
      db.queries.push(query);
      return query;
    },

    async setQueryActive(id, active) {
      const query = db.queries.find((candidate) => candidate.id === id);
      if (!query || !seesLocation(query.location_id)) return null;
      if (active && !query.is_active) requireRoomForQuery(query.location_id);
      query.is_active = active;
      return query;
    },

    async createScan(locationId, trigger, requestedBy) {
      if (!seesLocation(locationId)) throw new StoreError("forbidden", "row-level security");
      if (inFlight(locationId)) throw new StoreError("conflict", "scans_one_in_flight_idx");
      if (trigger === "manual" && requestedBy !== null) {
        const organizationId = db.locations.find((l) => l.id === locationId)?.organization_id ?? "";
        const allowed = limits(organizationId).max_manual_scans_per_day;
        const used = db.scans.filter(
          (scan) =>
            scan.trigger === "manual" &&
            db.requestedBy.has(scan.id) &&
            db.locations.find((l) => l.id === scan.location_id)?.organization_id === organizationId,
        ).length;
        if (used >= allowed) {
          throw new StoreError("limit", `This organization can start ${allowed} manual scans.`);
        }
      }
      const scan: Scan = {
        id: crypto.randomUUID(),
        location_id: locationId,
        status: "queued",
        trigger,
        visibility_score: null,
        error: null,
        sample_data: false,
        created_at: timestamp(),
        started_at: null,
        finished_at: null,
      };
      db.scans.push(scan);
      if (requestedBy !== null) db.requestedBy.add(scan.id);
      return scan;
    },

    async listScans(locationId, limit) {
      if (!seesLocation(locationId)) return [];
      return db.scans
        .filter((scan) => scan.location_id === locationId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit);
    },

    async getScan(id) {
      const scan = db.scans.find((candidate) => candidate.id === id);
      return scan && seesLocation(scan.location_id) ? scan : null;
    },

    async listScanResults(scanId) {
      const scan = db.scans.find((candidate) => candidate.id === scanId);
      if (!scan || !seesLocation(scan.location_id)) return [];
      return db.results.filter((result) => result.scan_id === scanId);
    },

    async listRecentResults(locationId, scans, sampleData) {
      if (!seesLocation(locationId)) return [];
      // Newest first by insertion, since scans made in the same millisecond share a timestamp.
      return db.scans
        .filter(
          (scan) =>
            scan.location_id === locationId &&
            scan.status === "succeeded" &&
            scan.sample_data === sampleData,
        )
        .reverse()
        .slice(0, Math.max(0, scans))
        .map((scan) => db.results.filter((result) => result.scan_id === scan.id));
    },

    async listRecommendations(locationId) {
      return seesLocation(locationId)
        ? db.recommendations.filter((recommendation) => recommendation.location_id === locationId)
        : [];
    },

    async setRecommendationStatus(id, status) {
      const recommendation = db.recommendations.find((candidate) => candidate.id === id);
      if (!recommendation || !seesLocation(recommendation.location_id)) return null;
      recommendation.status = status;
      return recommendation;
    },

    async getAuditByToken(token) {
      // Like the database function, this answers anyone who holds the token.
      const audit = db.audits.find((candidate) => candidate.token === token);
      if (!audit || audit.revoked_at !== null || audit.expires_at <= new Date().toISOString()) {
        return null;
      }
      const { business_name, website, city, region, prompts, samples, status } = audit;
      return {
        business_name,
        website,
        city,
        region,
        prompts,
        samples,
        status,
        parts: audit.parts,
        created_at: audit.created_at,
        expires_at: audit.expires_at,
      };
    },

    async getAudit(id) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      return db.audits.find((candidate) => candidate.id === id) ?? null;
    },

    async recordAuditPart(id, promptIndex, part) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const audit = db.audits.find((candidate) => candidate.id === id);
      if (!audit) throw new StoreError("unexpected", `audit ${id} not found`);
      audit.parts[String(promptIndex)] = part;
      audit.status = Object.keys(audit.parts).length >= audit.prompts.length ? "ready" : "queued";
      audit.error = null;
    },

    async failAudit(id, error) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const audit = db.audits.find((candidate) => candidate.id === id);
      if (audit) Object.assign(audit, { status: "failed", error });
    },

    async failStaleAudits(olderThan, error) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const stale = db.audits.filter(
        (audit) => audit.status === "queued" && audit.created_at < olderThan,
      );
      for (const audit of stale) Object.assign(audit, { status: "failed", error });
      return stale.length;
    },

    async markScanRunning(id, sampleData) {
      const scan = requireScan(id);
      if (inFlight(scan.location_id, id))
        throw new StoreError("conflict", "scans_one_in_flight_idx");
      Object.assign(scan, {
        status: "running",
        started_at: timestamp(),
        error: null,
        sample_data: sampleData,
      });
    },

    async getSiteCheck(locationId) {
      if (!seesLocation(locationId)) return null;
      const latest = db.scans
        .filter((scan) => scan.location_id === locationId && scan.status === "succeeded")
        .sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""))[0];
      return (latest && db.siteChecks.get(latest.id)) ?? null;
    },

    async completeScan(id, outcome) {
      const scan = requireScan(id);
      db.siteChecks.set(id, outcome.site ?? null);
      Object.assign(scan, {
        status: "succeeded",
        visibility_score: outcome.score,
        error: null,
        finished_at: timestamp(),
      });
      db.results = db.results
        .filter((result) => result.scan_id !== id)
        .concat(
          outcome.results.map((result) => ({
            ...result,
            id: crypto.randomUUID(),
            scan_id: id,
            sampled_at: timestamp(),
          })),
        );
      const location = db.locations.find((candidate) => candidate.id === scan.location_id);
      if (location) location.last_scanned_at = timestamp();
      db.recommendations = db.recommendations
        .filter((recommendation) => recommendation.location_id !== scan.location_id)
        .concat(
          outcome.recommendations.map((recommendation) => ({
            ...recommendation,
            id: crypto.randomUUID(),
            location_id: scan.location_id,
            scan_id: id,
            status: "open" as const,
            created_at: timestamp(),
          })),
        );
    },

    async failScan(id, error) {
      Object.assign(requireScan(id), { status: "failed", error, finished_at: timestamp() });
    },

    async failStaleScans(olderThan, error) {
      const stale = db.scans.filter(
        (scan) =>
          (scan.status === "queued" && scan.created_at < olderThan) ||
          (scan.status === "running" && (scan.started_at ?? scan.created_at) < olderThan),
      );
      for (const scan of stale) {
        Object.assign(scan, { status: "failed", error, finished_at: timestamp() });
      }
      return stale.length;
    },

    async listLocationsDueForScan(limit) {
      return db.locations
        .filter(
          (location) =>
            location.scan_frequency !== "off" &&
            location.last_scanned_at === null &&
            db.queries.some((query) => query.location_id === location.id && query.is_active),
        )
        .slice(0, limit)
        .map((location) => location.id);
    },

    async listOwnerEmails(organizationId) {
      return db.memberships
        .filter((m) => m.organization_id === organizationId && m.role === "owner")
        .flatMap((m) => db.emails.get(m.user_id) ?? []);
    },
  };
}
