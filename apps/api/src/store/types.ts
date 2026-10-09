import type {
  AccountFacts,
  AuditInput,
  AuditJob,
  AuditPart,
  DerivedRecommendation,
  Location,
  LocationInput,
  OperatorAudit,
  OperatorFacts,
  Organization,
  OrganizationLimits,
  Plan,
  PlatformRole,
  ProviderUsage,
  Recommendation,
  RecommendationStatus,
  Scan,
  ScanResult,
  ScanTrigger,
  SiteCheck,
  StoredAudit,
  Surface,
  TrackedQuery,
  TrackedQueryInput,
  UsageByMonth,
} from "@nearcited/shared";

/** A scan as the operator's overview reads it: what happened, and what it found of the website. */
export type OperatorScan = OperatorFacts["scans"][number];
/** An audit as it is listed for the operator, before its token is turned into a link. */
export type ListedAudit = Omit<OperatorAudit, "link"> & { token: string };

/** What a set of usage is for: a scan of an organization's location, or an audit. */
export type UsageSource = { organization_id: string; scan_id: string } | { audit_id: string };

/** What the payment provider knows about an organization, as its owner's checkout needs it. */
export interface BillingState {
  organization_id: string;
  is_test: boolean;
  plan_key: string | null;
  /** Null until the organization has been through checkout. */
  stripe_customer_id: string | null;
  /** Null when it has never subscribed, or its subscription has ended. */
  stripe_subscription_id: string | null;
  /** The provider's own word for the subscription: active, past_due, canceled and so on. */
  status: string | null;
}

/** What the worker keeps of a subscription. */
export interface SubscriptionRecord {
  stripe_customer_id: string;
  /** Null once a subscription has ended and before another starts. */
  stripe_subscription_id: string | null;
  status: string | null;
}

/** A plan as the payment provider knows it: the two prices it is sold at there. */
export interface PlanPrices {
  key: string;
  on_sale: boolean;
  included_locations: number;
  /** Null until the plan is set up at the provider, and always for a plan that costs nothing. */
  stripe_price_id: string | null;
  /** For each location beyond those included. Null when no more can be added. */
  stripe_extra_location_price_id: string | null;
}

/** "limit" is a usage cap reached. Its message is written for the user and safe to show. */
export type StoreErrorKind = "conflict" | "forbidden" | "limit" | "unexpected";

export class StoreError extends Error {
  constructor(
    readonly kind: StoreErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StoreError";
  }
}

export type NewScanResult = Omit<ScanResult, "id" | "scan_id" | "sampled_at">;

export interface CompletedScan {
  score: number | null;
  results: NewScanResult[];
  recommendations: DerivedRecommendation[];
  /** The on-page check this scan made, or null when it made none. Kept with the scan. */
  site?: SiteCheck | null;
}

/**
 * Everything the API and the scan worker need from the database.
 *
 * A store is bound to an identity. One made for a signed-in user only ever sees that user's
 * organizations, because Postgres enforces it; reads of someone else's rows come back empty
 * rather than erroring. One made with the secret key sees everything and is the only kind that
 * can call the worker methods.
 */
export interface Store {
  listOrganizations(): Promise<Organization[]>;
  createOrganization(name: string): Promise<Organization>;
  getOrganization(id: string): Promise<Organization | null>;

  /**
   * Renames an organization. Null when the caller may not: they are not in it, or are a plain
   * member, and only its owners and admins change it.
   */
  /**
   * The plans the caller may read, cheapest first: everything on sale, plus the one their own
   * organization is on if that has been taken off sale. Needs no sign-in.
   */
  listPlans(): Promise<Plan[]>;
  renameOrganization(id: string, name: string): Promise<Organization | null>;
  /**
   * How many scans by hand count against the organization's plan this calendar month (UTC).
   * Null for an organization the caller cannot read.
   */
  getManualScansUsed(organizationId: string): Promise<number | null>;
  /** The plans the caller may read, with the payment provider's names for their prices. */
  listPlanPrices(): Promise<PlanPrices[]>;
  /**
   * What the payment provider knows about an organization. Only its owner's call is answered:
   * for anyone else, the operator included, it returns null.
   */
  getBillingState(organizationId: string): Promise<BillingState | null>;
  /**
   * Sets which assistants an organization is checked on, within what its plan covers. Only its
   * owner's call changes anything: for anyone else it returns null. Throws a limit, with a
   * message for the owner, when the choice is not one the plan allows.
   */
  chooseAssistants(id: string, surfaces: readonly Surface[]): Promise<Organization | null>;
  /**
   * Changes an organization's limits. Only the operator's call changes anything: for anyone else,
   * and for an organization that does not exist, it returns null.
   */
  setOrganizationLimits(id: string, limits: OrganizationLimits): Promise<Organization | null>;
  listLocations(organizationId: string): Promise<Location[]>;

  /** What the account is to the product itself, or null. An account reads its own. */
  getPlatformRole(userId: string): Promise<PlatformRole | null>;

