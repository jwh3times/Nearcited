import {
  ACTION_KINDS,
  AccountExportSchema,
  ActionSchema,
  AlertSchema,
  AllowanceClaimSchema,
  AllowancesSchema,
  AllowanceUseSchema,
  ANSWER_RECORDS,
  AuditJobSchema,
  CITING_SURFACES,
  CitedPageSchema,
  ConnectionMatchSchema,
  ConnectionSchema,
  DraftSchema,
  type Invitation,
  InvitationSchema,
  LimitChangeSchema,
  ListingSchema,
  LocationAnalyticsVisitsSchema,
  LocationConnectionSchema,
  LocationFetchesSchema,
  LocationSchema,
  LocationVisitsSchema,
  MemberRoleSchema,
  MemberSchema,
  MOST_INVITATIONS_LISTED,
  MyInvitationSchema,
  OperatorAuditSchema,
  OrganizationSchema,
  PageFetchesSchema,
  PlanSchema,
  type PlatformRole,
  PlatformRoleSchema,
  PriceChangeSchema,
  PromptPageSchema,
  RecommendationSchema,
  ScanResultSchema,
  ScanSchema,
  SiteCheckSchema,
  STANDING_PERMISSION_AFTER,
  STRONGER_MODELS_ALLOWANCE,
  StandingPermissionSchema,
  StoredAuditSchema,
  TrackedQuerySchema,
  UsageByMonthSchema,
  VisitLineSchema,
} from "@nearcited/shared";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Env } from "../env";
import { PAGE_SIZE, type ReadPage, readEvery } from "./paging";
import { type KeptAnswerSubdomain, type Store, StoreError, type StoreErrorKind } from "./types";

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

/**
 * A client for a caller who is not signed in. It can reach only what the database grants the
 * anonymous role, which is the one function that looks an audit up by its token.
 */
export function createAnonClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, clientOptions);
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
  // Raised by the usage-cap triggers, each with a message written for the user.
  NC001: "limit", // locations per organization
  NC002: "limit", // active prompts per location
  NC003: "limit", // manual scans per month
  NC004: "limit", // a choice of assistants the plan does not allow
  NC005: "limit", // a location paused by the plan, or no room to bring one back
  NC006: "limit", // a second organization for one account
  NC007: "limit", // taking the free plan off sale
  NC008: "limit", // a price for the free plan
  NC009: "limit", // a price change that cannot be announced, or prices changed while one is open
  NC010: "limit", // a reduction that needs announcing, cannot be, or is held while one is open
  NC011: "limit", // an allowance of a kind that does not exist, or a value its kind does not take
  NC012: "limit", // a match a connection cannot take: not reached, already taken, or not working
  NC013: "limit", // an action that is no longer waiting or cannot be asked for, or a task one did
  NC014: "limit", // a draft asked for when the month has no more
  NC015: "limit", // a listing on one site more than a location may hold
  NC016: "limit", // who is in an organization: no owner left, already in or invited, too many
};

function fail(action: string, error: DbError): never {
  const kind = ERROR_KINDS[error.code ?? ""] ?? "unexpected";
  // A limit's message goes to the user as it is. Anything else is for the logs.
  const message = kind === "limit" ? error.message : `${action}: ${error.message}`;
  throw new StoreError(kind, message, { cause: error });
}

/** What an owner reads of an invitation. */
const INVITATION_COLUMNS =
  "id, organization_id, email, role, invited_by_email, created_at, sent_at, expires_at, ended_at, outcome";

/** What a member may read of an answer subdomain. */
const ANSWER_SUBDOMAIN_SHOWN =
  "connection_id, organization_id, location_id, hostname, target, record, checked_at, registered_at, live_at, home_links";
/** Its connection's standing, read with it. */
const ANSWER_SUBDOMAIN_STANDING =
  "connection:connections!inner(connected_at, status, paused_at, removal_reason, removed_at)";

const AnswerSubdomainRowSchema = z.object({
  connection_id: z.uuid(),
  organization_id: z.uuid(),
  location_id: z.uuid().nullable(),
  hostname: z.string(),
  target: z.string(),
  record: z.enum(ANSWER_RECORDS).nullable(),
  checked_at: z.string().nullable(),
  cloudflare_id: z.string().nullable(),
  registered_at: z.string().nullable(),
  live_at: z.string().nullable(),
  live_told_at: z.string().nullable(),
  home_links: z.boolean().nullable(),
  connection: ConnectionSchema.pick({
    connected_at: true,
    status: true,
    paused_at: true,
    removal_reason: true,
    removed_at: true,
  }),
});

/** An answer subdomain as the store returns one, its connection's standing beside it. */
const keptAnswerSubdomain = ({
  connection,
  ...row
}: z.infer<typeof AnswerSubdomainRowSchema>): KeptAnswerSubdomain => ({ ...row, ...connection });

/** A hosted page as the worker reads it. */
const HostedPageRowSchema = z.object({
  id: z.uuid(),
  connection_id: z.uuid(),
  location_id: z.uuid(),
  recommendation_id: z.uuid().nullable(),
  action_id: z.uuid().nullable(),
  slug: z.string(),
  title: z.string(),
  copy: z.string(),
  published_at: z.string(),
  taken_back_at: z.string().nullable(),
});

/** The rows the operator's overview reads, as the database returns them. */
const OperatorScanSchema = ScanSchema.pick({
  id: true,
  location_id: true,
  status: true,
  trigger: true,
  error: true,
  sample_data: true,
  created_at: true,
}).extend({ site_check: SiteCheckSchema.nullable() });

const ListedAuditSchema = OperatorAuditSchema.omit({ link: true }).extend({ token: z.string() });

const AccountRowSchema = z.object({
  user_id: z.uuid(),
  email: z.string().nullable(),
  created_at: z.string(),
  last_sign_in_at: z.string().nullable(),
});

const PLAN_COLUMNS =
  "key, name, position, on_sale, price_cents, included_locations, extra_location_price_cents, max_queries_per_location, assistants, scan_every_days, max_manual_scans_per_month, emails_report, stronger_price_cents, allowances";

const PLAN_PRICE_COLUMNS = "key, on_sale, included_locations, stripe_price_id, allowances";
const PlanPriceRowSchema = z.object({
  key: z.string(),
  on_sale: z.boolean(),
  included_locations: z.number().int().positive(),
  stripe_price_id: z.string().nullable(),
  allowances: AllowancesSchema,
});

const PRICE_VERSION_COLUMNS =
  "plan_key, price_cents, extra_location_price_cents, stripe_price_id, stripe_extra_location_price_id, stronger_price_cents, stripe_stronger_chatgpt_price_id, stripe_stronger_claude_price_id";
const PriceVersionRowSchema = z
  .object({
    plan_key: z.string(),
    price_cents: z.number().int().positive(),
    extra_location_price_cents: z.number().int().positive().nullable(),
    stripe_price_id: z.string(),
    stripe_extra_location_price_id: z.string().nullable(),
    stronger_price_cents: z.number().int().positive().nullable(),
    stripe_stronger_chatgpt_price_id: z.string().nullable(),
    stripe_stronger_claude_price_id: z.string().nullable(),
  })
  .transform(
    ({
      stripe_stronger_chatgpt_price_id: chatgpt,
      stripe_stronger_claude_price_id: claude,
      ...version
    }) => ({
      ...version,
      // The database keeps all three or none.
      stripe_stronger_price_ids: chatgpt && claude ? { chatgpt, claude } : null,
    }),
  );

const PRICE_CHANGE_COLUMNS =
  "id, plan_key, stripe_price_id, effective_at, announced_at, reminded_at, called_off_at, completed_at";

const NOTICE_COLUMNS =
  "price_change_id, organization_id, announced_at, reminded_at, called_off_at, moved_at, skipped";
const NoticeSchema = z.object({
  price_change_id: z.uuid(),
  organization_id: z.uuid(),
  announced_at: z.string().nullable(),
  reminded_at: z.string().nullable(),
  called_off_at: z.string().nullable(),
  moved_at: z.string().nullable(),
  skipped: z.string().nullable(),
});

const LIMIT_CHANGE_COLUMNS =
  "id, plan_key, lowered, effective_at, announced_at, reminded_at, called_off_at, completed_at";

const LIMIT_NOTICE_COLUMNS =
  "limit_change_id, organization_id, announced_at, reminded_at, called_off_at";
const LimitNoticeSchema = z.object({
  limit_change_id: z.uuid(),
  organization_id: z.uuid(),
  announced_at: z.string().nullable(),
  reminded_at: z.string().nullable(),
  called_off_at: z.string().nullable(),
});

const ManualScansSchema = z.object({
  manual_scans_month: z.string().nullable(),
  manual_scans_used: z.number().int().nonnegative(),
});

// Never the fingerprint: only the database compares it.
const CLOSING_COLUMNS =
  "id, organization_id, organization_name, owner_id, owner_email, member_emails, asked_at, cancelled_at, had_subscription, left_at_sites, hostnames, organization_deleted_at, account_deleted_at, told_at, noted_at, finished_at";
const ClosingSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  organization_name: z.string().nullable(),
  owner_id: z.uuid().nullable(),
  owner_email: z.string().nullable(),
  member_emails: z.array(z.string()),
  asked_at: z.string(),
  cancelled_at: z.string().nullable(),
  had_subscription: z.boolean(),
  left_at_sites: z.array(z.string()),
  hostnames: z.array(z.string()),
  organization_deleted_at: z.string().nullable(),
  account_deleted_at: z.string().nullable(),
  told_at: z.string().nullable(),
  noted_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});
const ClosingAskedRowSchema = z.object({
  closing_id: z.uuid().nullable(),
  refused: z.enum(["owners_only", "not_closable", "name_mismatch"]).nullable(),
});

const SUBSCRIPTION_COLUMNS = "stripe_customer_id, stripe_subscription_id, status";
const SubscriptionRecordSchema = z.object({
  stripe_customer_id: z.string(),
  stripe_subscription_id: z.string().nullable(),
  status: z.string().nullable(),
});
const BillingStateSchema = z.object({
  organization_id: z.uuid(),
  is_test: z.boolean(),
  plan_key: z.string().nullable(),
  stripe_customer_id: z.string().nullable(),
  stripe_subscription_id: z.string().nullable(),
  status: z.string().nullable(),
});

