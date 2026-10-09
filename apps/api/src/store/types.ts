import type {
  AccountFacts,
  AuditJob,
  AuditPart,
  DerivedRecommendation,
  Location,
  LocationInput,
  OperatorAudit,
  OperatorFacts,
  Organization,
  OrganizationLimits,
  PlatformRole,
  ProviderUsage,
  Recommendation,
  RecommendationStatus,
  Scan,
  ScanResult,
  ScanTrigger,
  SiteCheck,
  StoredAudit,
  TrackedQuery,
  TrackedQueryInput,
} from "@nearcited/shared";

/** A scan as the operator's overview reads it: what happened, and what it found of the website. */
export type OperatorScan = OperatorFacts["scans"][number];
/** An audit as it is listed for the operator, before its token is turned into a link. */
export type ListedAudit = Omit<OperatorAudit, "link"> & { token: string };

/** What a set of usage is for: a scan of an organization's location, or an audit. */
export type UsageSource = { organization_id: string; scan_id: string } | { audit_id: string };

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
  renameOrganization(id: string, name: string): Promise<Organization | null>;
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
  listEveryAudit(): Promise<ListedAudit[]>;
  /** Every account, from the one function that may read the sign-in table. */
  listAccounts(): Promise<AccountFacts["accounts"][number][]>;
  listEveryMembership(): Promise<{ user_id: string; organization_id: string }[]>;
  /** Every account's platform role, by account ID. */
  listPlatformRoles(): Promise<Record<string, PlatformRole>>;
  createLocation(organizationId: string, input: LocationInput): Promise<Location>;
  getLocation(id: string): Promise<Location | null>;
  /** Replaces every field a user may set. Null when the caller cannot see the location. */
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
