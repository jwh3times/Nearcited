import type {
  AuditJob,
  AuditPart,
  DerivedRecommendation,
  Location,
  LocationInput,
  Organization,
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

  listLocations(organizationId: string): Promise<Location[]>;
  createLocation(organizationId: string, input: LocationInput): Promise<Location>;
  getLocation(id: string): Promise<Location | null>;
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