const LISTED_AUDIT_COLUMNS =
  "id, token, business_name, city, region, status, error, created_at, expires_at, revoked_at";

const ORGANIZATION_COLUMNS =
  "id, name, max_locations, max_queries_per_location, max_manual_scans_per_month, scan_every_days, surfaces, stronger_surfaces, is_test, emails_report, allowances, plan_key, created_at";

// What a member is sent of an action. `subject` and `basis` are the worker's own bookkeeping.
const ACTION_COLUMNS =
  "id, location_id, kind, connection_id, summary, seen, seen_dropped_at, proposed_text, written_by, status, proposed_at, lapses_at, approved_by_email, approved_at, approved_text, declined_by_email, declined_at, decline_reason, done_at, failed_at, failure, lapsed_at, lapse_reason, retry_of, takes_back, approved_under, approved_under_by_email, approved_under_at, always_asks";

const STANDING_PERMISSION_COLUMNS =
  "id, kind, given_by_email, given_at, ended_at, ended_by_email, end_reason, ended_by_action";

const DRAFT_COLUMNS =
  "id, location_id, recommendation_id, status, asked_by_email, asked_at, failure, kind, text, written_at, sample_data";

const LISTING_COLUMNS = "location_id, site, url, set_by_email, set_at";
const PROMPT_PAGE_COLUMNS = "recommendation_id, url, set_by_email, set_at, action_id";

const LINE_COLUMNS = "location_id, key, key_made_at, checked_on";

const ALERT_COLUMNS =
  "id, location_id, kind, tracked_query_id, surface, tier, facts, since, scan_id, raised_at, cleared_at, clear_reason, dismissed_at, dismissed_by_email";

// Never the sign-in: that is in another table, which only the worker reads.
const CONNECTION_COLUMNS =
  "id, organization_id, kind, label, status, connected_by_email, connected_at, removed_by_email, removal_requested_at, removed_at, broken_reason, broken_at, paused_at, removal_reason, last_synced_at, choices, matches:connection_locations(location_id, external_id, external_label, matched_at)";
const CONNECTION_MATCH_COLUMNS = "location_id, external_id, external_label, matched_at";

const LOCATION_COLUMNS =
  "id, organization_id, name, website, phone, address_line, city, region, postal_code, country_code, google_place_id, latitude, longitude, point_source, geocoded_from, primary_category, what_we_do, paused_by_plan, last_scanned_at, created_at";
const SCAN_COLUMNS =
  "id, location_id, status, trigger, visibility_score, error, sample_data, tiers, created_at, started_at, finished_at";

const RECOMMENDATION_COLUMNS =
  "id, location_id, scan_id, rule, title, detail, status, acted_at, acted_by_action, created_at";

const RESULT_COLUMNS =
  "id, scan_id, tracked_query_id, surface, shown, mentioned, position, competitors, cited_urls, answer_excerpt, phones, tier, sampled_at";

