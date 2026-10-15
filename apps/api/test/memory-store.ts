import type {
  Action,
  Alert,
  Allowances,
  AuditJob,
  AuditPart,
  Connection,
  Draft,
  LimitChange,
  LimitChangeNotice,
  Listing,
  Location,
  Organization,
  Plan,
  PriceChange,
  PriceChangeNotice,
  PromptPage,
  ProviderUsage,
  Recommendation,
  Scan,
  ScanResult,
  SiteCheck,
  TrackedQuery,
  UsageByMonth,
  VisitAssistant,
} from "@nearcited/shared";
import {
  ALLOWANCE_KINDS,
  allowanceErrors,
  allowedEachMonth,
  CITING_SURFACES,
  DRAFTS_ALLOWANCE,
  hostOf,
  LONGEST_PATH,
  MOST_PAGES_A_DAY,
  MOST_VISITS_A_DAY,
  NOTICE_HOLD_HOURS,
  PAGES_SHOWN,
  reductions,
  VISITS_ALLOWANCE,
} from "@nearcited/shared";
import {
  type NewAction,
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
  memberships: { organization_id: string; user_id: string; role: "owner" | "admin" | "member" }[];
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
  /** What the announcement functions take as the present moment, when a test sets one. */
  now?: string;
  limitChanges: LimitChange[];
  /** Use of a counted allowance in a month, keyed `organization:kind:month`. */
  allowanceUse: Map<string, number>;
  /** Every action, with the worker's own bookkeeping beside what a member is sent. */
  actions: (Action & {
    subject: string;
    basis: string;
    attempts: number;
    carrying_since: string | null;
    told_at: string | null;
    waiting_told_at: string | null;
    recommendation_id: string | null;
    seen_until: string | null;
    /** The month, as `YYYY-MM`, whose allowance this action holds one of. */
    allowance_month: string | null;
  })[];
  /** Every draft, with the worker's own bookkeeping beside what a member is sent. */
  drafts: (Draft & {
    attempts: number;
    writing_since: string | null;
    /** The month, as `YYYY-MM`, whose allowance this ask holds one of. */
    allowance_month: string | null;
    model: string | null;
  })[];
  /** Every listing: one for a location on a site. */
  listings: Listing[];
  /** Where each page task's page is, with the location it belongs to. */
  promptPages: (PromptPage & { location_id: string })[];
  /** Every location's line: the key its site carries, and the last day it answered a check. */
  visitLines: Map<string, { key: string; key_made_at: string; checked_on: string | null }>;
  /** The visits counted. No entry is a visit: each is how many, for a day, assistant and page. */
  visits: {
    location_id: string;
    day: string;
    assistant: VisitAssistant;
    path: string;
    count: number;
  }[];
  /** Every alert, with what keeps one thing from being raised twice beside what is sent. */
  alerts: (Alert & {
    subject: string;
    sample_data: boolean;
    /** When the owners were emailed that it was raised, and that it ended. */
    told_at: string | null;
    cleared_told_at: string | null;
  })[];
  /**
   * The `action_kind_terms` table: the allowance a kind of action takes from, and how many days
   * what it replaced may be kept. A test changes a kind's terms to stand for a real kind.
   */
  actionKindTerms: Map<string, { allowance: string | null; keeps_seen_days: number | null }>;
  /** The sample account's made-up listings, keyed `connection:external`. */
  sampleLines: Map<string, string>;
  connections: Connection[];
  /** What the worker keeps about a connection and no member is sent. */
  connectionHealth: Map<
    string,
    {
      failed_days: number;
      last_failed_on: string | null;
      told_at: string | null;
      reminded_at: string | null;
    }
  >;
  /** The `connection_kind_allowances` table: the allowance a kind of connection needs. */
  connectionKindAllowances: Map<string, string>;
  /** Each connection's sign-in as it was sealed, by connection. Only the worker reads it. */
  connectionSecrets: Map<string, string>;
  /**
   * The `allowance_kinds` table: each kind, and whether it is counted. It starts as the kinds
   * this build lists. A test adds one to stand for a kind a migration made before the Worker
   * that knows it was deployed.
   */
  allowanceKinds: Map<string, boolean>;
  limitChangeNotices: LimitChangeNotice[];
  priceChanges: PriceChange[];
  priceChangeNotices: PriceChangeNotice[];
  /** Prices a plan was sold at before its present ones, newest first. */
  pastPrices: (PriceVersion & { plan_key: string })[];
  /** What the worker has kept of each organization's subscription, by organization ID. */
  subscriptions: Map<string, SubscriptionRecord>;
  /** The subscription each organization's owners were last thanked for starting. */
  welcomed: Map<string, string>;
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
    priceChanges: [],
    limitChanges: [],
    allowanceUse: new Map(),
    actions: [],
    drafts: [],
    listings: [],
    promptPages: [],
    visitLines: new Map(),
    visits: [],
    alerts: [],
    actionKindTerms: new Map([["sample", { allowance: null, keeps_seen_days: 30 }]]),
    sampleLines: new Map(),
    connections: [],
    connectionHealth: new Map(),
    connectionKindAllowances: new Map(),
    connectionSecrets: new Map(),
    allowanceKinds: new Map(
      Object.entries(ALLOWANCE_KINDS).map(([key, kind]) => [key, kind.counted]),
    ),
    limitChangeNotices: [],
    priceChangeNotices: [],
    subscriptions: new Map(),
    welcomed: new Map(),
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
  allowances: {},
};

/**
 * Mirrors `check_allowances()`: a set may name only kinds the database has, each with a value it
 * takes. Those are the kinds in `db.allowanceKinds`, which can be more than this build lists.
 */
function requireAllowances(db: MemoryDb, allowances: Record<string, unknown>) {
  const kinds = Object.fromEntries(
    [...db.allowanceKinds].map(([key, counted]) => [key, { counted, name: key }]),
  );
  const [message] = Object.values(allowanceErrors(allowances, kinds));
  if (message) throw new StoreError("limit", message);
}

/** Mirrors `test_allowances()`: every kind the database has, with room to exercise it. */
const testAllowances = (db: MemoryDb): Allowances =>
  Object.fromEntries([...db.allowanceKinds].map(([key, counted]) => [key, counted ? 1000 : true]));

