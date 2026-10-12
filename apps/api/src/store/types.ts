import type {
  AccountFacts,
  Action,
  ActionKind,
  AllowanceClaim,
  AllowanceUse,
  AuditInput,
  AuditJob,
  AuditPart,
  Connection,
  ConnectionChoice,
  ConnectionKind,
  ConnectionMatch,
  DerivedRecommendation,
  LimitChange,
  LimitChangeNotice,
  Location,
  LocationConnection,
  LocationInput,
  OperatorAudit,
  OperatorFacts,
  Organization,
  OrganizationLimits,
  Plan,
  PlanSettings,
  PlatformRole,
  PriceChange,
  PriceChangeNotice,
  ProviderUsage,
  Recommendation,
  RecommendationStatus,
  Scan,
  ScanResult,
  ScanTrigger,
  SiteCheck,
  StoredAudit,
  SubscriptionFact,
  Surface,
  TrackedQuery,
  TrackedQueryInput,
  UsageByMonth,
  WaitingActions,
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

/** One pair of prices a plan has been sold at, with the payment provider's names for them. */
export interface PriceVersion {
  /** A month, in US cents, for the locations the plan includes. */
  price_cents: number;
  /** A month, in US cents, for each location beyond those. Null when no more could be added. */
  extra_location_price_cents: number | null;
  stripe_price_id: string;
  stripe_extra_location_price_id: string | null;
}

/** An action for the worker to propose. */
export interface NewAction {
  location_id: string;
  kind: ActionKind;
  connection_id: string | null;
  /** What it is about, so the same thing is not proposed twice. */
  subject: string;
  /** A fingerprint of what the proposal rests on. */
  basis: string;
  summary: string;
  seen: { text: string | null } | null;
  proposed_text: string | null;
  written_by: "rule" | "model";
}

/** A connection to make: its sign-in is already sealed, to the ID given here. */
export interface NewConnection {
  id: string;
  organization_id: string;
  kind: ConnectionKind;
  label: string;
  sealed: string;
}

/** A plan as the payment provider knows it: what it is sold at now, and what it has been. */
export interface PlanPrices {
  key: string;
  on_sale: boolean;
  included_locations: number;
  /** What a new subscriber pays. Null for a plan that costs nothing, or is not set up yet. */
  current: PriceVersion | null;
  /** Every version it has been sold at, newest first, the current one among them. */
  versions: PriceVersion[];
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
  /** A location's actions, newest first, for whoever can read the location. */
  listLocationActions(locationId: string): Promise<Action[]>;
  /** How many actions wait for a yes at each of an organization's locations. */
  countWaitingActions(organizationId: string): Promise<WaitingActions>;
  /**
   * A member's yes to an action, with the text changed or not. Null for anyone who is not a
   * member of the location's organization. Throws a limit when it is no longer waiting.
   */
  approveAction(id: string, text?: string): Promise<Action | null>;
  /** A member's no, with a reason or without. Null for anyone who is not a member. */
  declineAction(id: string, reason?: string): Promise<Action | null>;
  /**
   * Asks for a failed action again: a new action, approved by whoever asked, that points at the
   * one that failed. Null for anyone who is not a member.
   */
  retryAction(id: string): Promise<Action | null>;
  /** An organization's connections, removed ones included, newest first. */
  listConnections(organizationId: string): Promise<Connection[]>;
  /** Whether the caller may connect and remove for the organization: its owner or an admin. */
  managesConnections(organizationId: string): Promise<boolean>;
  /**
   * Makes a connection with its sealed sign-in. The caller chooses the ID, because the sign-in
   * is sealed to it. Null for anyone but the organization's owner or an admin.
   */
  createConnection(connection: NewConnection): Promise<Connection | null>;
  /**
   * Asks for a connection to be removed: it stops being used at once, and the worker finishes
   * the job. Null for anyone but an owner or admin of its organization.
   */
  requestConnectionRemoval(id: string): Promise<Connection | null>;
  /**
   * Says which of a connection's choices is a location's, replacing what was said before. Null
   * for anyone but an owner or admin of the connection's organization, and for a location that
   * is not that organization's. Throws a limit, with the reason, for a choice the account does
   * not reach or that is already taken.
   */
  matchConnectionLocation(
    connectionId: string,
    locationId: string,
    externalId: string,
  ): Promise<ConnectionMatch | null>;
  /** Takes a location's match away. False when there was none, or the caller may not. */
  unmatchConnectionLocation(connectionId: string, locationId: string): Promise<boolean>;
  /** The connected accounts a location is matched to, for whoever can read the location. */
  listLocationConnections(locationId: string): Promise<LocationConnection[]>;
  /**
   * How much of each counted allowance an organization has used this calendar month (UTC), by
   * kind. A kind with none used is absent, and so is everything where the caller cannot read the
   * organization.
   */
  getAllowanceUse(organizationId: string): Promise<AllowanceUse>;
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
  /** Which organizations have a subscription, as far as the caller may read. */
  listEverySubscription(): Promise<SubscriptionFact[]>;
  /**
   * Changes what a plan allows, and copies it onto every organization on the plan. Only the
   * operator's call changes anything: for anyone else, and for a plan that does not exist, it
   * returns null.
   */
  setPlan(key: string, settings: PlanSettings): Promise<Plan | null>;
  /**
   * Sets what a new subscriber pays for a plan, keeping the version. The provider's prices are
   * made first and named here. Only the operator's call changes anything: for anyone else, and
   * for a plan that does not exist, it returns null.
   */
  setPlanPrices(key: string, version: PriceVersion): Promise<Plan | null>;
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

  /** The price change announced for a plan and still open, or null. Anyone signed in may ask. */
  getOpenPriceChange(planKey: string): Promise<PriceChange | null>;
  /**
   * Announces that a plan's current subscribers move to its present prices from `effectiveAt`.
   * Only the operator's call does anything: for anyone else, and for a plan that does not
   * exist, it returns null. Throws a limit, with the reason, when the day gives too little
   * notice, and a conflict when one is already open.
   */
  announcePriceChange(planKey: string, effectiveAt: string): Promise<PriceChange | null>;
  /** Calls off a plan's open price change before it takes effect. Null when there is none. */
  callOffPriceChange(planKey: string): Promise<PriceChange | null>;
  /** The organizations on a plan that have a subscription, as far as the caller may read. */
  listPlanSubscribers(planKey: string): Promise<string[]>;
  /** Every open price change, and what each has done so far. The operator's, and the worker's. */
  listOpenPriceChanges(): Promise<PriceChange[]>;
  listPriceChangeNotices(priceChangeId: string): Promise<PriceChangeNotice[]>;

  /** The reduction announced for a plan and not yet made, or null. Anyone signed in may ask. */
  getOpenLimitChange(planKey: string): Promise<LimitChange | null>;
  /**
   * Announces that what a plan allows goes down on `effectiveAt`. `to` is the plan's limits as
   * they would be; only what is lower than now is kept. Only the operator's call does anything:
   * for anyone else, and for a plan that does not exist, it returns null. Throws a limit, with
   * the reason, when the day gives too little notice or nothing is lower.
   */
  announceLimitChange(
    planKey: string,
    to: Pick<
      PlanSettings,
      | "max_queries_per_location"
      | "assistants"
      | "scan_every_days"
      | "max_manual_scans_per_month"
      | "emails_report"
      | "allowances"
    >,
    effectiveAt: string,
  ): Promise<LimitChange | null>;
  /** Calls off a plan's announced reduction before its day. Null when there is none. */
  callOffLimitChange(planKey: string): Promise<LimitChange | null>;
  /** The organizations on a plan, test ones left out, as far as the caller may read. */
  listPlanOrganizations(planKey: string): Promise<string[]>;
  /** Every reduction announced and not yet made. The operator's, and the worker's. */
  listOpenLimitChanges(): Promise<LimitChange[]>;
  /** The newest reduction for a plan that was made at once, if it was within the last hour. */
  getLatestMadeLimitChange(planKey: string): Promise<LimitChange | null>;
  listLimitChangeNotices(limitChangeId: string): Promise<LimitChangeNotice[]>;

  /**
   * A location's successful scans either side of a moment: the last `scansBefore` created before
   * it, and those created since, at most `scansSince` of the newest. One array per scan, newest
   * first, and only scans of the given kind.
   */
  listResultsAround(
    locationId: string,
    at: string,
    scansBefore: number,
    scansSince: number,
    sampleData: boolean,
  ): Promise<{ before: ScanResult[][]; since: ScanResult[][] }>;

  /** The on-page check from a location's latest successful scan, or null when it made none. */
  getSiteCheck(locationId: string): Promise<SiteCheck | null>;

  listRecommendations(locationId: string): Promise<Recommendation[]>;
  setRecommendationStatus(id: string, status: RecommendationStatus): Promise<Recommendation | null>;
  /**
   * Records that a member did the work a recommendation points at, or takes that back. The time
   * is the database's. Null when the caller cannot see the recommendation.
   */
  setRecommendationActed(id: string, acted: boolean): Promise<Recommendation | null>;

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
   * Proposes an action. Null when nothing was proposed: one for the same thing is waiting or on
   * its way, or one was declined and what it rests on has not changed. Worker only.
   */
  proposeAction(action: NewAction): Promise<Action | null>;
  /** One action, for whoever may read its location. The worker reads any. */
  getAction(id: string): Promise<Action | null>;
  /**
   * Takes an approved action to carry out. Says which try this is, counting from one, or zero
   * when it is not approved or the worker is already on it. Worker only.
   */
  claimAction(id: string): Promise<number>;
  /**
   * Keeps what became of carrying an action out. `again` lets go of it for another try. False
   * when it was not approved. Worker only.
   */
  finishAction(
    id: string,
    outcome: "done" | "failed" | "out_of_date" | "again",
    why?: string,
  ): Promise<boolean>;
  /** Lapses every proposal that has waited its fourteen days. Returns how many. Worker only. */
  lapseActions(): Promise<number>;
  /**
   * The actions approved before `before` that nobody is carrying out: their message was lost.
   * Worker only.
   */
  listStalledActions(before: string): Promise<string[]>;
  /** What one of the sample account's listings says. Worker only. */
  getSampleLine(connectionId: string, externalId: string): Promise<string | null>;
  setSampleLine(connectionId: string, externalId: string, line: string): Promise<void>;
  /** One connection, for whoever may read its organization. The worker reads any. */
  getConnection(id: string): Promise<Connection | null>;
  /**
   * A connection's sign-in, as the Worker sealed it. Worker only: no member and no operator can
   * read one. Null when there is none.
   */
  getConnectionSecret(id: string): Promise<string | null>;
  /**
   * Finishes a removal that was asked for: deletes the sign-in and marks the connection removed.
   * Worker only. False when none was waiting.
   */
  finishConnectionRemoval(id: string): Promise<boolean>;
  /** The connections asked to be removed before `before` and not finished. Worker only. */
  listStalledRemovals(before: string): Promise<string[]>;
  /**
   * The working connections to sync now: never synced, or last synced most of a day ago,
   * longest-waiting first. Worker only.
   */
  listConnectionsDueForSync(limit: number): Promise<string[]>;
  /**
   * The working connections made between `after` and `before` that have never been synced: the
   * ones whose first sync was lost. Worker only.
   */
  listConnectionsAwaitingFirstSync(after: string, before: string): Promise<string[]>;
  /**
   * Keeps what a sync found: what the sign-in reaches. It also mends a connection that had only
   * kept failing. Worker only. False for any other connection that is not working, which is
   * left as it is.
   */
  recordConnectionSync(id: string, choices: ConnectionChoice[]): Promise<boolean>;
  /**
   * Keeps that a sync failed. A refused sign-in breaks the connection at once; any other failure
   * counts one for the day, and the third day in a row breaks it. Says where it stands and
   * whether this broke it. Null for a connection that is neither working nor broken. Worker only.
   */
  recordConnectionFailure(
    id: string,
    refused: boolean,
  ): Promise<{ status: Connection["status"]; newly_broken: boolean } | null>;
  /** Keeps that a broken connection's owners and admins were told, or reminded. Worker only. */
  markConnectionTold(id: string, which: "told" | "reminded", at: string): Promise<void>;
  /**
   * The broken connections whose owners were told before `before` and have not been reminded.
   * Worker only.
   */
  listBrokenConnectionsToRemind(before: string): Promise<string[]>;
  /**
   * The broken connections whose owners have not been told: the email could not be sent when it
   * broke, or there was nobody to send it to. Worker only.
   */
  listBrokenConnectionsUntold(): Promise<string[]>;
  /**
   * Starts the removal of every connection paused for thirty days, and returns them for the
   * worker to finish. Worker only.
   */
  expirePausedConnections(): Promise<string[]>;
  /**
   * The addresses of an organization's owners and admins: who is told when a connection breaks.
   * Worker only.
   */
  listManagerEmails(organizationId: string): Promise<string[]>;
  /**
   * Takes `amount` of one kind of allowance from an organization's month, if there is room, and
   * says what happened. Null when there is no such organization. Worker only: a member cannot
   * use up an allowance without the work it is for being done.
   */
  claimAllowance(
    organizationId: string,
    kind: string,
    amount?: number,
  ): Promise<AllowanceClaim | null>;
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
  /**
   * Claims the thanks for a subscription starting, so it is said once however many times the
   * provider reports it. True for the first caller for that subscription and false after, and
   * false for an organization with no subscription kept. Worker only.
   */
  claimSubscriptionStart(organizationId: string, subscriptionId: string): Promise<boolean>;
  /** A price change by its ID, open or not. Worker only. */
  getPriceChange(id: string): Promise<PriceChange | null>;
  /**
   * Keeps what a price change has just done for an organization: the fields given are set and
   * the rest left as they were. Worker only.
   */
  recordPriceChangeNotice(
    priceChangeId: string,
    organizationId: string,
    done: Partial<Omit<PriceChangeNotice, "price_change_id" | "organization_id">>,
  ): Promise<void>;
  /** Marks a price change's reminders as queued, or the change as finished. Worker only. */
  markPriceChange(id: string, what: "reminded" | "completed", at: string): Promise<void>;
  /** A reduction by its ID, made or not. Worker only. */
  getLimitChange(id: string): Promise<LimitChange | null>;
  /** Keeps that an organization was just told something about a reduction. Worker only. */
  recordLimitChangeNotice(
    limitChangeId: string,
    organizationId: string,
    done: Partial<Omit<LimitChangeNotice, "limit_change_id" | "organization_id">>,
  ): Promise<void>;
  /** Marks a reduction's reminders as queued. Worker only. */
  markLimitChangeReminded(id: string, at: string): Promise<void>;
  /**
   * Makes a reduction whose day has come, for the plan and everyone on it. False when there was
   * nothing to make yet. Worker only.
   */
  applyLimitChange(id: string): Promise<boolean>;
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
