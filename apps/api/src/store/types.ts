import type {
  DerivedRecommendation,
  Location,
  LocationInput,
  Organization,
  Recommendation,
  RecommendationStatus,
  Scan,
  ScanResult,
  ScanTrigger,
  TrackedQuery,
  TrackedQueryInput,
} from "@nearcited/shared";

export type StoreErrorKind = "conflict" | "forbidden" | "unexpected";

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

  listLocations(organizationId: string): Promise<Location[]>;
  createLocation(organizationId: string, input: LocationInput): Promise<Location>;
  getLocation(id: string): Promise<Location | null>;
  deleteLocation(id: string): Promise<boolean>;

  listQueries(locationId: string): Promise<TrackedQuery[]>;
  createQuery(locationId: string, input: TrackedQueryInput): Promise<TrackedQuery>;
  deleteQuery(id: string): Promise<boolean>;

  createScan(locationId: string, trigger: ScanTrigger, requestedBy: string | null): Promise<Scan>;
  listScans(locationId: string, limit: number): Promise<Scan[]>;
  getScan(id: string): Promise<Scan | null>;
  listScanResults(scanId: string): Promise<ScanResult[]>;

  listRecommendations(locationId: string): Promise<Recommendation[]>;
  setRecommendationStatus(id: string, status: RecommendationStatus): Promise<Recommendation | null>;

  // Worker only: these need the secret key.
  markScanRunning(id: string): Promise<void>;
  completeScan(id: string, outcome: CompletedScan): Promise<void>;
  failScan(id: string, error: string): Promise<void>;
  listLocationsDueForScan(limit: number): Promise<string[]>;
  listOwnerEmails(organizationId: string): Promise<string[]>;
}