  // The operator's reads. Each returns every row the caller may read, which for the operator is
  // every row there is and for anyone else only their own, so a route must check the role first.
  listEveryOrganization(): Promise<Organization[]>;
  listEveryLocation(): Promise<Location[]>;
  /** How many active prompts and keywords each location has, by location ID. */
  countActiveQueries(): Promise<Record<string, number>>;
  /** Scans created since `since`, an ISO timestamp, each with the on-page check it made. */
  listScansSince(since: string): Promise<OperatorScan[]>;
  /** Every audit, newest first, with the token that makes its link. */
  /**
   * What was used at the providers since `since` (an ISO timestamp), added up by calendar month
   * in UTC. Everything for the operator; nothing for anyone else.
   */
  listUsageByMonth(since: string): Promise<UsageByMonth[]>;
  listEveryAudit(): Promise<ListedAudit[]>;
  /**
   * Makes a shareable audit, still to be queued. Only the operator's call makes one: for anyone
   * else it returns null.
   */
  createAudit(input: AuditInput): Promise<ListedAudit | null>;
  /** Every account, from the one function that may read the sign-in table. */
  listAccounts(): Promise<AccountFacts["accounts"][number][]>;
  listEveryMembership(): Promise<{ user_id: string; organization_id: string }[]>;
  /** Every account's platform role, by account ID. */
  listPlatformRoles(): Promise<Record<string, PlatformRole>>;
  createLocation(organizationId: string, input: LocationInput): Promise<Location>;
  getLocation(id: string): Promise<Location | null>;
  /** Replaces every field a user may set. Null when the caller cannot see the location. */
  /**
   * Brings a location paused by the plan back into use. When the plan has no room, `insteadOf`
   * names the location in use that is paused in its place; without one that is a limit error.
   * Null for a location the caller cannot reach.
   */
  activateLocation(id: string, insteadOf?: string | null): Promise<Location | null>;
  updateLocation(id: string, input: LocationInput): Promise<Location | null>;
  deleteLocation(id: string): Promise<boolean>;

  listQueries(locationId: string): Promise<TrackedQuery[]>;
  createQuery(locationId: string, input: TrackedQueryInput): Promise<TrackedQuery>;
  /** Retires a prompt or restores it. Its results are kept either way. */
  setQueryActive(id: string, active: boolean): Promise<TrackedQuery | null>;

  /** Throws a conflict when the location already has a scan queued or running. */
  createScan(locationId: string, trigger: ScanTrigger, requestedBy: string | null): Promise<Scan>;
  listScans(locationId: string, limit: number): Promise<Scan[]>;
  getScan(id: string): Promise<Scan | null>;
  listScanResults(scanId: string): Promise<ScanResult[]>;
  /**
   * The results of a location's most recent successful scans, one array per scan, newest first.
   * Only scans of the given kind: sample scans and real ones are never mixed in one window.
   */
  listRecentResults(
    locationId: string,
    scans: number,
    sampleData: boolean,
  ): Promise<ScanResult[][]>;

  /** The on-page check from a location's latest successful scan, or null when it made none. */
  getSiteCheck(locationId: string): Promise<SiteCheck | null>;

  listRecommendations(locationId: string): Promise<Recommendation[]>;
  setRecommendationStatus(id: string, status: RecommendationStatus): Promise<Recommendation | null>;

  /**
   * A shareable audit by the token in its link, or null when there is none, or it has been
   * revoked or has expired. Works for any caller, signed in or not: holding the link is the
   * permission.
   */
  getAuditByToken(token: string): Promise<StoredAudit | null>;

  // Worker only: these need the secret key.
  getAudit(id: string): Promise<AuditJob | null>;
  recordAuditPart(id: string, promptIndex: number, part: AuditPart): Promise<void>;
  failAudit(id: string, error: string): Promise<void>;
  /**
   * Fails every audit that is still queued and was created before `olderThan`, an ISO timestamp.
   * Returns how many. The prompts that did report are kept.
   */
  failStaleAudits(olderThan: string, error: string): Promise<number>;
  /**
   * Keeps what a scan, or one prompt of an audit, used at the providers. Worker only. Called
   * whether or not the scan went on to succeed: what was asked was charged for either way.
   */
  /**
   * Puts an organization on a plan and copies the plan's limits onto it. `locations` is how many
   * it has paid for, when that is more than the plan includes. Null when there is no such
   * organization. Worker only: nothing a member sends decides their plan.
   */
  applyPlan(
    organizationId: string,
    planKey: string,
    locations?: number,
  ): Promise<Organization | null>;
  /** What is kept of an organization's subscription, or null when it has never had one. Worker only. */
  getSubscription(organizationId: string): Promise<SubscriptionRecord | null>;
  /** Keeps what the payment provider last said about an organization's subscription. Worker only. */
  recordSubscription(organizationId: string, subscription: SubscriptionRecord): Promise<void>;
  recordUsage(source: UsageSource, usage: readonly ProviderUsage[]): Promise<void>;
  /** Throws a conflict when a different scan for the same location is already in flight. */
  markScanRunning(id: string, sampleData: boolean): Promise<void>;
  completeScan(id: string, outcome: CompletedScan): Promise<void>;
  failScan(id: string, error: string): Promise<void>;
  /**
   * Fails every scan that has been queued since before `olderThan`, or running since before it.
   * Returns how many. `olderThan` is an ISO timestamp.
   */
  failStaleScans(olderThan: string, error: string): Promise<number>;
  listLocationsDueForScan(limit: number): Promise<string[]>;
  listOwnerEmails(organizationId: string): Promise<string[]>;
}