export function createSupabaseStore(
  db: SupabaseClient,
  /** How many rows a list is asked for at a time. Smaller in tests, to read more than a page. */
  { pageSize = PAGE_SIZE } = {},
): Store {
  /**
   * Every row of a list that reaches across organizations, and so may be longer than one answer
   * carries (`readEvery`). `page` asks for one page of it, in an order no two rows share.
   */
  async function every(what: string, page: ReadPage<unknown, DbError>): Promise<unknown[]> {
    const { rows, error } = await readEvery(page, pageSize);
    if (error) fail(what, error);
    return rows;
  }
  /** The first page is the one asked how many rows there are in all. */
  const counted = (first: boolean) => (first ? ({ count: "exact" } as const) : {});

  /** The addresses of an organization's members with one of these roles. Worker only. */
  async function emailsOf(organizationId: string, roles: string[]): Promise<string[]> {
    // Nobody is emailed about an organization being closed, but by the closing itself.
    const { data, error } = await db
      .from("memberships")
      .select("user_id, organizations!inner(closing_at)")
      .eq("organization_id", organizationId)
      .in("role", roles)
      .is("organizations.closing_at", null);
    if (error) fail("List members", error);

    const emails: string[] = [];
    for (const { user_id } of z.array(z.object({ user_id: z.uuid() })).parse(data ?? [])) {
      const { data: found, error: userError } = await db.auth.admin.getUserById(user_id);
      if (userError) fail("Look up member", userError);
      if (found.user?.email) emails.push(found.user.email);
    }
    return emails;
  }

  /** An invitation one of the invitation functions answers with, or null where it answered none. */
  async function invitationFrom(
    what: string,
    fn: string,
    args: Record<string, string>,
  ): Promise<Invitation | null> {
    const { data, error } = await db.rpc(fn, args).select(INVITATION_COLUMNS).maybeSingle();
    if (error) fail(what, error);
    return data ? InvitationSchema.parse(data) : null;
  }

  /** Whether one of the membership functions changed someone. */
  async function membershipChanged(
    what: string,
    fn: string,
    args: Record<string, string>,
  ): Promise<boolean> {
    const { data, error } = await db.rpc(fn, args).select("user_id").maybeSingle();
    if (error) fail(what, error);
    return data !== null;
  }

  return {
    async listOrganizations() {
      // By membership, not by what the caller can read: the operator can read every organization
      // and still belongs only to their own.
      const { data, error } = await db.rpc("my_organizations");
      if (error) fail("List organizations", error);
      return OrganizationSchema.array().parse(data);
    },

    async getOrganization(id) {
      const { data, error } = await db
        .from("organizations")
        .select(ORGANIZATION_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) fail("Get organization", error);
      return data ? OrganizationSchema.parse(data) : null;
    },

    async createOrganization(name) {
      const { data, error } = await db.rpc("create_organization", { org_name: name });
      if (error) fail("Create organization", error);
      return OrganizationSchema.parse(data);
    },

    async listPlans() {
      // Named columns: no page needs the payment provider's price IDs.
      const { data, error } = await db.from("plans").select(PLAN_COLUMNS).order("position");
      if (error) fail("List plans", error);
      return PlanSchema.array().parse(data);
    },

    async getManualScansUsed(organizationId) {
      const { data, error } = await db
        .from("organizations")
        .select("manual_scans_month, manual_scans_used")
        .eq("id", organizationId)
        .maybeSingle();
      if (error) fail("Get manual scans used", error);
      if (!data) return null;
      const counted = ManualScansSchema.parse(data);
      // The count is for the month it names. In any other month nothing has been used yet.
      const thisMonth = `${new Date().toISOString().slice(0, 7)}-01`;
      return counted.manual_scans_month === thisMonth ? counted.manual_scans_used : 0;
    },

    async listLocationActions(locationId) {
      const { data, error } = await db
        .from("actions")
        .select(ACTION_COLUMNS)
        .eq("location_id", locationId)
        .order("proposed_at", { ascending: false })
        .limit(100);
      if (error) fail("List actions", error);
      return z.array(ActionSchema).parse(data ?? []);
    },

    async isLocationHeld(locationId) {
      const { data, error } = await db.rpc("location_held", { location: locationId });
      if (error) fail("Ask whether a location's organization is held", error);
      return data === true;
    },

    async listUntoldActions() {
      const data = await every("List untold actions", (from, to, first) =>
        db
          .from("actions")
          .select("location_id, done_at", counted(first))
          .eq("status", "done")
          .is("told_at", null)
          .order("done_at")
          .order("id")
          .range(from, to),
      );
      return z.array(z.object({ location_id: z.uuid(), done_at: z.string() })).parse(data);
    },

    async countWaitingActions(organizationId) {
      // By the organization named, not by what the caller can read: the operator reads them all.
      const { data, error } = await db
        .from("actions")
        .select("location_id, locations!inner(organization_id)")
        .eq("status", "proposed")
        .eq("locations.organization_id", organizationId);
      if (error) fail("Count waiting actions", error);
      const waiting: Record<string, number> = {};
      for (const row of z.array(z.object({ location_id: z.uuid() })).parse(data ?? [])) {
        waiting[row.location_id] = (waiting[row.location_id] ?? 0) + 1;
      }
      return waiting;
    },

    async approveAction(id, text) {
      const { data, error } = await db
        .rpc("approve_action", { action: id, edited_text: text ?? null })
        .select(ACTION_COLUMNS)
        .maybeSingle();
      if (error) fail("Approve an action", error);
      return data ? ActionSchema.parse(data) : null;
    },

    async declineAction(id, reason) {
      const { data, error } = await db
        .rpc("decline_action", { action: id, reason: reason ?? null })
        .select(ACTION_COLUMNS)
        .maybeSingle();
      if (error) fail("Decline an action", error);
      return data ? ActionSchema.parse(data) : null;
    },

    async takeBackAction(id) {
      const { data, error } = await db
        .rpc("take_back_action", { action: id })
        .select(ACTION_COLUMNS)
        .maybeSingle();
      if (error) fail("Take an action back", error);
      return data ? ActionSchema.parse(data) : null;
    },

    async giveStandingPermission(organizationId, kind) {
      const { data, error } = await db
        .rpc("give_standing_permission", { org: organizationId, of_kind: kind })
        .select(STANDING_PERMISSION_COLUMNS)
        .maybeSingle();
      if (error) fail("Give standing permission", error);
      return data ? StandingPermissionSchema.parse(data) : null;
    },

    async endStandingPermission(organizationId, kind) {
      const { data, error } = await db
        .rpc("end_standing_permission", { org: organizationId, of_kind: kind })
        .select(STANDING_PERMISSION_COLUMNS)
        .maybeSingle();
      if (error) fail("End standing permission", error);
      return data ? StandingPermissionSchema.parse(data) : null;
    },

    async getPermissionState(locationId) {
      const { data, error } = await db.rpc("standing_permission_state", { location: locationId });
      if (error) fail("Read standing permission", error);
      if (!data) return null;
      const state = z
        .object({
          included: z.boolean(),
          may_change: z.boolean(),
          counted: z.record(z.string(), z.number().int()),
        })
        .parse(data);
      const { data: location, error: locationError } = await db
        .from("locations")
        .select("organization_id")
        .eq("id", locationId)
        .maybeSingle();
      if (locationError) fail("Read standing permission", locationError);
      // By the organization named, not by what the caller can read: the operator reads them all.
      const { data: current, error: currentError } = await db
        .from("standing_permissions")
        .select(STANDING_PERMISSION_COLUMNS)
        .eq("organization_id", location?.organization_id ?? "")
        .is("ended_at", null);
      if (currentError) fail("Read standing permission", currentError);
      const standing = z.array(StandingPermissionSchema).parse(current ?? []);
      return {
        permissions: ACTION_KINDS.flatMap((kind) => {
          const counted = Math.min(state.counted[kind] ?? 0, STANDING_PERMISSION_AFTER);
          const permission = standing.find((kept) => kept.kind === kind) ?? null;
          return counted > 0 || permission ? [{ kind, counted, standing: permission }] : [];
        }),
        permission_included: state.included,
        may_change_permission: state.may_change,
      };
    },

    async retryAction(id) {
      const { data, error } = await db
        .rpc("retry_action", { action: id })
        .select(ACTION_COLUMNS)
        .maybeSingle();
      if (error) fail("Ask for an action again", error);
      return data ? ActionSchema.parse(data) : null;
    },

    async listAlerts(locationId, sampleData) {
      const { data, error } = await db
        .from("alerts")
        .select(ALERT_COLUMNS)
        .eq("location_id", locationId)
        .eq("sample_data", sampleData)
        .is("cleared_at", null)
        .order("raised_at", { ascending: false })
        .limit(200);
      if (error) fail("List alerts", error);
      return z.array(AlertSchema).parse(data ?? []);
    },

    async listSeenBefore(locationId, sampleData, skip) {
      const { data, error } = await db.rpc("seen_before", {
        location: locationId,
        sample: sampleData,
        skip,
        on_surfaces: CITING_SURFACES,
      });
      if (error) fail("Read what was named and cited before", error);
      return z
        .object({ competitors: z.array(z.string()), origins: z.array(z.string()) })
        .parse(data);
    },

    async listAlertsToTell(locationId, sampleData) {
      const { data, error } = await db
        .from("alerts")
        .select(ALERT_COLUMNS)
        .eq("location_id", locationId)
        .eq("sample_data", sampleData)
        .is("dismissed_at", null)
        .or(
          "and(cleared_at.is.null,told_at.is.null),and(clear_reason.eq.named_again,told_at.not.is.null,cleared_told_at.is.null)",
        )
        .order("raised_at", { ascending: false });
      if (error) fail("List alerts to tell owners of", error);
      const alerts = z.array(AlertSchema).parse(data ?? []);
      return {
        raised: alerts.filter((alert) => alert.cleared_at === null),
        named_again: alerts.filter((alert) => alert.cleared_at !== null),
      };
    },

    async markAlertsTold(told, at) {
      if (told.raised.length > 0) {
        const { error } = await db.from("alerts").update({ told_at: at }).in("id", told.raised);
        if (error) fail("Keep that owners were told of alerts", error);
      }
      if (told.named_again.length > 0) {
        const { error } = await db
          .from("alerts")
          .update({ cleared_told_at: at })
          .in("id", told.named_again);
        if (error) fail("Keep that owners were told alerts ended", error);
      }
    },

    async dismissAlert(id) {
      const { data, error } = await db
        .rpc("dismiss_alert", { alert: id })
        .select(ALERT_COLUMNS)
        .maybeSingle();
      if (error) fail("Dismiss an alert", error);
      return data ? AlertSchema.parse(data) : null;
    },

    async listDrafts(locationId) {
      const { data, error } = await db
        .from("drafts")
        .select(DRAFT_COLUMNS)
        .eq("location_id", locationId);
      if (error) fail("List drafts", error);
      return DraftSchema.array().parse(data);
    },

    async askDraft(recommendationId) {
      const { data, error } = await db
        .rpc("ask_draft", { recommendation: recommendationId })
        .select(DRAFT_COLUMNS)
        .maybeSingle();
      if (error) fail("Ask for a draft", error);
      return data ? DraftSchema.parse(data) : null;
    },

    async listListings(locationId) {
      const { data, error } = await db
        .from("listings")
        .select(LISTING_COLUMNS)
        .eq("location_id", locationId)
        .order("site");
      if (error) fail("List listings", error);
      return ListingSchema.array().parse(data);
    },

    async setListing(locationId, site, url) {
      const { data, error } = await db
        .rpc("set_listing", { location: locationId, on_site: site, address: url })
        .select(LISTING_COLUMNS)
        .maybeSingle();
      if (error) fail("Set a listing", error);
      return data ? ListingSchema.parse(data) : null;
    },

    async removeListing(locationId, site) {
      const { data, error } = await db.rpc("remove_listing", {
        location: locationId,
        on_site: site,
      });
      if (error) fail("Remove a listing", error);
      return data === true;
    },

    async listPromptPages(locationId) {
      const { data, error } = await db
        .from("prompt_pages")
        .select(PROMPT_PAGE_COLUMNS)
        .eq("location_id", locationId)
        .order("set_at");
      if (error) fail("List pages", error);
      return PromptPageSchema.array().parse(data);
    },

    async setPromptPage(recommendationId, url) {
      const { data, error } = await db
        .rpc("set_prompt_page", { recommendation: recommendationId, address: url })
        .select(PROMPT_PAGE_COLUMNS)
        .maybeSingle();
      if (error) fail("Set where a page is", error);
      return data ? PromptPageSchema.parse(data) : null;
    },

    async removePromptPage(recommendationId) {
      const { data, error } = await db.rpc("remove_prompt_page", {
        recommendation: recommendationId,
      });
      if (error) fail("Remove where a page is", error);
      return data === true;
    },

    async keepPublishedPage(actionId, url) {
      const { data, error } = await db.rpc("keep_published_page", {
        action: actionId,
        address: url,
      });
      if (error) fail("Keep where a page was published", error);
      return data === true;
    },

    async getLocationVisits(locationId, days) {
      const { data, error } = await db.rpc("location_visits", {
        location: locationId,
        over_days: days,
      });
      if (error) fail("Add up a location's visits", error);
      return LocationVisitsSchema.parse(data);
    },

    async getVisitLine(locationId) {
      const { data, error } = await db
        .from("visit_lines")
        .select(LINE_COLUMNS)
        .eq("location_id", locationId)
        .maybeSingle();
      if (error) fail("Get a line", error);
      return data ? VisitLineSchema.parse(data) : null;
    },

    async replaceSiteKey(locationId) {
      const { data, error } = await db
        .rpc("replace_site_key", { location: locationId })
        .select(LINE_COLUMNS)
        .maybeSingle();
      if (error) fail("Replace a site key", error);
      return data ? VisitLineSchema.parse(data) : null;
    },

    async listConnections(organizationId) {
      const { data, error } = await db
        .from("connections")
        .select(CONNECTION_COLUMNS)
        .eq("organization_id", organizationId)
        .order("connected_at", { ascending: false });
      if (error) fail("List connections", error);
      return z.array(ConnectionSchema).parse(data ?? []);
    },

    async managesConnections(organizationId) {
      const { data, error } = await db.rpc("has_org_role", {
        org: organizationId,
        roles: ["owner", "admin"],
      });
      if (error) fail("Check who manages connections", error);
      return data === true;
    },

    async createConnection(connection) {
      const { data, error } = await db
        .rpc("create_connection", {
          org: connection.organization_id,
          new_id: connection.id,
          of_kind: connection.kind,
          account_label: connection.label,
          sealed_sign_in: connection.sealed,
          from_location: connection.for_location ?? null,
        })
        .select(CONNECTION_COLUMNS)
        .maybeSingle();
      if (error) fail("Create connection", error);
      return data ? ConnectionSchema.parse(data) : null;
    },

    async requestConnectionRemoval(id) {
      const { data, error } = await db
        .rpc("request_connection_removal", { connection: id })
        .select(CONNECTION_COLUMNS)
        .maybeSingle();
      if (error) fail("Ask for a connection to be removed", error);
      return data ? ConnectionSchema.parse(data) : null;
    },

    async matchConnectionLocation(connectionId, locationId, externalId) {
      const { data, error } = await db
        .rpc("match_connection_location", {
          connection: connectionId,
          location: locationId,
          external: externalId,
        })
        .select(CONNECTION_MATCH_COLUMNS)
        .maybeSingle();
      if (error) fail("Match a location to a connection", error);
      return data ? ConnectionMatchSchema.parse(data) : null;
    },

    async unmatchConnectionLocation(connectionId, locationId) {
      const { data, error } = await db.rpc("unmatch_connection_location", {
        connection: connectionId,
        location: locationId,
      });
      if (error) fail("Take a location's match away", error);
      return data === true;
    },

    async listLocationConnections(locationId) {
      const { data, error } = await db
        .from("connection_locations")
        .select("connection_id, kind, external_label, connection:connections(label)")
        .eq("location_id", locationId);
      if (error) fail("List a location's connections", error);
      return z
        .array(
          z.object({
            connection_id: z.uuid(),
            kind: LocationConnectionSchema.shape.kind,
            external_label: z.string(),
            connection: z.object({ label: z.string() }),
          }),
        )
        .parse(data ?? [])
        .map(({ connection, ...match }) => ({ ...match, label: connection.label }));
    },

    async createAnswerSubdomain({ id, location_id, label, target }) {
      const { data, error } = await db
        .rpc("create_answer_subdomain", {
          location: location_id,
          new_id: id,
          label,
          new_target: target,
        })
        .select(CONNECTION_COLUMNS)
        .maybeSingle();
      if (error) fail("Create an answer subdomain", error);
      return data ? ConnectionSchema.parse(data) : null;
    },

    async getLocationAnswerSubdomain(locationId) {
      const { data, error } = await db
        .from("answer_subdomains")
        .select(`${ANSWER_SUBDOMAIN_SHOWN}, ${ANSWER_SUBDOMAIN_STANDING}`)
        .eq("location_id", locationId)
        // The one held, or else the one let go last.
        .order("released_at", { ascending: false, nullsFirst: true })
        .limit(1)
        .maybeSingle();
      if (error) fail("Get a location's answer subdomain", error);
      return data
        ? keptAnswerSubdomain(
            AnswerSubdomainRowSchema.parse({ ...data, cloudflare_id: null, live_told_at: null }),
          )
        : null;
    },

    async listLocationPageFetches(locationId, since) {
      const { data, error } = await db.rpc("location_page_fetches", {
        location: locationId,
        since,
      });
      if (error) fail("List a location's page fetches", error);
      return z
        .array(
          z.object({
            recommendation_id: z.uuid(),
            fetcher: PageFetchesSchema.shape.fetcher,
            fetches: z.coerce.number(),
            last_on: z.string(),
          }),
        )
        .parse(data ?? [])
        .map(({ fetches, ...counted }) => ({ ...counted, count: fetches }));
    },

    async matchCloudflareZones(connectionId, zones) {
      const { data, error } = await db.rpc("match_cloudflare_zones", {
        connection: connectionId,
        reached: zones,
      });
      if (error) fail("Match a Cloudflare connection's zones", error);
      return z
        .array(
          z.object({
            location_id: z.uuid(),
            zone_id: z.string(),
            zone: z.string(),
            website: z.string().nullable(),
            read_through: z.string().nullable(),
          }),
        )
        .parse(data ?? []);
    },

    async recordSiteFetches(locationId, read, counts) {
      const { data, error } = await db.rpc("record_site_fetches", {
        location: locationId,
        from_day: read.from,
        to_day: read.to,
        counted: counts,
        connection: "connection_id" in read ? read.connection_id : null,
        sample: "sample" in read,
      });
      if (error) fail("Keep a location's site fetches", error);
      return z.number().int().parse(data);
    },

    async getLocationFetches(locationId, since, sampleData) {
      // One value, added up in the database, so no list is cut short at the API's page of rows.
      const { data, error } = await db.rpc("location_site_fetches", {
        location: locationId,
        since,
        sample: sampleData,
      });
      if (error) fail("Add up a location's site fetches", error);
      return LocationFetchesSchema.pick({
        days: true,
        pages: true,
        other_pages: true,
        read_through: true,
      }).parse(data);
    },

    async matchAnalyticsProperties(connectionId, properties) {
      const { data, error } = await db.rpc("match_analytics_properties", {
        connection: connectionId,
        reached: properties,
      });
      if (error) fail("Match a Google Analytics connection's properties", error);
      return z
        .array(
          z.object({
            location_id: z.uuid(),
            property_id: z.string(),
            read_through: z.string().nullable(),
          }),
        )
        .parse(data ?? []);
    },

    async recordAnalyticsVisits(locationId, read, counts) {
      const { data, error } = await db.rpc("record_analytics_visits", {
        location: locationId,
        from_day: read.from,
        to_day: read.to,
        counted: counts,
        connection: "connection_id" in read ? read.connection_id : null,
        sample: "sample" in read,
      });
      if (error) fail("Keep a location's sessions from assistants", error);
      return z.number().int().parse(data);
    },

    async getLocationAnalyticsVisits(locationId, since, sampleData) {
      // One value, added up in the database, so no list is cut short at the API's page of rows.
      const { data, error } = await db.rpc("location_analytics_visits", {
        location: locationId,
        since,
        sample: sampleData,
      });
      if (error) fail("Add up a location's sessions from assistants", error);
      return LocationAnalyticsVisitsSchema.pick({
        days: true,
        pages: true,
        other_pages: true,
      }).parse(data);
    },

    async listPausedAnswerSubdomainsUntold() {
      const { data, error } = await db.rpc("answer_subdomains_paused_untold");
      if (error) fail("List paused answer subdomains nobody was told of", error);
      return z.array(z.uuid()).parse(data ?? []);
    },

    async markAnswerSubdomainPauseTold(connectionId) {
      const { error } = await db
        .from("answer_subdomains")
        .update({ pause_told_at: new Date().toISOString() })
        .eq("connection_id", connectionId);
      if (error) fail("Keep that an answer subdomain's owners were told it is paused", error);
    },

    async getHostedPage(connectionId, slug) {
      const { data, error } = await db
        .from("hosted_pages")
        .select(
          "id, connection_id, location_id, recommendation_id, action_id, slug, title, copy, published_at, taken_back_at",
        )
        .eq("connection_id", connectionId)
        .eq("slug", slug)
        .is("taken_back_at", null)
        .maybeSingle();
      if (error) fail("Get a hosted page", error);
      return data ? HostedPageRowSchema.parse(data) : null;
    },

    async publishHostedPage(actionId, page) {
      const { data, error } = await db.rpc("publish_hosted_page", {
        action: actionId,
        page_slug: page.slug,
        page_title: page.title,
        page_copy: page.copy,
      });
      if (error) fail("Publish a hosted page", error);
      return z
        .string()
        .nullable()
        .parse(data ?? null);
    },

    async takeBackHostedPage(actionId) {
      const { data, error } = await db.rpc("take_back_hosted_page", { action: actionId });
      if (error) fail("Take back a hosted page", error);
      return data === true;
    },

    async getAnswerSubdomain(connectionId) {
      const { data, error } = await db
        .from("answer_subdomains")
        .select(
          `${ANSWER_SUBDOMAIN_SHOWN}, cloudflare_id, live_told_at, ${ANSWER_SUBDOMAIN_STANDING}`,
        )
        .eq("connection_id", connectionId)
        .maybeSingle();
      if (error) fail("Get an answer subdomain", error);
      return data ? keptAnswerSubdomain(AnswerSubdomainRowSchema.parse(data)) : null;
    },

    async recordAnswerSubdomainCheck(connectionId, check) {
      const { data, error } = await db.rpc("record_answer_subdomain_check", {
        connection: connectionId,
        seen: check.record,
        registered: check.cloudflare_id,
        live: check.live,
        links: check.home_links,
      });
      if (error) fail("Record an answer subdomain's check", error);
      return data === true;
    },

    async markAnswerSubdomainTold(connectionId) {
      const { error } = await db
        .from("answer_subdomains")
        .update({ live_told_at: new Date().toISOString() })
        .eq("connection_id", connectionId);
      if (error) fail("Keep that an answer subdomain's owners were told", error);
    },

    async listAnswerSubdomainsToCheck(before) {
      const { data, error } = await db.rpc("answer_subdomains_to_check", { before });
      if (error) fail("List answer subdomains to check", error);
      return z.array(z.uuid()).parse(data ?? []);
    },

    async expireUnclaimedAnswerSubdomains() {
      const { data, error } = await db.rpc("expire_unclaimed_answer_subdomains");
      if (error) fail("Expire unclaimed answer subdomains", error);
      return z.array(z.uuid()).parse(data ?? []);
    },

    async getAllowanceUse(organizationId) {
      const thisMonth = `${new Date().toISOString().slice(0, 7)}-01`;
      const { data, error } = await db
        .from("allowance_use")
        .select("kind, used")
        .eq("organization_id", organizationId)
        .eq("month", thisMonth);
      if (error) fail("Get allowance use", error);
      return AllowanceUseSchema.parse(
        Object.fromEntries((data ?? []).map((row) => [row.kind, row.used])),
      );
    },

    async listPlanPrices() {
      const [plans, versions] = await Promise.all([
        db.from("plans").select(PLAN_PRICE_COLUMNS).order("position"),
        db.from("plan_prices").select(PRICE_VERSION_COLUMNS).order("created_at", {
          ascending: false,
        }),
      ]);
      if (plans.error) fail("List plan prices", plans.error);
      if (versions.error) fail("List the prices plans have been sold at", versions.error);
      const sold = PriceVersionRowSchema.array().parse(versions.data);
      return PlanPriceRowSchema.array()
        .parse(plans.data)
        .map((plan) => {
          const own = sold
            .filter((version) => version.plan_key === plan.key)
            .map(({ plan_key: _, ...version }) => version);
          return {
            key: plan.key,
            on_sale: plan.on_sale,
            included_locations: plan.included_locations,
            sells_stronger: plan.allowances[STRONGER_MODELS_ALLOWANCE] === true,
            current:
              own.find((version) => version.stripe_price_id === plan.stripe_price_id) ?? null,
            versions: own,
          };
        });
    },

    async getBillingState(organizationId) {
      const { data, error } = await db.rpc("billing_state", { org: organizationId }).maybeSingle();
      if (error) fail("Get billing state", error);
      return data ? BillingStateSchema.parse(data) : null;
    },

    async exportOrganization(organizationId) {
      // One value for the whole of it, so no list is cut short at the API's page of rows.
      const { data, error } = await db.rpc("export_organization", { org: organizationId });
      if (error) fail("Export an organization", error);
      return data ? AccountExportSchema.parse(data) : null;
    },

    async requestClosing(organizationId, name) {
      const { data, error } = await db
        .rpc("request_closing", { org: organizationId, typed_name: name })
        .maybeSingle();
      if (error) fail("Ask to close an account", error);
      const asked = ClosingAskedRowSchema.parse(data);
      return asked.closing_id
        ? { closing_id: asked.closing_id }
        : { refused: asked.refused ?? "owners_only" };
    },

    async listMyRoles() {
      const { data, error } = await db.rpc("my_roles");
      if (error) fail("List my roles", error);
      const rows = z
        .array(z.object({ organization_id: z.uuid(), role: MemberRoleSchema }))
        .parse(data ?? []);
      return Object.fromEntries(rows.map((row) => [row.organization_id, row.role]));
    },

    async listMembers(organizationId) {
      const { data, error } = await db.rpc("organization_members", { org: organizationId });
      if (error) fail("List members", error);
      const members = MemberSchema.array().parse(data ?? []);
      return members.length > 0 ? members : null;
    },

    async listInvitations(organizationId) {
      // Accepted and cancelled ones are history, kept for the export, not listed. Twenty wait at
      // most, but declined and expired ones gather until an owner removes them: the newest are
      // listed.
      const { data, error } = await db
        .from("invitations")
        .select(INVITATION_COLUMNS)
        .eq("organization_id", organizationId)
        .or("outcome.is.null,outcome.eq.declined")
        .order("created_at", { ascending: false })
        .order("id")
        .limit(MOST_INVITATIONS_LISTED);
      if (error) fail("List invitations", error);
      return InvitationSchema.array().parse(data ?? []);
    },

    async listMyInvitations() {
      const { data, error } = await db.rpc("my_invitations");
      if (error) fail("List my invitations", error);
      return MyInvitationSchema.array().parse(data ?? []);
    },

    async inviteMember(organizationId, email, role) {
      return invitationFrom("Invite someone", "invite_member", {
        org: organizationId,
        address: email,
        as_role: role,
      });
    },

    async sendInvitationAgain(organizationId, invitationId) {
      return invitationFrom("Send an invitation again", "send_invitation_again", {
        org: organizationId,
        invitation: invitationId,
      });
    },

    async cancelInvitation(organizationId, invitationId) {
      return invitationFrom("Cancel an invitation", "cancel_invitation", {
        org: organizationId,
        invitation: invitationId,
      });
    },

    async acceptInvitation(invitationId) {
      return invitationFrom("Accept an invitation", "accept_invitation", {
        invitation: invitationId,
      });
    },

    async declineInvitation(invitationId) {
      return invitationFrom("Decline an invitation", "decline_invitation", {
        invitation: invitationId,
      });
    },

    async changeMemberRole(organizationId, userId, role) {
      return membershipChanged("Change a role", "change_member_role", {
        org: organizationId,
        member: userId,
        to_role: role,
      });
    },

    async removeMember(organizationId, userId) {
      return membershipChanged("Remove someone", "remove_member", {
        org: organizationId,
        member: userId,
      });
    },

    async leaveOrganization(organizationId) {
      return membershipChanged("Leave an organization", "leave_organization", {
        org: organizationId,
      });
    },

    async getClosing(id) {
      const { data, error } = await db
        .from("closings")
        .select(CLOSING_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) fail("Get a closing", error);
      return data ? ClosingSchema.parse(data) : null;
    },

    async claimClosing(id) {
      const { data, error } = await db.rpc("claim_closing", { closing: id });
      if (error) fail("Take a closing", error);
      return data === true;
    },

    async releaseClosing(id) {
      const { error } = await db.from("closings").update({ working_since: null }).eq("id", id);
      if (error) fail("Let go of a closing", error);
    },

    async recordClosingProgress(id, progress) {
      const { error } = await db.from("closings").update(progress).eq("id", id);
      if (error) fail("Keep how far a closing has got", error);
    },

    async deleteClosedOrganization(organizationId) {
      const { data, error } = await db
        .from("organizations")
        .delete()
        .eq("id", organizationId)
        .not("closing_at", "is", null)
        .select("id");
      if (error) fail("Delete a closed organization", error);
      return (data ?? []).length > 0;
    },

    async deleteAccount(userId) {
      const { error } = await db.auth.admin.deleteUser(userId);
      // One already gone is what was wanted.
      if (error && error.status !== 404) fail("Delete a sign-in", error);
    },

    async finishClosing(id) {
      const { data, error } = await db
        .from("closings")
        .update({
          organization_name: null,
          owner_id: null,
          owner_email: null,
          member_emails: [],
          left_at_sites: [],
          hostnames: [],
          finished_at: new Date().toISOString(),
        })
        .eq("id", id)
        .is("finished_at", null)
        .select("id");
      if (error) fail("Finish a closing", error);
      return (data ?? []).length > 0;
    },

    async listStalledClosings(before) {
      const { data, error } = await db
        .from("closings")
        .select("id")
        .is("finished_at", null)
        .lt("asked_at", before)
        .or(`working_since.is.null,working_since.lt."${before}"`)
        .order("asked_at")
        .limit(100);
      if (error) fail("List stalled closings", error);
      return z
        .array(z.object({ id: z.uuid() }))
        .parse(data ?? [])
        .map((row) => row.id);
    },

    async dropFinishedClosings(before) {
      const { data, error } = await db
        .from("closings")
        .delete()
        .lt("finished_at", before)
        .select("id");
      if (error) fail("Forget finished closings", error);
      return (data ?? []).length;
    },

    async getSubscription(organizationId) {
      const { data, error } = await db
        .from("subscriptions")
        .select(SUBSCRIPTION_COLUMNS)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (error) fail("Get subscription", error);
      return data ? SubscriptionRecordSchema.parse(data) : null;
    },

    async recordSubscription(organizationId, subscription) {
      const { error } = await db.from("subscriptions").upsert({
        organization_id: organizationId,
        ...subscription,
        updated_at: new Date().toISOString(),
      });
      if (error) fail("Record subscription", error);
    },

    async claimSubscriptionStart(organizationId, subscriptionId) {
      const { data, error } = await db.rpc("claim_subscription_start", {
        org: organizationId,
        subscription: subscriptionId,
      });
      if (error) fail("Claim subscription start", error);
      return z.boolean().parse(data);
    },

    async chooseAssistants(id, surfaces) {
      const { data, error } = await db
        .rpc("choose_assistants", { org: id, chosen: [...surfaces] })
        .select(ORGANIZATION_COLUMNS)
        .maybeSingle();
      if (error) fail("Choose assistants", error);
      return data ? OrganizationSchema.parse(data) : null;
    },

    async proposeAction(action) {
      const { data, error } = await db
        .rpc("propose_action", {
          location: action.location_id,
          of_kind: action.kind,
          via: action.connection_id,
          about: action.subject,
          resting_on: action.basis,
          what: action.summary,
          was: action.seen,
          new_text: action.proposed_text,
          author: action.written_by,
          for_task: action.recommendation_id ?? null,
          asks_always: action.always_asks ?? false,
        })
        .select(ACTION_COLUMNS)
        .maybeSingle();
      if (error) fail("Propose an action", error);
      return data ? ActionSchema.parse(data) : null;
    },

    async getAction(id) {
      const { data, error } = await db
        .from("actions")
        .select(ACTION_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) fail("Get action", error);
      return data ? ActionSchema.parse(data) : null;
    },

    async claimAction(id) {
      const { data, error } = await db.rpc("claim_action", { action: id });
      if (error) fail("Claim an action", error);
      return z
        .number()
        .int()
        .parse(data ?? 0);
    },

    async finishAction(id, outcome, why) {
      const { data, error } = await db.rpc("finish_action", {
        action: id,
        outcome,
        why: why ?? null,
      });
      if (error) fail("Finish an action", error);
      return data === true;
    },

    async listActionsToTell() {
      const data = await every("List actions to tell owners of", (from, to, first) =>
        db
          .from("actions")
          .select(
            `${ACTION_COLUMNS}, location:locations!inner(name, organization_id)`,
            counted(first),
          )
          .or("and(status.eq.done,told_at.is.null),and(status.eq.proposed,waiting_told_at.is.null)")
          .order("proposed_at")
          .order("id")
          .range(from, to),
      );
      const where = z.object({
        location: z.object({ name: z.string(), organization_id: z.uuid() }),
      });
      return data.map((row) => {
        const { location } = where.parse(row);
        return {
          action: ActionSchema.parse(row),
          location_name: location.name,
          organization_id: location.organization_id,
        };
      });
    },

    async markActionsTold(ids, which, at) {
      if (ids.length === 0) return;
      const { error } = await db
        .from("actions")
        .update(which === "done" ? { told_at: at } : { waiting_told_at: at })
        .in("id", ids);
      if (error) fail("Keep that owners were told of actions", error);
    },

    async listPermissionsToTell() {
      const data = await every("List standing permissions to tell owners of", (from, to, first) =>
        db
          .from("standing_permissions")
          .select(
            `${STANDING_PERMISSION_COLUMNS}, organization_id, given_told_at, ended_told_at`,
            counted(first),
          )
          .or("given_told_at.is.null,and(ended_at.not.is.null,ended_told_at.is.null)")
          .order("given_at")
          .order("id")
          .range(from, to),
      );
      const told = z.object({
        organization_id: z.uuid(),
        given_told_at: z.string().nullable(),
        ended_told_at: z.string().nullable(),
      });
      return data.map((row) => {
        const permission = StandingPermissionSchema.parse(row);
        const kept = told.parse(row);
        return {
          permission,
          organization_id: kept.organization_id,
          given_untold: kept.given_told_at === null,
          ended_untold: permission.ended_at !== null && kept.ended_told_at === null,
        };
      });
    },

    async markPermissionsTold(ids, which, at) {
      if (ids.length === 0) return;
      const { error } = await db
        .from("standing_permissions")
        .update(which === "given" ? { given_told_at: at } : { ended_told_at: at })
        .in("id", ids);
      if (error) fail("Keep that owners were told of standing permission", error);
    },

    async isOrganizationHeld(organizationId) {
      const { data, error } = await db.rpc("organization_held", { org: organizationId });
      if (error) fail("Ask whether an organization is held", error);
      return data === true;
    },

    async lapseActions() {
      const { data, error } = await db.rpc("lapse_actions");
      if (error) fail("Lapse actions", error);
      return z
        .number()
        .int()
        .parse(data ?? 0);
    },

    async dropExpiredSeen() {
      const { data, error } = await db.rpc("drop_expired_seen");
      if (error) fail("Drop what actions replaced", error);
      return z
        .number()
        .int()
        .parse(data ?? 0);
    },

    async getDraft(id) {
      const { data, error } = await db
        .from("drafts")
        .select(DRAFT_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) fail("Get a draft", error);
      return data ? DraftSchema.parse(data) : null;
    },

    async claimDraft(id) {
      const { data, error } = await db.rpc("claim_draft", { draft: id });
      if (error) fail("Claim a draft", error);
      return z
        .number()
        .int()
        .parse(data ?? 0);
    },

    async finishDraft(id, result) {
      const { data, error } = await db.rpc(
        "finish_draft",
        result.outcome === "written"
          ? {
              draft: id,
              outcome: result.outcome,
              body: result.text,
              of_kind: result.kind,
              by_model: result.model,
              sample: result.sample_data,
            }
          : { draft: id, outcome: result.outcome, why: result.why },
      );
      if (error) fail("Finish a draft", error);
      return data === true;
    },

    async listStalledDrafts(before) {
      const { data, error } = await db
        .from("drafts")
        .select("id")
        .eq("status", "asked")
        .lt("asked_at", before)
        // Nobody is on it, or whoever was has been on it since before then and is taken to
        // have died.
        .or(`writing_since.is.null,writing_since.lt.${before}`);
      if (error) fail("List stalled drafts", error);
      return z
        .array(z.object({ id: z.uuid() }))
        .parse(data ?? [])
        .map((row) => row.id);
    },

    async listStalledActions(before) {
      const { data, error } = await db
        .from("actions")
        .select("id")
        .eq("status", "approved")
        .lt("approved_at", before)
        // Nobody is on it, or whoever was has been on it since before then and is taken to
        // have died.
        .or(`carrying_since.is.null,carrying_since.lt.${before}`);
      if (error) fail("List stalled actions", error);
      return z
        .array(z.object({ id: z.uuid() }))
        .parse(data ?? [])
        .map((row) => row.id);
    },

    async getSampleLine(connectionId, externalId) {
      const { data, error } = await db
        .from("sample_listings")
        .select("opening_line")
        .eq("connection_id", connectionId)
        .eq("external_id", externalId)
        .maybeSingle();
      if (error) fail("Read a sample listing", error);
      return data
        ? z.object({ opening_line: z.string().nullable() }).parse(data).opening_line
        : null;
    },

    async setSampleLine(connectionId, externalId, line) {
      const { error } = await db
        .from("sample_listings")
        .upsert({ connection_id: connectionId, external_id: externalId, opening_line: line });
      if (error) fail("Write a sample listing", error);
    },

    async getConnection(id) {
      const { data, error } = await db
        .from("connections")
        .select(CONNECTION_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) fail("Get connection", error);
      return data ? ConnectionSchema.parse(data) : null;
    },

    async getConnectionSecret(id) {
      const { data, error } = await db
        .from("connection_secrets")
        .select("sealed")
        .eq("connection_id", id)
        .maybeSingle();
      if (error) fail("Get a connection's sign-in", error);
      return data ? z.object({ sealed: z.string() }).parse(data).sealed : null;
    },

    async finishConnectionRemoval(id) {
      const { data, error } = await db.rpc("finish_connection_removal", { connection: id });
      if (error) fail("Finish removing a connection", error);
      return data === true;
    },

    async listStalledRemovals(before) {
      const { data, error } = await db
        .from("connections")
        .select("id")
        .eq("status", "removing")
        // A closing removes its own, and names them in its email.
        .or("removal_reason.is.null,removal_reason.neq.closing")
        .lt("removal_requested_at", before);
      if (error) fail("List stalled removals", error);
      return z
        .array(z.object({ id: z.uuid() }))
        .parse(data ?? [])
        .map((row) => row.id);
    },

    async listConnectionsDueForSync(limit) {
      const { data, error } = await db.rpc("connections_due_for_sync", { max_rows: limit });
      if (error) fail("List connections due for sync", error);
      return z.array(z.uuid()).parse(data ?? []);
    },

    async listConnectionsAwaitingFirstSync(after, before) {
      const { data, error } = await db
        .from("connections")
        .select("id")
        .eq("status", "working")
        .is("last_synced_at", null)
        .gt("connected_at", after)
        .lt("connected_at", before);
      if (error) fail("List connections awaiting their first sync", error);
      return z
        .array(z.object({ id: z.uuid() }))
        .parse(data ?? [])
        .map((row) => row.id);
    },

    async recordConnectionSync(id, choices) {
      const { data, error } = await db.rpc("record_connection_sync", {
        connection: id,
        reached: choices,
      });
      if (error) fail("Record a connection's sync", error);
      return data === true;
    },

    async recordConnectionFailure(id, refused) {
      const { data, error } = await db
        .rpc("record_connection_failure", { connection: id, refused })
        .maybeSingle();
      if (error) fail("Record a connection's failed sync", error);
      return data
        ? z.object({ status: ConnectionSchema.shape.status, newly_broken: z.boolean() }).parse(data)
        : null;
    },

    async markConnectionTold(id, which, at) {
      const { error } = await db
        .from("connections")
        .update(which === "told" ? { broken_told_at: at } : { broken_reminded_at: at })
        .eq("id", id);
      if (error) fail("Keep that a connection's owners were told", error);
    },

    async listBrokenConnectionsToRemind(before) {
      const { data, error } = await db
        .from("connections")
        .select("id")
        .eq("status", "broken")
        .is("broken_reminded_at", null)
        // A null is never before anything, so one that was never told is left out.
        .lt("broken_told_at", before);
      if (error) fail("List broken connections to remind", error);
      return z
        .array(z.object({ id: z.uuid() }))
        .parse(data ?? [])
        .map((row) => row.id);
    },

    async listBrokenConnectionsUntold() {
      const { data, error } = await db
        .from("connections")
        .select("id")
        .eq("status", "broken")
        .is("broken_told_at", null);
      if (error) fail("List broken connections nobody was told of", error);
      return z
        .array(z.object({ id: z.uuid() }))
        .parse(data ?? [])
        .map((row) => row.id);
    },

    async expirePausedConnections() {
      const { data, error } = await db.rpc("expire_paused_connections");
      if (error) fail("Expire paused connections", error);
      return z.array(z.uuid()).parse(data ?? []);
    },

    async claimAllowance(organizationId, kind, amount = 1) {
      const { data, error } = await db
        .rpc("claim_allowance", { org: organizationId, of_kind: kind, amount })
        .maybeSingle();
      if (error) fail("Claim allowance", error);
      return data ? AllowanceClaimSchema.parse(data) : null;
    },

    async applyPlan(organizationId, planKey, locations, stronger) {
      const { data, error } = await db
        .rpc("apply_plan", {
          org: organizationId,
          plan: planKey,
          locations: locations ?? null,
          stronger: stronger ?? null,
        })
        .select(ORGANIZATION_COLUMNS)
        .maybeSingle();
      if (error) fail("Apply plan", error);
      // The function returns one organization, so "none" arrives as a row of nulls.
      return data?.id ? OrganizationSchema.parse(data) : null;
    },

    async renameOrganization(id, name) {
      const { data, error } = await db
        .from("organizations")
        .update({ name })
        .eq("id", id)
        .select(ORGANIZATION_COLUMNS)
        .maybeSingle();
      if (error) fail("Rename organization", error);
      return data ? OrganizationSchema.parse(data) : null;
    },

    async setOrganizationLimits(id, limits) {
      const { data, error } = await db
        .rpc("operator_set_limits", {
          org: id,
          locations: limits.max_locations,
          queries_per_location: limits.max_queries_per_location,
          manual_scans_per_month: limits.max_manual_scans_per_month,
          every_days: limits.scan_every_days,
          org_allowances: limits.allowances,
        })
        .select(ORGANIZATION_COLUMNS)
        .maybeSingle();
      if (error) fail("Set organization limits", error);
      return data ? OrganizationSchema.parse(data) : null;
    },

    async listEverySubscription() {
      const data = await every("List subscriptions", (from, to, first) =>
        db
          .from("subscriptions")
          .select("organization_id, stripe_subscription_id", counted(first))
          .order("created_at")
          .order("organization_id")
          .range(from, to),
      );
      return z
        .array(
          z.object({ organization_id: z.uuid(), stripe_subscription_id: z.string().nullable() }),
        )
        .parse(data)
        .map((row) => ({
          organization_id: row.organization_id,
          subscribed: row.stripe_subscription_id !== null,
        }));
    },

    async setPlan(key, settings) {
      const { data, error } = await db
        .rpc("operator_set_plan", {
          plan: key,
          new_name: settings.name,
          sale: settings.on_sale,
          queries_per_location: settings.max_queries_per_location,
          plan_assistants: settings.assistants,
          every_days: settings.scan_every_days,
          manual_scans_per_month: settings.max_manual_scans_per_month,
          report: settings.emails_report,
          plan_allowances: settings.allowances,
        })
        .select(PLAN_COLUMNS)
        .maybeSingle();
      if (error) fail("Set plan", error);
      return data ? PlanSchema.parse(data) : null;
    },

    async setPlanPrices(key, version) {
      const { data, error } = await db
        .rpc("operator_set_plan_prices", {
          plan: key,
          price: version.price_cents,
          extra_location_price: version.extra_location_price_cents,
          stripe_price: version.stripe_price_id,
          stripe_extra_location_price: version.stripe_extra_location_price_id,
          stronger_price: version.stronger_price_cents,
          stripe_stronger_chatgpt_price: version.stripe_stronger_price_ids?.chatgpt ?? null,
          stripe_stronger_claude_price: version.stripe_stronger_price_ids?.claude ?? null,
        })
        .select(PLAN_COLUMNS)
        .maybeSingle();
      if (error) fail("Set plan prices", error);
      return data ? PlanSchema.parse(data) : null;
    },

    async getOpenPriceChange(planKey) {
      const { data, error } = await db
        .from("price_changes")
        .select(PRICE_CHANGE_COLUMNS)
        .eq("plan_key", planKey)
        .is("called_off_at", null)
        .is("completed_at", null)
        .maybeSingle();
      if (error) fail("Get open price change", error);
      return data ? PriceChangeSchema.parse(data) : null;
    },

    async announcePriceChange(planKey, effectiveAt) {
      const { data, error } = await db
        .rpc("operator_announce_price_change", { plan: planKey, effective: effectiveAt })
        .select(PRICE_CHANGE_COLUMNS)
        .maybeSingle();
      if (error) fail("Announce price change", error);
      return data ? PriceChangeSchema.parse(data) : null;
    },

    async callOffPriceChange(planKey) {
      const { data, error } = await db
        .rpc("operator_call_off_price_change", { plan: planKey })
        .select(PRICE_CHANGE_COLUMNS)
        .maybeSingle();
      if (error) fail("Call off price change", error);
      return data ? PriceChangeSchema.parse(data) : null;
    },

    async listPlanSubscribers(planKey) {
      const [organizations, subscriptions] = await Promise.all([
        every("List a plan's organizations", (from, to, first) =>
          db
            .from("organizations")
            .select("id", counted(first))
            .eq("plan_key", planKey)
            .eq("is_test", false)
            .order("created_at")
            .order("id")
            .range(from, to),
        ),
        every("List subscriptions", (from, to, first) =>
          db
            .from("subscriptions")
            .select("organization_id", counted(first))
            .not("stripe_subscription_id", "is", null)
            .order("created_at")
            .order("organization_id")
            .range(from, to),
        ),
      ]);
      const subscribed = new Set(
        z
          .array(z.object({ organization_id: z.uuid() }))
          .parse(subscriptions)
          .map((row) => row.organization_id),
      );
      return z
        .array(z.object({ id: z.uuid() }))
        .parse(organizations)
        .map((row) => row.id)
        .filter((id) => subscribed.has(id));
    },

    async listOpenPriceChanges() {
      const { data, error } = await db
        .from("price_changes")
        .select(PRICE_CHANGE_COLUMNS)
        .is("called_off_at", null)
        .is("completed_at", null)
        .order("announced_at");
      if (error) fail("List open price changes", error);
      return PriceChangeSchema.array().parse(data);
    },

    async listPriceChangeNotices(priceChangeId) {
      // One to an organization, with no time it was made and never taken away: a notice made
      // while the pages are read can at worst be read twice, never missed.
      const data = await every("List price change notices", (from, to, first) =>
        db
          .from("price_change_notices")
          .select(NOTICE_COLUMNS, counted(first))
          .eq("price_change_id", priceChangeId)
          .order("organization_id")
          .range(from, to),
      );
      return NoticeSchema.array().parse(data);
    },

    async getPriceChange(id) {
      const { data, error } = await db
        .from("price_changes")
        .select(PRICE_CHANGE_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) fail("Get price change", error);
      return data ? PriceChangeSchema.parse(data) : null;
    },

    async recordPriceChangeNotice(priceChangeId, organizationId, done) {
      // An upsert of only the fields given: the others keep what an earlier step wrote.
      const { error } = await db
        .from("price_change_notices")
        .upsert({ price_change_id: priceChangeId, organization_id: organizationId, ...done });
      if (error) fail("Record price change notice", error);
    },

    async markPriceChange(id, what, at) {
      const { error } = await db
        .from("price_changes")
        .update(what === "reminded" ? { reminded_at: at } : { completed_at: at })
        .eq("id", id);
      if (error) fail("Mark price change", error);
    },

    async getOpenLimitChange(planKey) {
      const { data, error } = await db
        .from("limit_changes")
        .select(LIMIT_CHANGE_COLUMNS)
        .eq("plan_key", planKey)
        .is("called_off_at", null)
        .is("completed_at", null)
        .maybeSingle();
      if (error) fail("Get open limit change", error);
      return data ? LimitChangeSchema.parse(data) : null;
    },

    async announceLimitChange(planKey, to, effectiveAt) {
      const { data, error } = await db
        .rpc("operator_announce_limit_change", {
          plan: planKey,
          queries_per_location: to.max_queries_per_location,
          plan_assistants: to.assistants,
          every_days: to.scan_every_days,
          manual_scans_per_month: to.max_manual_scans_per_month,
          report: to.emails_report,
          effective: effectiveAt,
          plan_allowances: to.allowances,
        })
        .select(LIMIT_CHANGE_COLUMNS)
        .maybeSingle();
      if (error) fail("Announce limit change", error);
      return data ? LimitChangeSchema.parse(data) : null;
    },

    async callOffLimitChange(planKey) {
      const { data, error } = await db
        .rpc("operator_call_off_limit_change", { plan: planKey })
        .select(LIMIT_CHANGE_COLUMNS)
        .maybeSingle();
      if (error) fail("Call off limit change", error);
      return data ? LimitChangeSchema.parse(data) : null;
    },

    async listPlanOrganizations(planKey) {
      const data = await every("List a plan's organizations", (from, to, first) =>
        db
          .from("organizations")
          .select("id", counted(first))
          .eq("plan_key", planKey)
          .eq("is_test", false)
          .order("created_at")
          .order("id")
          .range(from, to),
      );
      return z
        .array(z.object({ id: z.uuid() }))
        .parse(data)
        .map((row) => row.id);
    },

    async listOpenLimitChanges() {
      const { data, error } = await db
        .from("limit_changes")
        .select(LIMIT_CHANGE_COLUMNS)
        .is("called_off_at", null)
        .is("completed_at", null)
        .order("announced_at");
      if (error) fail("List open limit changes", error);
      return LimitChangeSchema.array().parse(data);
    },

    async getLatestMadeLimitChange(planKey) {
      const { data, error } = await db
        .from("limit_changes")
        .select(LIMIT_CHANGE_COLUMNS)
        .eq("plan_key", planKey)
        .gte("completed_at", new Date(Date.now() - 3_600_000).toISOString())
        .order("completed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail("Get the latest limit change made", error);
      return data ? LimitChangeSchema.parse(data) : null;
    },

    async listLimitChangeNotices(limitChangeId) {
      // One to an organization, as a price change's are, and read the same way.
      const data = await every("List limit change notices", (from, to, first) =>
        db
          .from("limit_change_notices")
          .select(LIMIT_NOTICE_COLUMNS, counted(first))
          .eq("limit_change_id", limitChangeId)
          .order("organization_id")
          .range(from, to),
      );
      return LimitNoticeSchema.array().parse(data);
    },

    async getLimitChange(id) {
      const { data, error } = await db
        .from("limit_changes")
        .select(LIMIT_CHANGE_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) fail("Get limit change", error);
      return data ? LimitChangeSchema.parse(data) : null;
    },

    async recordLimitChangeNotice(limitChangeId, organizationId, done) {
      const { error } = await db
        .from("limit_change_notices")
        .upsert({ limit_change_id: limitChangeId, organization_id: organizationId, ...done });
      if (error) fail("Record limit change notice", error);
    },

    async markLimitChangeReminded(id, at) {
      const { error } = await db.from("limit_changes").update({ reminded_at: at }).eq("id", id);
      if (error) fail("Mark limit change reminded", error);
    },

    async applyLimitChange(id) {
      const { data, error } = await db.rpc("apply_limit_change", { change_id: id });
      if (error) fail("Apply limit change", error);
      return data === true;
    },

    async getPlatformRole(userId) {
      // By the account's ID, not by what is readable: the operator can read everyone's role.
      const { data, error } = await db
        .from("platform_roles")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) fail("Get platform role", error);
      return data ? PlatformRoleSchema.parse(data.role) : null;
    },

    async listEveryOrganization() {
      const data = await every("List every organization", (from, to, first) =>
        db
          .from("organizations")
          .select(ORGANIZATION_COLUMNS, counted(first))
          .order("created_at")
          .order("id")
          .range(from, to),
      );
      return OrganizationSchema.array().parse(data);
    },

    async listEveryLocation() {
      const data = await every("List every location", (from, to, first) =>
        db
          .from("locations")
          .select(LOCATION_COLUMNS, counted(first))
          .order("created_at")
          .order("id")
          .range(from, to),
      );
      return LocationSchema.array().parse(data);
    },

    async countActiveQueries() {
      // One row for each active prompt everywhere: the first of these lists to outgrow a page.
      const data = await every("Count active queries", (from, to, first) =>
        db
          .from("tracked_queries")
          .select("location_id", counted(first))
          .eq("is_active", true)
          .order("created_at")
          .order("id")
          .range(from, to),
      );
      const counts: Record<string, number> = {};
      for (const row of z.array(z.object({ location_id: z.uuid() })).parse(data)) {
        counts[row.location_id] = (counts[row.location_id] ?? 0) + 1;
      }
      return counts;
    },

    async listScansSince(since) {
      // Read oldest first, so a scan made meanwhile lands past the end, and handed back newest
      // first as it is used.
      const data = await every("List recent scans", (from, to, first) =>
        db
          .from("scans")
          .select(
            "id, location_id, status, trigger, error, sample_data, created_at, site_check",
            counted(first),
          )
          .gte("created_at", since)
          .order("created_at")
          .order("id")
          .range(from, to),
      );
      return OperatorScanSchema.array().parse(data).reverse();
    },

    async listUsageByMonth(since) {
      const data = await every("List usage by month", (from, to, first) =>
        db
          .rpc("usage_by_month", { since }, counted(first))
          .order("month")
          .order("organization_id")
          .order("is_audit")
          .order("model")
          .range(from, to),
      );
      return UsageByMonthSchema.array().parse(data);
    },

    async listEveryAudit() {
      // Read oldest first and handed back newest first, as the scans are.
      const data = await every("List every audit", (from, to, first) =>
        db
          .from("audits")
          .select(LISTED_AUDIT_COLUMNS, counted(first))
          .order("created_at")
          .order("id")
          .range(from, to),
      );
      return ListedAuditSchema.array().parse(data).reverse();
    },

    async createAudit(input) {
      const { data, error } = await db
        .rpc("operator_create_audit", {
          p_business_name: input.business_name,
          p_website: input.website,
          p_city: input.city,
          p_region: input.region,
          p_country_code: input.country_code,
          p_prompts: input.prompts,
          p_samples: input.samples,
        })
        .select(LISTED_AUDIT_COLUMNS)
        .maybeSingle();
      if (error) fail("Create audit", error);
      return data ? ListedAuditSchema.parse(data) : null;
    },

    async listAccounts() {
      // Read oldest first and handed back newest first, as the function itself orders them.
      const data = await every("List accounts", (from, to, first) =>
        db
          .rpc("operator_accounts", undefined, counted(first))
          .order("created_at")
          .order("user_id")
          .range(from, to),
      );
      return AccountRowSchema.array().parse(data).reverse();
    },

    async listEveryMembership() {
      const data = await every("List every membership", (from, to, first) =>
        db
          .from("memberships")
          .select("user_id, organization_id", counted(first))
          .order("created_at")
          .order("organization_id")
          .order("user_id")
          .range(from, to),
      );
      return z.array(z.object({ user_id: z.uuid(), organization_id: z.uuid() })).parse(data);
    },

    async listPlatformRoles() {
      const data = await every("List platform roles", (from, to, first) =>
        db
          .from("platform_roles")
          .select("user_id, role", counted(first))
          .order("created_at")
          .order("user_id")
          .range(from, to),
      );
      const roles: Record<string, PlatformRole> = {};
      for (const row of z
        .array(z.object({ user_id: z.uuid(), role: PlatformRoleSchema }))
        .parse(data)) {
        roles[row.user_id] = row.role;
      }
      return roles;
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

    async activateLocation(id, insteadOf) {
      const { data, error } = await db
        .rpc("activate_location", { location: id, instead_of: insteadOf ?? null })
        .select(LOCATION_COLUMNS)
        .maybeSingle();
      if (error) fail("Activate location", error);
      return data ? LocationSchema.parse(data) : null;
    },

    async updateLocation(id, input) {
      const { data, error } = await db
        .from("locations")
        .update(input)
        .eq("id", id)
        .select(LOCATION_COLUMNS)
        .maybeSingle();
      if (error) fail("Update location", error);
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
        .select("id, location_id, kind, text, is_active, set_aside_by_plan, created_at")
        .eq("location_id", locationId)
        .order("created_at");
      if (error) fail("List tracked queries", error);
      return TrackedQuerySchema.array().parse(data);
    },

    async createQuery(locationId, input) {
      const { data, error } = await db
        .from("tracked_queries")
        .insert({ ...input, location_id: locationId })
        .select("id, location_id, kind, text, is_active, set_aside_by_plan, created_at")
        .single();
      if (error) fail("Create tracked query", error);
      return TrackedQuerySchema.parse(data);
    },

    async setQueryActive(id, active) {
      const { data, error } = await db
        .from("tracked_queries")
        .update({ is_active: active })
        .eq("id", id)
        .select("id, location_id, kind, text, is_active, set_aside_by_plan, created_at")
        .maybeSingle();
      if (error) fail("Update tracked query", error);
      return data ? TrackedQuerySchema.parse(data) : null;
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
        .select(RESULT_COLUMNS)
        .eq("scan_id", scanId);
      if (error) fail("List scan results", error);
      return ScanResultSchema.array().parse(data);
    },

    async listRecentResults(locationId, scans, sampleData) {
      if (scans <= 0) return [];
      const recent = await db
        .from("scans")
        .select("id")
        .eq("location_id", locationId)
        .eq("status", "succeeded")
        .eq("sample_data", sampleData)
        .order("created_at", { ascending: false })
        .limit(scans);
      if (recent.error) fail("List recent scans", recent.error);
      const ids = (recent.data ?? []).map((scan) => String(scan.id));
      if (ids.length === 0) return [];

      const { data, error } = await db
        .from("scan_results")
        .select(RESULT_COLUMNS)
        .in("scan_id", ids);
      if (error) fail("List recent results", error);
      const results = ScanResultSchema.array().parse(data);
      return ids.map((id) => results.filter((result) => result.scan_id === id));
    },

    async listResultsAround(locationId, at, scansBefore, scansSince, sampleData) {
      const scansOn = (side: "before" | "since") => {
        const query = db
          .from("scans")
          .select("id")
          .eq("location_id", locationId)
          .eq("status", "succeeded")
          .eq("sample_data", sampleData);
        return (side === "before" ? query.lt("created_at", at) : query.gte("created_at", at))
          .order("created_at", { ascending: false })
          .limit(side === "before" ? scansBefore : scansSince);
      };
      const [before, since] = await Promise.all([scansOn("before"), scansOn("since")]);
      if (before.error) fail("List scans before", before.error);
      if (since.error) fail("List scans since", since.error);
      const idsOf = (rows: { id: unknown }[] | null) => (rows ?? []).map((scan) => String(scan.id));
      const ids = { before: idsOf(before.data), since: idsOf(since.data) };
      const all = [...ids.before, ...ids.since];
      if (all.length === 0) return { before: [], since: [] };

      const { data, error } = await db
        .from("scan_results")
        .select(RESULT_COLUMNS)
        .in("scan_id", all);
      if (error) fail("List results around", error);
      const results = ScanResultSchema.array().parse(data);
      const byScan = (scans: string[]) =>
        scans.map((id) => results.filter((result) => result.scan_id === id));
      return { before: byScan(ids.before), since: byScan(ids.since) };
    },

    async listRecommendations(locationId) {
      const { data, error } = await db
        .from("recommendations")
        .select(RECOMMENDATION_COLUMNS)
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
        .select(RECOMMENDATION_COLUMNS)
        .maybeSingle();
      if (error) fail("Update recommendation", error);
      return data ? RecommendationSchema.parse(data) : null;
    },

    async setRecommendationActed(id, acted) {
      const { data, error } = await db
        .from("recommendations")
        // The database replaces the time with its own; null takes the mark back.
        .update({ acted_at: acted ? new Date().toISOString() : null })
        .eq("id", id)
        .select(RECOMMENDATION_COLUMNS)
        .maybeSingle();
      if (error) fail("Mark recommendation", error);
      return data ? RecommendationSchema.parse(data) : null;
    },

    async getAuditByToken(token) {
      const { data, error } = await db.rpc("get_audit", { p_token: token });
      if (error) fail("Get audit by token", error);
      return data ? StoredAuditSchema.parse(data) : null;
    },

    async recordVisit(visit) {
      const { data, error } = await db.rpc("record_visit", {
        site_key: visit.key,
        host: visit.host,
        from_assistant: visit.assistant,
        page: visit.path,
      });
      if (error) fail("Record a visit", error);
      return data === true;
    },

    async checkVisitLine(line) {
      const { data, error } = await db.rpc("check_visit_line", {
        site_key: line.key,
        host: line.host,
      });
      if (error) fail("Check a line", error);
      return data === true;
    },

    async getAudit(id) {
      const { data, error } = await db
        .from("audits")
        .select(
          "id, business_name, website, city, region, country_code, prompts, samples, status, revoked_at",
        )
        .eq("id", id)
        .maybeSingle();
      if (error) fail("Get audit", error);
      return data ? AuditJobSchema.parse(data) : null;
    },

    async recordAuditPart(id, promptIndex, part) {
      const { error } = await db.rpc("record_audit_part", {
        p_audit_id: id,
        p_index: promptIndex,
        p_part: part,
      });
      if (error) fail("Record audit part", error);
    },

    async failAudit(id, message) {
      const { error } = await db
        .from("audits")
        .update({ status: "failed", error: message.slice(0, 500) })
        .eq("id", id);
      if (error) fail("Fail audit", error);
    },

    async failStaleAudits(olderThan, message) {
      const { data, error } = await db
        .from("audits")
        .update({ status: "failed", error: message.slice(0, 500) })
        .eq("status", "queued")
        .lt("created_at", olderThan)
        .select("id");
      if (error) fail("Fail stale audits", error);
      return data?.length ?? 0;
    },

    async recordUsage(source, usage) {
      if (usage.length === 0) return;
      const { error } = await db
        .from("provider_usage")
        .insert(usage.map((row) => ({ ...source, ...row })));
      if (error) fail("Record usage", error);
    },

    async setLocationPoint(id, point) {
      const { error } = await db.from("locations").update(point).eq("id", id);
      if (error) fail("Keep a location's point", error);
    },

    async markScanRunning(id, sampleData) {
      const { error } = await db
        .from("scans")
        .update({
          status: "running",
          started_at: new Date().toISOString(),
          error: null,
          sample_data: sampleData,
        })
        .eq("id", id);
      if (error) fail("Mark scan running", error);
    },

    async getSiteCheck(locationId) {
      const { data, error } = await db
        .from("scans")
        .select("site_check")
        .eq("location_id", locationId)
        .eq("status", "succeeded")
        .order("finished_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail("Get site check", error);
      return data?.site_check ? SiteCheckSchema.parse(data.site_check) : null;
    },

    async getCitedPages(locationId) {
      const { data, error } = await db
        .from("scans")
        .select("cited_pages")
        .eq("location_id", locationId)
        .eq("status", "succeeded")
        .not("cited_pages", "is", null)
        .order("finished_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail("Get cited pages", error);
      return data?.cited_pages ? z.array(CitedPageSchema).parse(data.cited_pages) : [];
    },

    async completeScan(id, outcome) {
      // Written first: if completing then fails, the scan is retried and this is written again.
      const saved = await db
        .from("scans")
        .update({ site_check: outcome.site ?? null, cited_pages: outcome.cited_pages ?? null })
        .eq("id", id);
      if (saved.error) fail("Save site check", saved.error);

      const { error } = await db.rpc("complete_scan", {
        p_scan_id: id,
        p_score: outcome.score,
        p_results: outcome.results,
        p_recommendations: outcome.recommendations,
        p_alerts: outcome.alerts ?? { clear: [], raise: [] },
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

    async failStaleScans(olderThan, message) {
      const abandoned = {
        status: "failed",
        error: message.slice(0, 500),
        finished_at: new Date().toISOString(),
      };
      // A queued scan is timed from when it was requested, a running one from when it started.
      const queued = await db
        .from("scans")
        .update(abandoned)
        .eq("status", "queued")
        .lt("created_at", olderThan)
        .select("id");
      if (queued.error) fail("Fail stale queued scans", queued.error);
      const running = await db
        .from("scans")
        .update(abandoned)
        .eq("status", "running")
        .lt("started_at", olderThan)
        .select("id");
      if (running.error) fail("Fail stale running scans", running.error);
      return (queued.data?.length ?? 0) + (running.data?.length ?? 0);
    },

    async listLocationsDueForScan(limit) {
      const { data, error } = await db.rpc("locations_due_for_scan", { max_rows: limit });
      if (error) fail("List locations due for scan", error);
      return z.array(z.uuid()).parse(data ?? []);
    },

    async listOwnerEmails(organizationId) {
      return emailsOf(organizationId, ["owner"]);
    },

    async listManagerEmails(organizationId) {
      return emailsOf(organizationId, ["owner", "admin"]);
    },
  };
}
