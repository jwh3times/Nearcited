import type {
  AuditJob,
  AuditPart,
  Location,
  Organization,
  Plan,
  ProviderUsage,
  Recommendation,
  Scan,
  ScanResult,
  SiteCheck,
  TrackedQuery,
  UsageByMonth,
} from "@nearcited/shared";
import {
  type PriceVersion,
  type Store,
  StoreError,
  type SubscriptionRecord,
  type UsageSource,
} from "../src/store/types";

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
  /** What is on sale, and anything taken off sale that an organization is still on. */
  plans: Plan[];
  /** What scans and audits used at the providers, as the worker recorded it. */
  usage: (UsageSource & ProviderUsage & { created_at: string })[];
  /** Sign-in accounts, as the one function that may read them returns them to the operator. */
  accounts: {
    user_id: string;
    email: string | null;
    created_at: string;
    last_sign_in_at: string | null;
  }[];
  /** Accounts with the `operator` platform role, which read every organization's rows. */
  operators: Set<string>;
  /** Accounts with the `test` platform role. Every organization one creates is a test one. */
  testAccounts: Set<string>;
  /** The on-page check each scan made, by scan ID. */
  siteChecks: Map<string, SiteCheck | null>;
  /** The payment provider's names for each plan's prices, by plan key. */
  planPrices: Map<string, { base: string | null; extra: string | null }>;
  /** Prices a plan was sold at before its present ones, newest first. */
  pastPrices: (PriceVersion & { plan_key: string })[];
  /** What the worker has kept of each organization's subscription, by organization ID. */
  subscriptions: Map<string, SubscriptionRecord>;
}

export interface MemoryAudit extends AuditJob {
  token: string;
  parts: Record<string, AuditPart>;
  error: string | null;
  created_at: string;
  expires_at: string;
}

const COUNTS = [
  "calls",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "searches",
] as const;

export function createMemoryDb(): MemoryDb {
  return {
    accounts: [],
    operators: new Set(),
    testAccounts: new Set(),
    usage: [],
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
    plans: [],
    siteChecks: new Map(),
    planPrices: new Map(),
    pastPrices: [],
    subscriptions: new Map(),
  };
}

let clock = Date.parse("2026-10-01T00:00:00Z");
/** Strictly increasing, so "latest" is well defined even within one millisecond. */
const timestamp = () => new Date(clock++).toISOString();

/** Roomier than the database's defaults, so tests that are not about limits never meet one. */
export const DEFAULT_LIMITS = {
  max_locations: 10,
  max_queries_per_location: 20,
  max_manual_scans_per_month: 50,
  scan_every_days: 1,
  surfaces: null,
  emails_report: true,
};

