import type {
  Location,
  Organization,
  Recommendation,
  Scan,
  ScanResult,
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
}

export function createMemoryDb(): MemoryDb {
  return {
    organizations: [],
    memberships: [],
    locations: [],
    queries: [],
    scans: [],
    results: [],
    recommendations: [],
    emails: new Map(),
  };
}

let clock = Date.parse("2026-10-01T00:00:00Z");
/** Strictly increasing, so "latest" is well defined even within one millisecond. */
const timestamp = () => new Date(clock++).toISOString();

/** `userId: null` is the worker's view: no filtering. */
export function memoryStore(db: MemoryDb, userId: string | null): Store {
  const seesOrg = (organizationId: string) =>
    userId === null ||
    db.memberships.some((m) => m.organization_id === organizationId && m.user_id === userId);
  const visibleLocation = (id: string) =>
    db.locations.find((location) => location.id === id && seesOrg(location.organization_id));
  const seesLocation = (id: string) => visibleLocation(id) !== undefined;
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

    async createOrganization(name) {
      if (userId === null) throw new StoreError("forbidden", "not authenticated");
      const organization = { id: crypto.randomUUID(), name, created_at: timestamp() };
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
      query.is_active = active;
      return query;
    },

    async createScan(locationId, trigger, _requestedBy) {
      if (!seesLocation(locationId)) throw new StoreError("forbidden", "row-level security");
      if (inFlight(locationId)) throw new StoreError("conflict", "scans_one_in_flight_idx");
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

    async completeScan(id, outcome) {
      const scan = requireScan(id);
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