/** `userId: null` is the worker's view: no filtering. */
export function memoryStore(db: MemoryDb, userId: string | null): Store {
  /** Membership: what every write is checked against. */
  const seesOrg = (organizationId: string) =>
    userId === null ||
    db.memberships.some((m) => m.organization_id === organizationId && m.user_id === userId);
  /** Mirrors the operator's select policies: reads everything, and that is all. */
  const isOperator = userId !== null && db.operators.has(userId);
  const readsOrg = (organizationId: string) => isOperator || seesOrg(organizationId);
  /** An action as a member is sent it: without the worker's own bookkeeping. */
  const sentAction = ({
    subject: _subject,
    basis: _basis,
    attempts: _attempts,
    carrying_since: _since,
    told_at: _told,
    waiting_told_at: _waitingTold,
    recommendation_id: _task,
    seen_until: _until,
    allowance_month: _month,
    ...action
  }: MemoryDb["actions"][number]): Action => action;
  const thisMonth = () => (db.now ?? new Date().toISOString()).slice(0, 7);
  /** Mirrors claim_allowance(): the month's number is the plan's for each location it covers. */
  const takeAllowance = (organizationId: string, kind: string, amount: number) => {
    const organization = db.organizations.find((o) => o.id === organizationId);
    if (!organization) return null;
    const allowance = organization.allowances[kind];
    if (allowance === undefined) return { claimed: false, allowed: 0, used: 0 };
    if (allowance === true) return { claimed: true, allowed: null, used: 0 };
    const most = allowedEachMonth(allowance, organization.max_locations);
    const key = `${organizationId}:${kind}:${thisMonth()}`;
    const soFar = db.allowanceUse.get(key) ?? 0;
    if (soFar + amount > most) return { claimed: false, allowed: most, used: soFar };
    db.allowanceUse.set(key, soFar + amount);
    return { claimed: true, allowed: most, used: soFar + amount };
  };
  /** Mirrors the room check the action functions make: no allowance needed, or room this month. */
  const hasRoom = (locationId: string, kind: string) => {
    const needed = db.actionKindTerms.get(kind)?.allowance;
    if (!needed) return true;
    const organization = db.organizations.find(
      (o) => o.id === db.locations.find((l) => l.id === locationId)?.organization_id,
    );
    const allowance = organization?.allowances[needed];
    if (!organization || allowance === undefined) return false;
    if (allowance === true) return true;
    const used = db.allowanceUse.get(`${organization.id}:${needed}:${thisMonth()}`) ?? 0;
    return used < allowedEachMonth(allowance, organization.max_locations);
  };
  const NO_ROOM = "Your plan has no more of these this month.";
  const NO_DRAFTS = "Your plan has no more drafts this month.";
  const MOST_LISTINGS = 50;
  const sentDraft = ({
    attempts: _attempts,
    writing_since: _since,
    allowance_month: _month,
    model: _model,
    ...draft
  }: MemoryDb["drafts"][number]): Draft => draft;
  const organizationOf = (locationId: string) =>
    db.organizations.find(
      (o) => o.id === db.locations.find((l) => l.id === locationId)?.organization_id,
    );
  /** Mirrors organization_held(): an action done 36 hours ago and its owners still not told. */
  const organizationHeld = (organizationId: string) => {
    const organization = db.organizations.find((o) => o.id === organizationId);
    if (!organization || organization.is_test) return false;
    const before = new Date(
      Date.parse(db.now ?? new Date().toISOString()) - NOTICE_HOLD_HOURS * 3_600_000,
    ).toISOString();
    return db.actions.some(
      (action) =>
        action.status === "done" &&
        action.told_at === null &&
        action.done_at !== null &&
        action.done_at < before &&
        db.locations.find((l) => l.id === action.location_id)?.organization_id === organizationId,
    );
  };
  /** Whether one for the same thing is waiting or on its way, as the unique index has it. */
  const openFor = (locationId: string, kind: string, subject: string) =>
    db.actions.some(
      (action) =>
        action.location_id === locationId &&
        action.kind === kind &&
        action.subject === subject &&
        (action.status === "proposed" || action.status === "approved"),
    );
  /** The day what a new action replaces may no longer be kept, by its kind's terms. */
  const seenUntil = (action: NewAction, now: string) => {
    const days = db.actionKindTerms.get(action.kind)?.keeps_seen_days ?? null;
    return action.seen !== null && days !== null
      ? new Date(Date.parse(now) + days * 86_400_000).toISOString()
      : null;
  };
  /** A new proposal, waiting its fourteen days from `now`. */
  const newAction = (
    action: NewAction | MemoryDb["actions"][number],
    now: string,
  ): MemoryDb["actions"][number] => ({
    id: crypto.randomUUID(),
    location_id: action.location_id,
    kind: action.kind,
    connection_id: action.connection_id,
    subject: action.subject,
    basis: action.basis,
    summary: action.summary,
    seen: action.seen,
    proposed_text: action.proposed_text,
    written_by: action.written_by,
    status: "proposed",
    proposed_at: now,
    lapses_at: new Date(Date.parse(now) + 14 * 86_400_000).toISOString(),
    approved_by_email: null,
    approved_at: null,
    approved_text: null,
    declined_by_email: null,
    declined_at: null,
    decline_reason: null,
    done_at: null,
    failed_at: null,
    failure: null,
    lapsed_at: null,
    lapse_reason: null,
    retry_of: null,
    attempts: 0,
    carrying_since: null,
    told_at: null,
    waiting_told_at: null,
    recommendation_id: action.recommendation_id ?? null,
    // Asked for again, what it replaces may be kept no longer than the first one's could.
    seen_dropped_at: "seen_until" in action ? action.seen_dropped_at : null,
    seen_until: "seen_until" in action ? action.seen_until : seenUntil(action, now),
    allowance_month: null,
  });
  /** Mirrors the due and sync rules: working, or broken only by failing, which is still tried. */
  const syncs = (connection: Connection) =>
    connection.status === "working" ||
    (connection.status === "broken" && connection.broken_reason === "failing");
  /** Mirrors allows_connection(): the kind needs no allowance, or the organization has it. */
  const allowsConnection = (organizationId: string, kind: string) => {
    const needed = db.connectionKindAllowances.get(kind);
    const organization = db.organizations.find((o) => o.id === organizationId);
    return needed === undefined || organization?.allowances[needed] !== undefined;
  };
  /** Mirrors fit_connections_to_plan(): pause what is no longer included, bring back what is. */
  const fitConnections = (organizationId: string) => {
    const now = db.now ?? new Date().toISOString();
    for (const connection of db.connections) {
      if (connection.organization_id !== organizationId) continue;
      const allowed = allowsConnection(organizationId, connection.kind);
      if (!allowed && (connection.status === "working" || connection.status === "broken")) {
        Object.assign(connection, { status: "paused", paused_at: now });
      } else if (allowed && connection.status === "paused") {
        Object.assign(connection, {
          status: connection.broken_reason === null ? "working" : "broken",
          paused_at: null,
        });
      }
    }
  };
  /** An owner or admin of the organization, by their own membership. */
  const managesOrg = (organizationId: string) =>
    db.memberships.some(
      (m) => m.organization_id === organizationId && m.user_id === userId && m.role !== "member",
    );
  /** An alert as it is sent: without what the database keeps to tell one thing from another. */
  const sentAlert = ({
    subject: _subject,
    sample_data: _sample,
    told_at: _told,
    cleared_told_at: _clearedTold,
    ...alert
  }: MemoryDb["alerts"][number]): Alert => alert;
  const readableLocation = (id: string) =>
    db.locations.find((location) => location.id === id && readsOrg(location.organization_id));
  const readsLocation = (id: string) => readableLocation(id) !== undefined;
  const visibleLocation = (id: string) =>
    db.locations.find((location) => location.id === id && seesOrg(location.organization_id));
  const seesLocation = (id: string) => visibleLocation(id) !== undefined;
  const limits = (organizationId: string) =>
    db.organizations.find((organization) => organization.id === organizationId) ?? DEFAULT_LIMITS;
  /** The day a visit is counted under: the database's own, in UTC. */
  const today = () => (db.now ?? new Date().toISOString()).slice(0, 10);
  /**
   * Mirrors counts_visits(): the location a key is the line of, when a visit reported from
   * `host` is one to count for it. Its plan includes visits and covers the location, and the
   * page is on the website the location has on file or on a subdomain of it.
   */
  const lineOf = (key: string, host: string): string | null => {
    const [locationId] = [...db.visitLines].find(([, line]) => line.key === key) ?? [];
    const location = db.locations.find((candidate) => candidate.id === locationId);
    if (!location || location.paused_by_plan) return null;
    const organization = db.organizations.find(({ id }) => id === location.organization_id);
    if (organization?.allowances[VISITS_ALLOWANCE] === undefined) return null;
    const kept = hostOf(location.website);
    const seen = hostOf(host);
    return kept && seen && (seen === kept || seen.endsWith(`.${kept}`)) ? location.id : null;
  };
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

    async claimSubscriptionStart(organizationId, subscriptionId) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      if (!db.subscriptions.has(organizationId)) return false;
      if (db.welcomed.get(organizationId) === subscriptionId) return false;
      db.welcomed.set(organizationId, subscriptionId);
      return true;
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

    async listLocationActions(locationId) {
      if (!readsLocation(locationId)) return [];
      return db.actions
        .filter((action) => action.location_id === locationId)
        .sort((a, b) => b.proposed_at.localeCompare(a.proposed_at))
        .map(sentAction);
    },

    async listAlerts(locationId, sampleData) {
      if (!readsLocation(locationId)) return [];
      return db.alerts
        .filter(
          (alert) =>
            alert.location_id === locationId &&
            alert.sample_data === sampleData &&
            alert.cleared_at === null,
        )
        .sort((a, b) => b.raised_at.localeCompare(a.raised_at))
        .map(sentAlert);
    },

    // Mirrors seen_before(): what the written answers of every scan but the newest few named
    // and cited, as it was written.
    async listSeenBefore(locationId, sampleData, skip) {
      if (userId !== null) throw new StoreError("forbidden", "permission denied for function");
      const earlier = db.scans
        .filter(
          (scan) =>
            scan.location_id === locationId &&
            scan.status === "succeeded" &&
            scan.sample_data === sampleData,
        )
        .reverse()
        .slice(Math.max(0, skip))
        .map((scan) => scan.id);
      const answers = db.results.filter(
        (result) => earlier.includes(result.scan_id) && CITING_SURFACES.includes(result.surface),
      );
      return {
        competitors: [...new Set(answers.flatMap((answer) => answer.competitors))],
        origins: [
          ...new Set(
            answers.flatMap((answer) =>
              answer.cited_urls.map(
                (url) => /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]+/.exec(url)?.[0] ?? url,
              ),
            ),
          ),
        ],
      };
    },

    async listAlertsToTell(locationId, sampleData) {
      const mine = readsLocation(locationId)
        ? db.alerts
            .filter(
              (alert) =>
                alert.location_id === locationId &&
                alert.sample_data === sampleData &&
                alert.dismissed_at === null,
            )
            .sort((a, b) => b.raised_at.localeCompare(a.raised_at))
        : [];
      return {
        raised: mine
          .filter((alert) => alert.cleared_at === null && alert.told_at === null)
          .map(sentAlert),
        named_again: mine
          .filter(
            (alert) =>
              alert.clear_reason === "named_again" &&
              alert.told_at !== null &&
              alert.cleared_told_at === null,
          )
          .map(sentAlert),
      };
    },

    // No API role may update the table, so only the worker keeps this.
    async markAlertsTold(told, at) {
      if (told.raised.length + told.named_again.length === 0) return;
      if (userId !== null) throw new StoreError("forbidden", "permission denied for table alerts");
      for (const alert of db.alerts) {
        if (told.raised.includes(alert.id)) alert.told_at = at;
        if (told.named_again.includes(alert.id)) alert.cleared_told_at = at;
      }
    },

    // Mirrors dismiss_alert(): a member of the location's organization, and nothing to change
    // once it is dismissed or cleared.
    async dismissAlert(id) {
      const alert = db.alerts.find((candidate) => candidate.id === id);
      if (!alert || userId === null || !visibleLocation(alert.location_id)) return null;
      if (alert.dismissed_at === null && alert.cleared_at === null) {
        alert.dismissed_at = db.now ?? timestamp();
        alert.dismissed_by_email = db.emails.get(userId) ?? null;
      }
      return sentAlert(alert);
    },

    async listDrafts(locationId) {
      if (!readsLocation(locationId)) return [];
      return db.drafts.filter((draft) => draft.location_id === locationId).map(sentDraft);
    },

    // Mirrors ask_draft(): a member of the location's organization, one ask at a time, and only
    // while the month has room.
    async askDraft(recommendationId) {
      const task = db.recommendations.find((r) => r.id === recommendationId);
      if (!task || userId === null || !visibleLocation(task.location_id)) return null;
      const asked = db.drafts.find((draft) => draft.recommendation_id === recommendationId);
      if (asked?.status === "asked") return sentDraft(asked);

      const organization = organizationOf(task.location_id);
      const allowance = organization?.allowances[DRAFTS_ALLOWANCE];
      const used =
        db.allowanceUse.get(`${organization?.id}:${DRAFTS_ALLOWANCE}:${thisMonth()}`) ?? 0;
      const room =
        organization !== undefined &&
        allowance !== undefined &&
        (allowance === true || used < allowedEachMonth(allowance, organization.max_locations));
      if (!room) throw new StoreError("limit", NO_DRAFTS);

      const ask = {
        status: "asked" as const,
        asked_by_email: db.emails.get(userId) ?? null,
        asked_at: db.now ?? timestamp(),
        failure: null,
        attempts: 0,
        writing_since: null,
        allowance_month: null,
      };
      if (asked) return sentDraft(Object.assign(asked, ask));
      const draft = {
        id: crypto.randomUUID(),
        location_id: task.location_id,
        recommendation_id: recommendationId,
        kind: null,
        text: null,
        written_at: null,
        sample_data: false,
        model: null,
        ...ask,
      };
      db.drafts.push(draft);
      return sentDraft(draft);
    },

    async listListings(locationId) {
      if (!readsLocation(locationId)) return [];
      return db.listings
        .filter((listing) => listing.location_id === locationId)
        .sort((a, b) => a.site.localeCompare(b.site))
        .map((listing) => ({ ...listing }));
    },

    // Mirrors set_listing(): a member of the location's organization, one for a site, and a
    // bounded number of sites.
    async setListing(locationId, site, url) {
      if (userId === null || !visibleLocation(locationId)) return null;
      const held = db.listings.filter((listing) => listing.location_id === locationId);
      const kept = held.find((listing) => listing.site === site);
      if (!kept && held.length >= MOST_LISTINGS) {
        throw new StoreError("limit", "A location holds a listing on at most 50 sites.");
      }
      const set = {
        url,
        set_by_email: db.emails.get(userId) ?? null,
        set_at: db.now ?? timestamp(),
      };
      if (kept) return { ...Object.assign(kept, set) };
      const listing = { location_id: locationId, site, ...set };
      db.listings.push(listing);
      return { ...listing };
    },

    // Mirrors remove_listing().
    async removeListing(locationId, site) {
      if (userId === null || !visibleLocation(locationId)) return false;
      const at = db.listings.findIndex(
        (listing) => listing.location_id === locationId && listing.site === site,
      );
      if (at < 0) return false;
      db.listings.splice(at, 1);
      return true;
    },

    async listPromptPages(locationId) {
      if (!readsLocation(locationId)) return [];
      return db.promptPages
        .filter((page) => page.location_id === locationId)
        .sort((a, b) => a.set_at.localeCompare(b.set_at))
        .map(({ location_id: _, ...page }) => page);
    },

    // Mirrors set_prompt_page(): a member of the location's organization, and a page task.
    async setPromptPage(recommendationId, url) {
      const recommendation = db.recommendations.find((r) => r.id === recommendationId);
      if (
        userId === null ||
        !recommendation?.rule.startsWith("page:") ||
        !visibleLocation(recommendation.location_id)
      ) {
        return null;
      }
      const set = {
        url,
        set_by_email: db.emails.get(userId) ?? null,
        set_at: db.now ?? timestamp(),
      };
      const kept = db.promptPages.find((page) => page.recommendation_id === recommendationId);
      const page = kept
        ? Object.assign(kept, set)
        : { location_id: recommendation.location_id, recommendation_id: recommendationId, ...set };
      if (!kept) db.promptPages.push(page);
      const { location_id: _, ...sent } = page;
      return { ...sent };
    },

    // Mirrors remove_prompt_page().
    async removePromptPage(recommendationId) {
      const at = db.promptPages.findIndex((page) => page.recommendation_id === recommendationId);
      const page = db.promptPages[at];
      if (userId === null || !page || !visibleLocation(page.location_id)) return false;
      db.promptPages.splice(at, 1);
      return true;
    },

    async countWaitingActions(organizationId) {
      if (!readsOrg(organizationId)) return {};
      const waiting: Record<string, number> = {};
      for (const action of db.actions) {
        const location = db.locations.find((candidate) => candidate.id === action.location_id);
        if (action.status === "proposed" && location?.organization_id === organizationId) {
          waiting[action.location_id] = (waiting[action.location_id] ?? 0) + 1;
        }
      }
      return waiting;
    },

    // Mirrors approve_action(): a member of the location's organization, and only while it waits.
    async approveAction(id, text) {
      const action = db.actions.find((candidate) => candidate.id === id);
      if (!action || !visibleLocation(action.location_id)) return null;
      const now = db.now ?? new Date().toISOString();
      if (action.status !== "proposed" || action.lapses_at <= now) {
        throw new StoreError("limit", "This is no longer waiting for a yes.");
      }
      const changed = text?.trim() || null;
      if (changed !== null && action.proposed_text === null) {
        throw new StoreError("limit", "This action has no text to change.");
      }
      if (!hasRoom(action.location_id, action.kind)) throw new StoreError("limit", NO_ROOM);
      Object.assign(action, {
        status: "approved",
        approved_by_email: db.emails.get(userId ?? "") ?? null,
        approved_at: now,
        approved_text: changed !== null && changed !== action.proposed_text ? changed : null,
      });
      return sentAction(action);
    },

    async declineAction(id, reason) {
      const action = db.actions.find((candidate) => candidate.id === id);
      if (!action || !visibleLocation(action.location_id)) return null;
      if (action.status !== "proposed") {
        throw new StoreError("limit", "This is no longer waiting for an answer.");
      }
      Object.assign(action, {
        status: "declined",
        declined_by_email: db.emails.get(userId ?? "") ?? null,
        declined_at: db.now ?? new Date().toISOString(),
        decline_reason: reason?.trim() || null,
      });
      return sentAction(action);
    },

    // Mirrors retry_action(): a new action, approved by whoever asked, pointing at the failed one.
    async retryAction(id) {
      const failed = db.actions.find((candidate) => candidate.id === id);
      if (!failed || !visibleLocation(failed.location_id)) return null;
      if (failed.status !== "failed") {
        throw new StoreError("limit", "Only an action that failed can be asked for again.");
      }
      if (openFor(failed.location_id, failed.kind, failed.subject)) {
        throw new StoreError("limit", "There is already one of these waiting or on its way.");
      }
      if (!hasRoom(failed.location_id, failed.kind)) throw new StoreError("limit", NO_ROOM);
      const now = db.now ?? new Date().toISOString();
      const again = {
        ...newAction(failed, now),
        status: "approved" as const,
        approved_by_email: db.emails.get(userId ?? "") ?? null,
        approved_at: now,
        approved_text: failed.approved_text,
        retry_of: failed.id,
      };
      db.actions.push(again);
      return sentAction(again);
    },

    // Mirrors propose_action(): not while one is open, nor again after a no on the same basis,
    // nor once the month's allowance has no room.
    async proposeAction(action) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const declined = db.actions.some(
        (kept) =>
          kept.location_id === action.location_id &&
          kept.kind === action.kind &&
          kept.subject === action.subject &&
          kept.status === "declined" &&
          kept.basis === action.basis,
      );
      if (declined || openFor(action.location_id, action.kind, action.subject)) return null;
      if (!hasRoom(action.location_id, action.kind)) return null;
      const task = action.recommendation_id;
      if (
        task &&
        db.recommendations.find((r) => r.id === task)?.location_id !== action.location_id
      ) {
        throw new StoreError("unexpected", "A task belongs to the location its action is for.");
      }
      const made = newAction(action, db.now ?? new Date().toISOString());
      db.actions.push(made);
      return sentAction(made);
    },

    async getAction(id) {
      const action = db.actions.find((candidate) => candidate.id === id);
      const readable = userId === null || (action && readsLocation(action.location_id));
      return readable && action ? sentAction(action) : null;
    },

    // Mirrors claim_action(): approved, and nobody on it for the last ten minutes. A counted
    // kind takes one from the month as it is taken, and is failed here when there is no room.
    async claimAction(id) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const now = db.now ?? new Date().toISOString();
      const stale = new Date(Date.parse(now) - 10 * 60_000).toISOString();
      const action = db.actions.find(
        (candidate) =>
          candidate.id === id &&
          candidate.status === "approved" &&
          (candidate.carrying_since === null || candidate.carrying_since < stale),
      );
      const organizationId = db.locations.find(
        (l) => l.id === action?.location_id,
      )?.organization_id;
      if (!action || (organizationId && organizationHeld(organizationId))) return 0;
      const needed = db.actionKindTerms.get(action.kind)?.allowance;
      if (needed && action.allowance_month === null) {
        const claim = organizationId ? takeAllowance(organizationId, needed, 1) : null;
        if (!claim?.claimed) {
          Object.assign(action, { status: "failed", failed_at: now, failure: NO_ROOM });
          return 0;
        }
        if (claim.allowed !== null) action.allowance_month = thisMonth();
      }
      action.carrying_since = now;
      action.attempts += 1;
      return action.attempts;
    },

    // Mirrors finish_action().
    async finishAction(id, outcome, why) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const action = db.actions.find(
        (candidate) => candidate.id === id && candidate.status === "approved",
      );
      if (!action) return false;
      const now = db.now ?? new Date().toISOString();
      action.carrying_since = null;
      // Nothing was done, so what it took from the month is given back.
      if ((outcome === "failed" || outcome === "out_of_date") && action.allowance_month) {
        const organizationId = db.locations.find(
          (l) => l.id === action.location_id,
        )?.organization_id;
        const needed = db.actionKindTerms.get(action.kind)?.allowance;
        const key = `${organizationId}:${needed}:${action.allowance_month}`;
        db.allowanceUse.set(key, Math.max((db.allowanceUse.get(key) ?? 0) - 1, 0));
        action.allowance_month = null;
      }
      // The task it does the work of is done as of now, unless an earlier action already did it.
      const task = db.recommendations.find((r) => r.id === action.recommendation_id);
      if (outcome === "done" && task && !task.acted_by_action) {
        Object.assign(task, { acted_at: now, acted_by_action: action.id });
      }
      if (outcome === "done") Object.assign(action, { status: "done", done_at: now });
      if (outcome === "failed") {
        Object.assign(action, { status: "failed", failed_at: now, failure: why ?? null });
      }
      if (outcome === "out_of_date") {
        Object.assign(action, { status: "lapsed", lapsed_at: now, lapse_reason: "out_of_date" });
      }
      if (outcome === "again") action.failure = why ?? null;
      return true;
    },

    async listActionsToTell() {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      return db.actions
        .filter(
          (action) =>
            (action.status === "done" && action.told_at === null) ||
            (action.status === "proposed" && action.waiting_told_at === null),
        )
        .sort((a, b) => a.proposed_at.localeCompare(b.proposed_at))
        .flatMap((action) => {
          const location = db.locations.find((l) => l.id === action.location_id);
          return location
            ? [
                {
                  action: sentAction(action),
                  location_name: location.name,
                  organization_id: location.organization_id,
                },
              ]
            : [];
        });
    },

    async markActionsTold(ids, which, at) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      for (const action of db.actions) {
        if (!ids.includes(action.id)) continue;
        if (which === "done") action.told_at = at;
        else action.waiting_told_at = at;
      }
    },

    async isOrganizationHeld(organizationId) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      return organizationHeld(organizationId);
    },

    async isLocationHeld(locationId) {
      const location = readableLocation(locationId);
      return location ? organizationHeld(location.organization_id) : false;
    },

    async listUntoldActions() {
      return db.actions
        .filter(
          (action) =>
            action.status === "done" &&
            action.told_at === null &&
            action.done_at !== null &&
            readsLocation(action.location_id),
        )
        .map((action) => ({ location_id: action.location_id, done_at: action.done_at ?? "" }));
    },

    async lapseActions() {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const now = db.now ?? new Date().toISOString();
      const due = db.actions.filter(
        (action) => action.status === "proposed" && action.lapses_at <= now,
      );
      for (const action of due) {
        Object.assign(action, { status: "lapsed", lapsed_at: now, lapse_reason: "expired" });
      }
      return due.length;
    },

    // Mirrors drop_expired_seen().
    async dropExpiredSeen() {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const now = db.now ?? new Date().toISOString();
      const due = db.actions.filter(
        (action) => action.seen !== null && action.seen_until !== null && action.seen_until <= now,
      );
      for (const action of due) {
        if (action.status === "proposed") {
          Object.assign(action, { status: "lapsed", lapsed_at: now, lapse_reason: "out_of_date" });
        }
        Object.assign(action, { seen: null, seen_dropped_at: now });
      }
      return due.length;
    },

    async getDraft(id) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const draft = db.drafts.find((candidate) => candidate.id === id);
      return draft ? sentDraft(draft) : null;
    },

    // Mirrors claim_draft(): asked for, and nobody on it for the last ten minutes. It takes one
    // from the month unless this ask holds one, and is failed here when there is no room.
    async claimDraft(id) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const now = db.now ?? new Date().toISOString();
      const stale = new Date(Date.parse(now) - 10 * 60_000).toISOString();
      const draft = db.drafts.find(
        (candidate) =>
          candidate.id === id &&
          candidate.status === "asked" &&
          (candidate.writing_since === null || candidate.writing_since < stale),
      );
      if (!draft) return 0;
      if (draft.allowance_month === null) {
        const organization = organizationOf(draft.location_id);
        const claim = organization ? takeAllowance(organization.id, DRAFTS_ALLOWANCE, 1) : null;
        if (!claim?.claimed) {
          Object.assign(draft, { status: "failed", writing_since: null, failure: NO_DRAFTS });
          return 0;
        }
        draft.allowance_month = thisMonth();
      }
      draft.writing_since = now;
      draft.attempts += 1;
      return draft.attempts;
    },

    // Mirrors finish_draft().
    async finishDraft(id, result) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const draft = db.drafts.find(
        (candidate) => candidate.id === id && candidate.status === "asked",
      );
      if (!draft) return false;
      draft.writing_since = null;
      if (result.outcome === "written") {
        Object.assign(draft, {
          status: "written",
          text: result.text,
          kind: result.kind,
          model: result.model,
          sample_data: result.sample_data,
          written_at: db.now ?? timestamp(),
          failure: null,
        });
      } else if (result.outcome === "failed") {
        // Nothing was written, so what the ask took from the month is given back.
        if (draft.allowance_month) {
          const key = `${organizationOf(draft.location_id)?.id}:${DRAFTS_ALLOWANCE}:${draft.allowance_month}`;
          db.allowanceUse.set(key, Math.max((db.allowanceUse.get(key) ?? 0) - 1, 0));
        }
        Object.assign(draft, { status: "failed", failure: result.why, allowance_month: null });
      } else {
        draft.failure = result.why;
      }
      return true;
    },

    async listStalledDrafts(before) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      return db.drafts
        .filter(
          (draft) =>
            draft.status === "asked" &&
            draft.asked_at < before &&
            (draft.writing_since === null || draft.writing_since < before),
        )
        .map((draft) => draft.id);
    },

    async listStalledActions(before) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      return db.actions
        .filter(
          (action) =>
            action.status === "approved" &&
            action.approved_at !== null &&
            action.approved_at < before &&
            (action.carrying_since === null || action.carrying_since < before),
        )
        .map((action) => action.id);
    },

    async getSampleLine(connectionId, externalId) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      return db.sampleLines.get(`${connectionId}:${externalId}`) ?? null;
    },

    async setSampleLine(connectionId, externalId, line) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      db.sampleLines.set(`${connectionId}:${externalId}`, line);
    },

    async listConnections(organizationId) {
      if (!readsOrg(organizationId)) return [];
      return db.connections
        .filter((connection) => connection.organization_id === organizationId)
        .sort((a, b) => b.connected_at.localeCompare(a.connected_at));
    },

    // Mirrors has_org_role(): the caller's own role, which the operator reading through has not.
    async managesConnections(organizationId) {
      return managesOrg(organizationId);
    },

    async createConnection(connection) {
      if (!managesOrg(connection.organization_id)) return null;
      if (connection.sealed === "") throw new StoreError("unexpected", "made with its sign-in");
      const { sealed, ...row } = connection;
      const made: Connection = {
        ...row,
        status: "working",
        connected_by_email: db.emails.get(userId ?? "") ?? null,
        connected_at: db.now ?? timestamp(),
        removed_by_email: null,
        removal_requested_at: null,
        removed_at: null,
        broken_reason: null,
        broken_at: null,
        paused_at: null,
        removal_reason: null,
        last_synced_at: null,
        choices: [],
        matches: [],
      };
      if (!allowsConnection(connection.organization_id, connection.kind)) {
        throw new StoreError("limit", "This organization's plan does not include this.");
      }
      db.connections.push(made);
      db.connectionSecrets.set(made.id, sealed);
      return made;
    },

    async requestConnectionRemoval(id) {
      const connection = db.connections.find((candidate) => candidate.id === id);
      if (!connection || !managesOrg(connection.organization_id)) return null;
      if (connection.status === "removing" || connection.status === "removed") return connection;
      return Object.assign(connection, {
        status: "removing",
        removal_reason: "asked",
        removed_by_email: db.emails.get(userId ?? "") ?? null,
        removal_requested_at: db.now ?? timestamp(),
      });
    },

    async getConnection(id) {
      const connection = db.connections.find((candidate) => candidate.id === id);
      const readable = userId === null || (connection && readsOrg(connection.organization_id));
      return (readable && connection) || null;
    },

    async getConnectionSecret(id) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      return db.connectionSecrets.get(id) ?? null;
    },

    // Mirrors finish_connection_removal(): only one waiting to be removed loses its sign-in.
    async finishConnectionRemoval(id) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const connection = db.connections.find(
        (candidate) => candidate.id === id && candidate.status === "removing",
      );
      if (!connection) return false;
      // What was synced goes with the sign-in.
      Object.assign(connection, {
        status: "removed",
        removed_at: db.now ?? timestamp(),
        choices: [],
        matches: [],
      });
      db.connectionSecrets.delete(id);
      return true;
    },

    // Mirrors connections_due_for_sync(): never synced, or most of a day ago. One that only
    // kept failing is still tried.
    async listConnectionsDueForSync(limit) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const before = Date.parse(db.now ?? new Date().toISOString()) - 20 * 3_600_000;
      return db.connections
        .filter(
          (connection) =>
            syncs(connection) &&
            (connection.last_synced_at === null || Date.parse(connection.last_synced_at) < before),
        )
        .sort((a, b) => (a.last_synced_at ?? "").localeCompare(b.last_synced_at ?? ""))
        .slice(0, limit)
        .map((connection) => connection.id);
    },

    async listConnectionsAwaitingFirstSync(after, before) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      return db.connections
        .filter(
          (connection) =>
            connection.status === "working" &&
            connection.last_synced_at === null &&
            connection.connected_at > after &&
            connection.connected_at < before,
        )
        .map((connection) => connection.id);
    },

    // Mirrors record_connection_sync(): a match keeps its choice and takes its present name.
    async recordConnectionSync(id, choices) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const connection = db.connections.find(
        (candidate) => candidate.id === id && syncs(candidate),
      );
      if (!connection) return false;
      connection.choices = choices.map((choice) => ({ ...choice }));
      connection.last_synced_at = db.now ?? timestamp();
      // A sync that succeeds mends one that had only kept failing.
      Object.assign(connection, { status: "working", broken_reason: null, broken_at: null });
      db.connectionHealth.delete(id);
      for (const match of connection.matches) {
        const now = choices.find((choice) => choice.id === match.external_id);
        if (now) match.external_label = now.label;
      }
      return true;
    },

    // Mirrors match_connection_location(), refusals and all.
    async matchConnectionLocation(connectionId, locationId, externalId) {
      const connection = db.connections.find((candidate) => candidate.id === connectionId);
      const location = db.locations.find((candidate) => candidate.id === locationId);
      if (
        !connection ||
        !managesOrg(connection.organization_id) ||
        location?.organization_id !== connection.organization_id
      ) {
        return null;
      }
      if (connection.status !== "working") {
        throw new StoreError("limit", "This account is not working or not connected any more.");
      }
      const choice = connection.choices.find((candidate) => candidate.id === externalId);
      if (!choice) throw new StoreError("limit", "That is not something this account reaches.");
      if (
        connection.matches.some(
          (match) => match.external_id === externalId && match.location_id !== locationId,
        )
      ) {
        throw new StoreError("limit", "That already belongs to another location.");
      }
      const elsewhere = db.connections.some(
        (other) =>
          other.id !== connectionId &&
          other.kind === connection.kind &&
          other.matches.some((match) => match.location_id === locationId),
      );
      if (elsewhere) {
        throw new StoreError(
          "limit",
          "This location is matched to another account of the same kind.",
        );
      }
      const match = {
        location_id: locationId,
        external_id: externalId,
        external_label: choice.label,
        matched_at: db.now ?? timestamp(),
      };
      connection.matches = [
        ...connection.matches.filter((kept) => kept.location_id !== locationId),
        match,
      ];
      return match;
    },

    async unmatchConnectionLocation(connectionId, locationId) {
      const connection = db.connections.find((candidate) => candidate.id === connectionId);
      if (!connection || !managesOrg(connection.organization_id)) return false;
      const kept = connection.matches.filter((match) => match.location_id !== locationId);
      const taken = kept.length < connection.matches.length;
      connection.matches = kept;
      return taken;
    },

    // Mirrors record_connection_failure(): refused breaks at once, the third failed day breaks.
    async recordConnectionFailure(id, refused) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const connection = db.connections.find((candidate) => candidate.id === id);
      if (!connection || (connection.status !== "working" && connection.status !== "broken")) {
        return null;
      }
      const now = db.now ?? new Date().toISOString();
      const health = db.connectionHealth.get(id) ?? {
        failed_days: 0,
        last_failed_on: null,
        told_at: null,
        reminded_at: null,
      };
      if (refused) {
        const breaks = connection.status === "working" || connection.broken_reason === "failing";
        Object.assign(connection, {
          status: "broken",
          broken_reason: "refused",
          broken_at: breaks ? now : connection.broken_at,
        });
        db.connectionHealth.set(
          id,
          breaks ? { ...health, told_at: null, reminded_at: null } : health,
        );
        return { status: "broken", newly_broken: breaks };
      }
      const today = now.slice(0, 10);
      const days = health.last_failed_on === today ? health.failed_days : health.failed_days + 1;
      const breaks = connection.status === "working" && days >= 3;
      if (breaks) {
        Object.assign(connection, { status: "broken", broken_reason: "failing", broken_at: now });
      }
      db.connectionHealth.set(id, { ...health, failed_days: days, last_failed_on: today });
      return { status: connection.status, newly_broken: breaks };
    },

    async markConnectionTold(id, which, at) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const health = db.connectionHealth.get(id) ?? {
        failed_days: 0,
        last_failed_on: null,
        told_at: null,
        reminded_at: null,
      };
      db.connectionHealth.set(
        id,
        which === "told" ? { ...health, told_at: at } : { ...health, reminded_at: at },
      );
    },

    async listBrokenConnectionsToRemind(before) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      return db.connections
        .filter((connection) => {
          const health = db.connectionHealth.get(connection.id);
          return (
            connection.status === "broken" &&
            health?.told_at != null &&
            health.told_at < before &&
            health.reminded_at === null
          );
        })
        .map((connection) => connection.id);
    },

    async listBrokenConnectionsUntold() {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      return db.connections
        .filter(
          (connection) =>
            connection.status === "broken" &&
            db.connectionHealth.get(connection.id)?.told_at == null,
        )
        .map((connection) => connection.id);
    },

    // Mirrors expire_paused_connections(): thirty days paused starts the removal.
    async expirePausedConnections() {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const now = db.now ?? new Date().toISOString();
      const before = new Date(Date.parse(now) - 30 * 86_400_000).toISOString();
      const expired = db.connections.filter(
        (connection) =>
          connection.status === "paused" &&
          connection.paused_at !== null &&
          connection.paused_at < before,
      );
      for (const connection of expired) {
        Object.assign(connection, {
          status: "removing",
          removal_reason: "plan",
          removal_requested_at: now,
        });
      }
      return expired.map((connection) => connection.id);
    },

    async listManagerEmails(organizationId) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      return db.memberships
        .filter((m) => m.organization_id === organizationId && m.role !== "member")
        .flatMap((m) => db.emails.get(m.user_id) ?? []);
    },

    async listLocationConnections(locationId) {
      if (!readsLocation(locationId)) return [];
      return db.connections.flatMap((connection) =>
        connection.matches
          .filter((match) => match.location_id === locationId)
          .map((match) => ({
            connection_id: connection.id,
            kind: connection.kind,
            label: connection.label,
            external_label: match.external_label,
          })),
      );
    },

    async listStalledRemovals(before) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      return db.connections
        .filter(
          (connection) =>
            connection.status === "removing" &&
            connection.removal_requested_at !== null &&
            connection.removal_requested_at < before,
        )
        .map((connection) => connection.id);
    },

    async getAllowanceUse(organizationId) {
      if (!readsOrg(organizationId)) return {};
      const prefix = `${organizationId}:`;
      const month = `:${(db.now ?? new Date().toISOString()).slice(0, 7)}`;
      return Object.fromEntries(
        [...db.allowanceUse]
          .filter(([key]) => key.startsWith(prefix) && key.endsWith(month))
          .map(([key, used]) => [key.slice(prefix.length, -month.length), used]),
      );
    },

    async claimAllowance(organizationId, kind, amount = 1) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      if (amount < 1) throw new StoreError("unexpected", "claimed one or more at a time");
      return takeAllowance(organizationId, kind, amount);
    },

    async applyPlan(organizationId, planKey, locations) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const plan = db.plans.find((candidate) => candidate.key === planKey);
      if (!plan) throw new StoreError("unexpected", `no plan called ${planKey}`);
      const organization = db.organizations.find((o) => o.id === organizationId);
      if (!organization) return null;
      const one = organization.surfaces?.length === 1 ? organization.surfaces : null;
      Object.assign(organization, {
        plan_key: plan.key,
        max_locations: Math.max(plan.included_locations, locations ?? 0),
        max_queries_per_location: plan.max_queries_per_location,
        max_manual_scans_per_month: plan.max_manual_scans_per_month,
        scan_every_days: plan.scan_every_days,
        emails_report: plan.emails_report,
        allowances: { ...plan.allowances },
        surfaces: plan.assistants >= 2 ? ["chatgpt", "claude"] : (one ?? ["chatgpt"]),
      });
      fitConnections(organizationId);
      return organization;
    },

    async renameOrganization(id, name) {
      const organization = db.organizations.find((o) => o.id === id && seesOrg(id));
      return organization ? Object.assign(organization, { name }) : null;
    },

    async setOrganizationLimits(id, limits) {
      if (!isOperator) return null;
      const organization = db.organizations.find((o) => o.id === id);
      if (!organization) return null;
      requireAllowances(db, limits.allowances);
      Object.assign(organization, limits, {
        allowances: { ...limits.allowances },
        plan_key: null,
      });
      fitConnections(id);
      return organization;
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
        allowances: db.testAccounts.has(userId) ? testAllowances(db) : {},
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
      requireAllowances(db, settings.allowances);
      // As the database function has it: no reduction on the spot where somebody pays, and
      // nothing an open announcement is going to lower may move meanwhile.
      const lowered = reductions(plan, settings);
      const down = Object.keys(lowered).length > 0;
      const paid = (await memoryStore(db, null).listPlanSubscribers(key)).length > 0;
      if (down && key !== "free" && paid) {
        throw new StoreError("limit", "What this plan allows can only be lowered with notice.");
      }
      const open = await this.getOpenLimitChange(key);
      const { allowances: heldKinds, ...heldLimits } = open?.lowered ?? {};
      const held =
        (Object.keys(heldLimits) as (keyof typeof heldLimits)[]).some(
          (field) => settings[field] !== plan[field],
        ) ||
        Object.keys(heldKinds ?? {}).some(
          (kind) => settings.allowances[kind] !== plan.allowances[kind],
        );
      if (held) throw new StoreError("limit", "A reduction has been announced for this plan.");
      if (down && key === "free") {
        const at = db.now ?? new Date().toISOString();
        db.limitChanges.push({
          id: crypto.randomUUID(),
          plan_key: key,
          lowered,
          effective_at: at,
          announced_at: at,
          reminded_at: null,
          called_off_at: null,
          completed_at: at,
        });
      }
      Object.assign(plan, settings, { allowances: { ...settings.allowances } });
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
      if (await this.getOpenPriceChange(key)) {
        throw new StoreError("limit", "A price change has been announced for this plan.");
      }
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

    async getOpenPriceChange(planKey) {
      return (
        db.priceChanges.find(
          (c) => c.plan_key === planKey && c.called_off_at === null && c.completed_at === null,
        ) ?? null
      );
    },

    async announcePriceChange(planKey, effectiveAt) {
      const plan = db.plans.find((candidate) => candidate.key === planKey);
      const ids = db.planPrices.get(planKey);
      if (!isOperator || !plan) return null;
      if (!ids?.base) throw new StoreError("limit", "This plan has no price to move anyone to.");
      if (await this.getOpenPriceChange(planKey)) {
        throw new StoreError("conflict", "price_changes_one_open");
      }
      // As the database function has it: anything dearer than a price it was sold at before.
      const goesUp = db.pastPrices.some(
        (v) =>
          v.plan_key === planKey &&
          (v.price_cents < plan.price_cents ||
            (v.extra_location_price_cents !== null &&
              (ids.extra === null ||
                v.extra_location_price_cents < (plan.extra_location_price_cents ?? 0)))),
      );
      const now = Date.parse(db.now ?? new Date().toISOString());
      if (goesUp && Date.parse(effectiveAt) < now + 30 * 86_400_000) {
        throw new StoreError("limit", "A price that goes up needs at least 30 days' notice.");
      }
      const change: PriceChange = {
        id: crypto.randomUUID(),
        plan_key: planKey,
        stripe_price_id: ids.base,
        effective_at: effectiveAt,
        announced_at: new Date(now).toISOString(),
        reminded_at: null,
        called_off_at: null,
        completed_at: null,
      };
      db.priceChanges.push(change);
      return change;
    },

    async callOffPriceChange(planKey) {
      const change = await this.getOpenPriceChange(planKey);
      const now = db.now ?? new Date().toISOString();
      if (!isOperator || !change || Date.parse(change.effective_at) <= Date.parse(now)) return null;
      return Object.assign(change, { called_off_at: now });
    },

    async listPlanSubscribers(planKey) {
      return db.organizations
        .filter(
          (o) =>
            o.plan_key === planKey &&
            !o.is_test &&
            readsOrg(o.id) &&
            db.subscriptions.get(o.id)?.stripe_subscription_id,
        )
        .map((organization) => organization.id);
    },

    async listOpenPriceChanges() {
      return db.priceChanges.filter((c) => c.called_off_at === null && c.completed_at === null);
    },

    async listPriceChangeNotices(priceChangeId) {
      if (userId !== null && !isOperator) return [];
      return db.priceChangeNotices.filter((notice) => notice.price_change_id === priceChangeId);
    },

    async getPriceChange(id) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      return db.priceChanges.find((change) => change.id === id) ?? null;
    },

    async recordPriceChangeNotice(priceChangeId, organizationId, done) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const kept = db.priceChangeNotices.find(
        (n) => n.price_change_id === priceChangeId && n.organization_id === organizationId,
      );
      if (kept) Object.assign(kept, done);
      else {
        db.priceChangeNotices.push({
          price_change_id: priceChangeId,
          organization_id: organizationId,
          announced_at: null,
          reminded_at: null,
          called_off_at: null,
          moved_at: null,
          skipped: null,
          ...done,
        });
      }
    },

    async markPriceChange(id, what, at) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const change = db.priceChanges.find((candidate) => candidate.id === id);
      if (change)
        Object.assign(change, what === "reminded" ? { reminded_at: at } : { completed_at: at });
    },

    async getOpenLimitChange(planKey) {
      return (
        db.limitChanges.find(
          (c) => c.plan_key === planKey && c.called_off_at === null && c.completed_at === null,
        ) ?? null
      );
    },

    async announceLimitChange(planKey, to, effectiveAt) {
      const plan = db.plans.find((candidate) => candidate.key === planKey);
      if (!isOperator || !plan) return null;
      requireAllowances(db, to.allowances);
      const lowered = reductions(plan, to);
      if (Object.keys(lowered).length === 0) {
        throw new StoreError("limit", "Nothing here is lower than what the plan allows now.");
      }
      const now = Date.parse(db.now ?? new Date().toISOString());
      if (Date.parse(effectiveAt) < now + 30 * 86_400_000) {
        throw new StoreError("limit", "A reduction needs at least 30 days' notice.");
      }
      if (await this.getOpenLimitChange(planKey)) {
        throw new StoreError("conflict", "limit_changes_one_open");
      }
      const change: LimitChange = {
        id: crypto.randomUUID(),
        plan_key: planKey,
        lowered,
        effective_at: effectiveAt,
        announced_at: new Date(now).toISOString(),
        reminded_at: null,
        called_off_at: null,
        completed_at: null,
      };
      db.limitChanges.push(change);
      return change;
    },

    async callOffLimitChange(planKey) {
      const change = await this.getOpenLimitChange(planKey);
      const now = db.now ?? new Date().toISOString();
      if (!isOperator || !change || Date.parse(change.effective_at) <= Date.parse(now)) return null;
      return Object.assign(change, { called_off_at: now });
    },

    async listPlanOrganizations(planKey) {
      return db.organizations
        .filter((o) => o.plan_key === planKey && !o.is_test && readsOrg(o.id))
        .map((organization) => organization.id);
    },

    async listOpenLimitChanges() {
      return db.limitChanges.filter((c) => c.called_off_at === null && c.completed_at === null);
    },

    async getLatestMadeLimitChange(planKey) {
      return (
        db.limitChanges.findLast((c) => c.plan_key === planKey && c.completed_at !== null) ?? null
      );
    },

    async listLimitChangeNotices(limitChangeId) {
      if (userId !== null && !isOperator) return [];
      return db.limitChangeNotices.filter((notice) => notice.limit_change_id === limitChangeId);
    },

    async getLimitChange(id) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      return db.limitChanges.find((change) => change.id === id) ?? null;
    },

    async recordLimitChangeNotice(limitChangeId, organizationId, done) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const kept = db.limitChangeNotices.find(
        (n) => n.limit_change_id === limitChangeId && n.organization_id === organizationId,
      );
      if (kept) Object.assign(kept, done);
      else {
        db.limitChangeNotices.push({
          limit_change_id: limitChangeId,
          organization_id: organizationId,
          announced_at: null,
          reminded_at: null,
          called_off_at: null,
          ...done,
        });
      }
    },

    async markLimitChangeReminded(id, at) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const change = db.limitChanges.find((candidate) => candidate.id === id);
      if (change) change.reminded_at = at;
    },

    async applyLimitChange(id) {
      if (userId !== null) throw new StoreError("forbidden", "worker only");
      const now = db.now ?? new Date().toISOString();
      const change = db.limitChanges.find(
        (c) =>
          c.id === id &&
          c.called_off_at === null &&
          c.completed_at === null &&
          Date.parse(c.effective_at) <= Date.parse(now),
      );
      const plan = db.plans.find((candidate) => candidate.key === change?.plan_key);
      if (!change || !plan) return false;
      const { allowances: kinds, ...limits } = change.lowered;
      for (const [field, { to }] of Object.entries(limits)) {
        Object.assign(plan, { [field]: to });
      }
      // A kind taken away leaves the set, and a smaller number replaces the larger.
      plan.allowances = Object.fromEntries(
        Object.entries(plan.allowances).flatMap(([kind, allowance]) => {
          const to = kinds?.[kind]?.to;
          return to === false ? [] : [[kind, to ?? allowance]];
        }),
      );
      for (const organization of db.organizations.filter((o) => o.plan_key === plan.key)) {
        await this.applyPlan(organization.id, plan.key, organization.max_locations);
      }
      change.completed_at = now;
      return true;
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
        what_we_do: input.what_we_do ?? null,
        id: crypto.randomUUID(),
        organization_id: organizationId,
        paused_by_plan: false,
        last_scanned_at: null,
        created_at: timestamp(),
      };
      db.locations.push(location);
      // As the trigger does: every location has a line from the moment it is made.
      db.visitLines.set(location.id, {
        key: crypto.randomUUID().replaceAll("-", ""),
        key_made_at: location.created_at,
        checked_on: null,
      });
      return location;
    },

    async getLocation(id) {
      return readableLocation(id) ?? null;
    },

    async updateLocation(id, input) {
      const location = visibleLocation(id);
      if (!location) return null;
      // As the database does: a detail the input leaves out is not written.
      const { what_we_do, ...rest } = input;
      return Object.assign(location, rest, what_we_do === undefined ? {} : { what_we_do });
    },

    async deleteLocation(id) {
      if (!seesLocation(id)) return false;
      db.locations = db.locations.filter((location) => location.id !== id);
      db.visitLines.delete(id);
      db.visits = db.visits.filter((counted) => counted.location_id !== id);
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

    async listResultsAround(locationId, at, scansBefore, scansSince, sampleData) {
      if (!readsLocation(locationId)) return { before: [], since: [] };
      const scans = db.scans
        .filter(
          (scan) =>
            scan.location_id === locationId &&
            scan.status === "succeeded" &&
            scan.sample_data === sampleData,
        )
        .reverse();
      const resultsOf = (list: Scan[]) =>
        list.map((scan) => db.results.filter((result) => result.scan_id === scan.id));
      return {
        before: resultsOf(scans.filter((scan) => scan.created_at < at).slice(0, scansBefore)),
        since: resultsOf(scans.filter((scan) => scan.created_at >= at).slice(0, scansSince)),
      };
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

    async setRecommendationActed(id, acted) {
      const recommendation = db.recommendations.find((candidate) => candidate.id === id);
      if (!recommendation || !seesLocation(recommendation.location_id)) return null;
      // Mirrors stamp_recommendation_acted(): what an action did stays marked.
      if (recommendation.acted_by_action) {
        throw new StoreError("limit", "Nearcited did this task, so it stays marked done.");
      }
      recommendation.acted_at = acted ? timestamp() : null;
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

    // Mirrors location_visits(): the days are counted back from the database's own today, and
    // only a reader of the location has anything to add up.
    async getLocationVisits(locationId, days) {
      const since = new Date(Date.parse(`${today()}T00:00:00Z`) - (days - 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const counted = readsLocation(locationId)
        ? db.visits.filter((kept) => kept.location_id === locationId && kept.day >= since)
        : [];
      const add = (into: Map<string, number>, key: string, count: number) =>
        into.set(key, (into.get(key) ?? 0) + count);
      const byDay = new Map<string, number>();
      const byPage = new Map<string, number>();
      for (const kept of counted) {
        add(byDay, `${kept.day}|${kept.assistant}`, kept.count);
        if (kept.path) add(byPage, kept.path, kept.count);
      }
      return {
        since,
        days: [...byDay]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, count]) => {
            const [day = "", assistant = ""] = key.split("|");
            return { day, assistant, count };
          }),
        pages: [...byPage]
          .map(([path, count]) => ({ path, count }))
          .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
          .slice(0, PAGES_SHOWN),
        other_pages: counted
          .filter((kept) => kept.path === "")
          .reduce((sum, kept) => sum + kept.count, 0),
      };
    },

    async getVisitLine(locationId) {
      const line = readsLocation(locationId) ? db.visitLines.get(locationId) : undefined;
      return line ? { location_id: locationId, ...line } : null;
    },

    // Mirrors replace_site_key(): an owner or an admin, and a new key has answered no check.
    async replaceSiteKey(locationId) {
      const location = db.locations.find((candidate) => candidate.id === locationId);
      const line = db.visitLines.get(locationId);
      if (!location || !line || !managesOrg(location.organization_id)) return null;
      Object.assign(line, {
        key: crypto.randomUUID().replaceAll("-", ""),
        key_made_at: db.now ?? timestamp(),
        checked_on: null,
      });
      return { location_id: locationId, ...line };
    },

    // Mirrors record_visit(): anyone holding the key, a page on the location's own site, a plan
    // that includes visits, and the day's ceilings.
    async recordVisit(visit) {
      const locationId = lineOf(visit.key, visit.host);
      const path = visit.path.split("?")[0]?.split("#")[0]?.slice(0, LONGEST_PATH) ?? "";
      if (!locationId || !path.startsWith("/")) return false;
      const day = today();
      const counted = db.visits.filter(
        (kept) => kept.location_id === locationId && kept.day === day,
      );
      if (counted.reduce((sum, kept) => sum + kept.count, 0) >= MOST_VISITS_A_DAY) return false;
      const pages = new Set(counted.map((kept) => kept.path).filter(Boolean));
      const under = pages.has(path) || pages.size < MOST_PAGES_A_DAY ? path : "";
      const kept = counted.find((row) => row.assistant === visit.assistant && row.path === under);
      if (kept) kept.count += 1;
      else {
        db.visits.push({
          location_id: locationId,
          day,
          assistant: visit.assistant,
          path: under,
          count: 1,
        });
      }
      return true;
    },

    // Mirrors check_visit_line().
    async checkVisitLine(line) {
      const locationId = lineOf(line.key, line.host);
      const kept = locationId ? db.visitLines.get(locationId) : undefined;
      if (!kept) return false;
      kept.checked_on = today();
      return true;
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
      // As complete_scan() does: a rule that fires again reopens unless it was dismissed, one
      // that stopped is done, and nothing here touches when a member said the work was done.
      const fired = new Set(outcome.recommendations.map((recommendation) => recommendation.rule));
      for (const derived of outcome.recommendations) {
        const existing = db.recommendations.find(
          (candidate) =>
            candidate.location_id === scan.location_id && candidate.rule === derived.rule,
        );
        if (existing) {
          Object.assign(existing, derived, {
            scan_id: id,
            status: existing.status === "done" ? "open" : existing.status,
          });
        } else {
          db.recommendations.push({
            ...derived,
            id: crypto.randomUUID(),
            location_id: scan.location_id,
            scan_id: id,
            status: "open",
            acted_at: null,
            acted_by_action: null,
            created_at: timestamp(),
          });
        }
      }
      for (const recommendation of db.recommendations) {
        if (
          recommendation.location_id === scan.location_id &&
          recommendation.status === "open" &&
          !fired.has(recommendation.rule)
        ) {
          recommendation.status = "done";
        }
      }
      // As complete_scan() does: clear this location's alerts that ended, then keep the new
      // ones, each once while one for the same thing is current.
      const at = timestamp();
      for (const cleared of outcome.alerts?.clear ?? []) {
        const alert = db.alerts.find(
          (candidate) =>
            candidate.id === cleared.id &&
            candidate.location_id === scan.location_id &&
            candidate.cleared_at === null,
        );
        if (alert) Object.assign(alert, { cleared_at: at, clear_reason: cleared.reason });
      }
      for (const { subject, ...raised } of outcome.alerts?.raise ?? []) {
        const current = db.alerts.some(
          (candidate) =>
            candidate.location_id === scan.location_id &&
            candidate.kind === raised.kind &&
            candidate.subject === subject &&
            candidate.sample_data === scan.sample_data &&
            candidate.cleared_at === null,
        );
        if (current) continue;
        db.alerts.push({
          ...raised,
          id: crypto.randomUUID(),
          location_id: scan.location_id,
          subject,
          sample_data: scan.sample_data,
          scan_id: id,
          raised_at: at,
          cleared_at: null,
          clear_reason: null,
          dismissed_at: null,
          dismissed_by_email: null,
          told_at: null,
          cleared_told_at: null,
        });
      }
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