/** `userId: null` is the worker's view: no filtering. */
export function memoryStore(db: MemoryDb, userId: string | null): Store {
  /** Membership: what every write is checked against. */
  const seesOrg = (organizationId: string) =>
    userId === null ||
    db.memberships.some((m) => m.organization_id === organizationId && m.user_id === userId);
  /** Mirrors the operator's select policies: reads everything, and that is all. */
  const isOperator = userId !== null && db.operators.has(userId);
  const readsOrg = (organizationId: string) => isOperator || seesOrg(organizationId);
  const readableLocation = (id: string) =>
    db.locations.find((location) => location.id === id && readsOrg(location.organization_id));
  const readsLocation = (id: string) => readableLocation(id) !== undefined;
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
      return db.organizations.find((o) => o.id === id && readsOrg(id)) ?? null;
    },

    async listPlans() {
      const mine = db.organizations
        .filter((organization) => seesOrg(organization.id))
        .map((organization) => organization.plan_key);
      return db.plans
        .filter((plan) => plan.on_sale || isOperator || mine.includes(plan.key))
        .sort((a, b) => a.position - b.position);
    },

    async getManualScansUsed(organizationId) {
      if (!readsOrg(organizationId) || !db.organizations.some((o) => o.id === organizationId)) {
        return null;
      }
      return db.scans.filter(
        (scan) =>
          scan.trigger === "manual" &&
          db.requestedBy.has(scan.id) &&
          db.locations.find((l) => l.id === scan.location_id)?.organization_id === organizationId,
      ).length;
    },

    async listPlanPrices() {
      return (await this.listPlans()).map((plan) => {
        const ids = db.planPrices.get(plan.key);
        const current: PriceVersion | null = ids?.base
          ? {
              price_cents: plan.price_cents,
              extra_location_price_cents: ids.extra ? plan.extra_location_price_cents : null,
              stripe_price_id: ids.base,
              stripe_extra_location_price_id: ids.extra,
            }
          : null;
        const past = db.pastPrices
          .filter((version) => version.plan_key === plan.key)
          .map(({ plan_key: _, ...version }) => version);
        return {
          key: plan.key,
          on_sale: plan.on_sale,
          included_locations: plan.included_locations,
          current,
          versions: current ? [current, ...past] : past,
        };
      });
    },

    async getBillingState(organizationId) {
      const owns = db.memberships.some(
        (m) => m.organization_id === organizationId && m.user_id === userId && m.role === "owner",
      );
      const organization = db.organizations.find((o) => o.id === organizationId);
      if (!owns || !organization) return null;
      const kept = db.subscriptions.get(organizationId);
      return {
        organization_id: organization.id,
        is_test: organization.is_test,
        plan_key: organization.plan_key,
        stripe_customer_id: kept?.stripe_customer_id ?? null,
        stripe_subscription_id: kept?.stripe_subscription_id ?? null,
        status: kept?.status ?? null,
      };
    },

    async getSubscription(organizationId) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      return db.subscriptions.get(organizationId) ?? null;
    },

    async recordSubscription(organizationId, subscription) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      db.subscriptions.set(organizationId, { ...subscription });
    },

    async chooseAssistants(id, surfaces) {
      const owns = db.memberships.some(
        (m) => m.organization_id === id && m.user_id === userId && m.role === "owner",
      );
      const organization = db.organizations.find((o) => o.id === id);
      if (!owns || !organization) return null;
      const plan = db.plans.find((candidate) => candidate.key === organization.plan_key);
      if (!plan) throw new StoreError("limit", "This organization's assistants were set for it.");
      const picked = (["chatgpt", "claude"] as const).filter((s) => surfaces.includes(s));
      if (picked.length !== surfaces.length || picked.length !== Math.min(plan.assistants, 2)) {
        throw new StoreError("limit", `This organization's plan checks ${plan.assistants}.`);
      }
      return Object.assign(organization, { surfaces: picked });
    },

    async applyPlan(organizationId, planKey, locations) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const plan = db.plans.find((candidate) => candidate.key === planKey);
      if (!plan) throw new StoreError("unexpected", `no plan called ${planKey}`);
      const organization = db.organizations.find((o) => o.id === organizationId);
      if (!organization) return null;
      const one = organization.surfaces?.length === 1 ? organization.surfaces : null;
      return Object.assign(organization, {
        plan_key: plan.key,
        max_locations: Math.max(plan.included_locations, locations ?? 0),
        max_queries_per_location: plan.max_queries_per_location,
        max_manual_scans_per_month: plan.max_manual_scans_per_month,
        scan_every_days: plan.scan_every_days,
        emails_report: plan.emails_report,
        surfaces: plan.assistants >= 2 ? ["chatgpt", "claude"] : (one ?? ["chatgpt"]),
      });
    },

    async renameOrganization(id, name) {
      const organization = db.organizations.find((o) => o.id === id && seesOrg(id));
      return organization ? Object.assign(organization, { name }) : null;
    },

    async setOrganizationLimits(id, limits) {
      if (!isOperator) return null;
      const organization = db.organizations.find((o) => o.id === id);
      return organization ? Object.assign(organization, limits, { plan_key: null }) : null;
    },

    async createOrganization(name) {
      if (userId === null) throw new StoreError("forbidden", "not authenticated");
      // One organization for each account, as the database function has it.
      const exempt = db.operators.has(userId) || db.testAccounts.has(userId);
      if (!exempt && db.memberships.some((m) => m.user_id === userId)) {
        throw new StoreError("limit", "This account already has an organization.");
      }
      const organization: Organization = {
        id: crypto.randomUUID(),
        name,
        ...DEFAULT_LIMITS,
        is_test: db.testAccounts.has(userId),
        plan_key: null,
        created_at: timestamp(),
      };
      db.organizations.push(organization);
      db.memberships.push({ organization_id: organization.id, user_id: userId, role: "owner" });
      return organization;
    },

    async listEverySubscription() {
      return [...db.subscriptions]
        .filter(([organizationId]) => readsOrg(organizationId))
        .map(([organization_id, kept]) => ({
          organization_id,
          subscribed: kept.stripe_subscription_id !== null,
        }));
    },

    async setPlan(key, settings) {
      const plan = db.plans.find((candidate) => candidate.key === key);
      if (!isOperator || !plan) return null;
      if (key === "free" && !settings.on_sale) {
        throw new StoreError("limit", "The free plan stays on sale.");
      }
      Object.assign(plan, settings);
      // As the database function does: every organization on the plan takes the new values.
      const worker = memoryStore(db, null);
      for (const organization of db.organizations.filter((o) => o.plan_key === key)) {
        await worker.applyPlan(organization.id, key, organization.max_locations);
      }
      return plan;
    },

    async setPlanPrices(key, version) {
      const plan = db.plans.find((candidate) => candidate.key === key);
      if (!isOperator || !plan) return null;
      if (key === "free") throw new StoreError("limit", "The free plan has no price to change.");
      const was = db.planPrices.get(key);
      if (was?.base) {
        db.pastPrices.unshift({
          plan_key: key,
          price_cents: plan.price_cents,
          extra_location_price_cents: was.extra ? plan.extra_location_price_cents : null,
          stripe_price_id: was.base,
          stripe_extra_location_price_id: was.extra,
        });
      }
      db.planPrices.set(key, {
        base: version.stripe_price_id,
        extra: version.stripe_extra_location_price_id,
      });
      return Object.assign(plan, {
        price_cents: version.price_cents,
        extra_location_price_cents: version.extra_location_price_cents,
      });
    },

    async getPlatformRole(id) {
      // An account reads its own role; the operator can read anyone's.
      if (userId !== null && id !== userId && !isOperator) return null;
      return db.operators.has(id) ? "operator" : db.testAccounts.has(id) ? "test" : null;
    },

    async listEveryOrganization() {
      return db.organizations.filter((organization) => readsOrg(organization.id));
    },

    async listEveryLocation() {
      return db.locations.filter((location) => readsOrg(location.organization_id));
    },

    async countActiveQueries() {
      const counts: Record<string, number> = {};
      for (const query of db.queries) {
        if (query.is_active && readsLocation(query.location_id)) {
          counts[query.location_id] = (counts[query.location_id] ?? 0) + 1;
        }
      }
      return counts;
    },

    async listScansSince(since) {
      return db.scans
        .filter((scan) => scan.created_at >= since && readsLocation(scan.location_id))
        .map((scan) => ({ ...scan, site_check: db.siteChecks.get(scan.id) ?? null }));
    },

    async listUsageByMonth(since) {
      if (userId !== null && !isOperator) return [];
      const totals = new Map<string, UsageByMonth>();
      for (const { surface: _surface, created_at, ...row } of db.usage) {
        if (created_at < since) continue;
        const month = created_at.slice(0, 7);
        const organization_id = "organization_id" in row ? row.organization_id : null;
        const is_audit = "audit_id" in row;
        const key = [month, organization_id, is_audit, row.model].join("|");
        const total = totals.get(key);
        if (total) {
          for (const count of COUNTS) total[count] += row[count];
        } else {
          const { model, calls, input_tokens, cached_input_tokens, output_tokens, searches } = row;
          totals.set(key, {
            month,
            organization_id,
            is_audit,
            model,
            calls,
            input_tokens,
            cached_input_tokens,
            output_tokens,
            searches,
          });
        }
      }
      return [...totals.values()];
    },

    async listEveryAudit() {
      // Only the operator's policy answers on this table.
      return userId === null || isOperator ? db.audits : [];
    },

    async listAccounts() {
      // The function answers the operator and returns nothing to anyone else.
      return isOperator ? db.accounts : [];
    },

    async listEveryMembership() {
      return db.memberships.filter((membership) => readsOrg(membership.organization_id));
    },

    async listPlatformRoles() {
      const roles: Record<string, "operator" | "test"> = {};
      const mine = (id: string) => userId === null || isOperator || id === userId;
      for (const id of db.operators) if (mine(id)) roles[id] = "operator";
      for (const id of db.testAccounts) if (mine(id)) roles[id] = "test";
      return roles;
    },

    async listLocations(organizationId) {
      return db.locations.filter(
        (location) => location.organization_id === organizationId && readsOrg(organizationId),
      );
    },

    async activateLocation(id, insteadOf) {
      const location = db.locations.find((l) => l.id === id);
      if (!location || !seesLocation(id)) return null;
      if (!location.paused_by_plan) return location;
      const inUse = db.locations.filter(
        (l) => l.organization_id === location.organization_id && !l.paused_by_plan,
      );
      const allowed = limits(location.organization_id).max_locations;
      if (inUse.length >= allowed) {
        const other = inUse.find((l) => l.id === insteadOf);
        if (!other) {
          throw new StoreError("limit", `This organization's plan covers ${allowed} locations.`);
        }
        other.paused_by_plan = true;
      }
      location.paused_by_plan = false;
      return location;
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
        paused_by_plan: false,
        last_scanned_at: null,
        created_at: timestamp(),
      };
      db.locations.push(location);
      return location;
    },

    async getLocation(id) {
      return readableLocation(id) ?? null;
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
      return readsLocation(locationId)
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
        set_aside_by_plan: false,
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
      if (trigger === "manual" && db.locations.find((l) => l.id === locationId)?.paused_by_plan) {
        throw new StoreError("limit", "This location is paused.");
      }
      if (trigger === "manual" && requestedBy !== null) {
        const organizationId = db.locations.find((l) => l.id === locationId)?.organization_id ?? "";
        const allowed = limits(organizationId).max_manual_scans_per_month;
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
      if (!readsLocation(locationId)) return [];
      return db.scans
        .filter((scan) => scan.location_id === locationId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit);
    },

    async getScan(id) {
      const scan = db.scans.find((candidate) => candidate.id === id);
      return scan && readsLocation(scan.location_id) ? scan : null;
    },

    async listScanResults(scanId) {
      const scan = db.scans.find((candidate) => candidate.id === scanId);
      if (!scan || !readsLocation(scan.location_id)) return [];
      return db.results.filter((result) => result.scan_id === scanId);
    },

    async listRecentResults(locationId, scans, sampleData) {
      if (!readsLocation(locationId)) return [];
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
      return readsLocation(locationId)
        ? db.recommendations.filter((recommendation) => recommendation.location_id === locationId)
        : [];
    },

    async setRecommendationStatus(id, status) {
      const recommendation = db.recommendations.find((candidate) => candidate.id === id);
      if (!recommendation || !seesLocation(recommendation.location_id)) return null;
      recommendation.status = status;
      return recommendation;
    },

    async createAudit(input) {
      if (!isOperator) return null;
      const audit: MemoryAudit = {
        ...input,
        id: crypto.randomUUID(),
        token: crypto.randomUUID().replaceAll("-", "").repeat(2),
        status: "queued",
        parts: {},
        error: null,
        revoked_at: null,
        created_at: timestamp(),
        expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      };
      db.audits.push(audit);
      const { id, token, business_name, city, region, status, error } = audit;
      const { created_at, expires_at, revoked_at } = audit;
      return {
        id,
        token,
        business_name,
        city,
        region,
        status,
        error,
        created_at,
        expires_at,
        revoked_at,
      };
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

    async recordUsage(source, usage) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      db.usage.push(...usage.map((row) => ({ ...source, ...row, created_at: timestamp() })));
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
      if (!readsLocation(locationId)) return null;
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
