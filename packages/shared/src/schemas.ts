import { z } from "zod";
import { allowanceErrors } from "./allowances";
import { PAGE_FETCHER_KEYS, type PageFetcher } from "./hosted-pages";
import { isCountry, normalizePhone, normalizePostalCode, normalizeWebsite } from "./inputs";

/**
 * Wire types shared by the API and the web app. Field names stay snake_case end to end so
 * rows from Postgres, API payloads, and client state are the same shape.
 */

export const QUERY_KINDS = ["ai_prompt", "search_keyword"] as const;
export const QueryKindSchema = z.enum(QUERY_KINDS);
export type QueryKind = z.infer<typeof QueryKindSchema>;

export const SURFACES = [
  "chatgpt",
  "gemini",
  "perplexity",
  "claude",
  "google_ai_overview",
  "google_local_pack",
  "google_organic",
] as const;
export const SurfaceSchema = z.enum(SURFACES);
export type Surface = z.infer<typeof SurfaceSchema>;

/** A prompt is asked of assistants; a keyword is searched on Google. */
export const SURFACES_BY_KIND: Record<QueryKind, readonly Surface[]> = {
  ai_prompt: ["chatgpt", "gemini", "perplexity", "claude"],
  search_keyword: ["google_local_pack", "google_organic", "google_ai_overview"],
};

/** The surfaces whose answers list the pages they were built from. */
export const CITING_SURFACES: readonly Surface[] = [
  ...SURFACES_BY_KIND.ai_prompt,
  "google_ai_overview",
];

export const SURFACE_LABELS: Record<Surface, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  perplexity: "Perplexity",
  claude: "Claude",
  google_ai_overview: "AI Overview",
  google_local_pack: "Map pack",
  google_organic: "Organic",
};

export const QUERY_KIND_LABELS: Record<QueryKind, string> = {
  ai_prompt: "Assistant prompt",
  search_keyword: "Google keyword",
};

export const SCAN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export const ScanStatusSchema = z.enum(SCAN_STATUSES);
export type ScanStatus = z.infer<typeof ScanStatusSchema>;

export const ScanTriggerSchema = z.enum(["manual", "scheduled"]);
export type ScanTrigger = z.infer<typeof ScanTriggerSchema>;

export const RecommendationStatusSchema = z.enum(["open", "done", "dismissed"]);
export type RecommendationStatus = z.infer<typeof RecommendationStatusSchema>;

const Id = z.uuid();
const Timestamp = z.string();

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * What a plan allows of one kind of work: true when it is included, or how many a month for
 * each location the plan covers. See `docs/adr/0012-a-plans-allowances-are-one-set.md`.
 */
export const AllowanceSchema = z.union([z.literal(true), z.number().int().positive()]);
export type Allowance = z.infer<typeof AllowanceSchema>;

/**
 * Allowances by kind (`ALLOWANCE_KINDS`). A kind that is absent is not included. A kind this
 * build does not know is kept as it came, so that saving a plan cannot drop it.
 */
export const AllowancesSchema = z.record(z.string(), AllowanceSchema);
export type Allowances = z.infer<typeof AllowancesSchema>;

/** How much of each counted allowance is used in a calendar month (UTC), by kind. */
export const AllowanceUseSchema = z.record(z.string(), z.number().int().nonnegative());
export type AllowanceUse = z.infer<typeof AllowanceUseSchema>;

/** What became of taking some of an allowance for a piece of work. */
export const AllowanceClaimSchema = z.object({
  /** False when the kind is not included, or the month's number would be passed. */
  claimed: z.boolean(),
  /**
   * The month's number, across the locations the plan covers. Null for a kind that is included
   * without a number, 0 for one that is not included.
   */
  allowed: z.number().int().nonnegative().nullable(),
  /** How much of the month is used, after this. */
  used: z.number().int().nonnegative(),
});
export type AllowanceClaim = z.infer<typeof AllowanceClaimSchema>;

export const OrganizationSchema = z.object({
  id: Id,
  name: z.string(),
  /** How many locations the organization may have. */
  max_locations: z.number().int().nonnegative(),
  /** How many active prompts and keywords each location may have. Retired ones do not count. */
  max_queries_per_location: z.number().int().nonnegative(),
  /**
   * How many scans members may start by hand, across the organization, in a calendar month
   * (UTC). The first scan it ever runs is not counted.
   */
  max_manual_scans_per_month: z.number().int().nonnegative(),
  /** How many days apart its locations are scanned. 1 is daily. */
  scan_every_days: z.number().int().positive(),
  /** The surfaces its scans check. Null means every surface that is set up. */
  surfaces: z.array(SurfaceSchema).nullable(),
  /**
   * True for an organization made by a test account. Its scans run on generated sample data and
   * the interface says so. See `docs/adr/0003-platform-roles-and-test-accounts.md`.
   */
  is_test: z.boolean(),
  /** Whether its owners are emailed a report after each scheduled scan. */
  emails_report: z.boolean(),
  /** The kinds of work it may have done, copied from its plan or set by the operator. */
  allowances: AllowancesSchema,
  /** The plan it is on. Null when its limits were set by hand, which no plan then changes. */
  plan_key: z.string().nullable(),
  created_at: Timestamp,
});
export type Organization = z.infer<typeof OrganizationSchema>;

/**
 * Something on sale: a price, and what an organization on it may do. Prices are US cents a month.
 * See `docs/adr/0006-plans-are-rows.md`.
 */
export const PlanSchema = z.object({
  key: z.string(),
  name: z.string(),
  /** The order plans are shown in, cheapest first. */
  position: z.number().int(),
  /** False for a plan no longer sold, which the organizations on it keep. */
  on_sale: z.boolean(),
  /** For the locations the plan includes. */
  price_cents: z.number().int().nonnegative(),
  included_locations: z.number().int().positive(),
  /** For each location beyond those. Null when no more can be added. */
  extra_location_price_cents: z.number().int().positive().nullable(),
  max_queries_per_location: z.number().int().nonnegative(),
  /** How many assistants its scans ask. Fewer than there are means the owner chooses which. */
  assistants: z.number().int().positive(),
  scan_every_days: z.number().int().positive(),
  /** Scans started by hand, across the organization, in a calendar month (UTC). */
  max_manual_scans_per_month: z.number().int().nonnegative(),
  /** Whether owners are emailed a report after each scan. */
  emails_report: z.boolean(),
  /** Whether its owner may pay for a stronger model. */
  stronger_models: z.boolean(),
  /** The kinds of work it includes. */
  allowances: AllowancesSchema,
});
export type Plan = z.infer<typeof PlanSchema>;

export const LocationSchema = z.object({
  id: Id,
  organization_id: Id,
  name: z.string(),
  website: z.string().nullable(),
  phone: z.string().nullable(),
  address_line: z.string().nullable(),
  city: z.string(),
  region: z.string().nullable(),
  postal_code: z.string().nullable(),
  country_code: z.string(),
  google_place_id: z.string().nullable(),
  primary_category: z.string().nullable(),
  /** What the business does, in its owner's words. A draft states nothing about it but this. */
  what_we_do: z.string().nullable(),
  /**
   * True while the organization has more locations than its plan covers and this is one of those
   * not being scanned. Everything measured so far stays readable.
   */
  paused_by_plan: z.boolean(),
  last_scanned_at: Timestamp.nullable(),
  created_at: Timestamp,
});
export type Location = z.infer<typeof LocationSchema>;

export const TrackedQuerySchema = z.object({
  id: Id,
  location_id: Id,
  kind: QueryKindSchema,
  text: z.string(),
  is_active: z.boolean(),
  /** True for a prompt made inactive because the plan covers fewer, not retired by its owner. */
  set_aside_by_plan: z.boolean(),
  created_at: Timestamp,
});
export type TrackedQuery = z.infer<typeof TrackedQuerySchema>;

/** Bringing a paused location back into use, and which location in use gives up its place. */
export const ActivateLocationSchema = z.object({
  instead_of: Id.nullish(),
});
export type ActivateLocation = z.infer<typeof ActivateLocationSchema>;

export const ScanSchema = z.object({
  id: Id,
  location_id: Id,
  status: ScanStatusSchema,
  trigger: ScanTriggerSchema,
  /** Scored over the window of recent scans this one closed, not from this scan alone. */
  visibility_score: z.number().nullable(),
  error: z.string().nullable(),
  /** True when the scan ran on generated sample data. Set by the worker when it starts. */
  sample_data: z.boolean(),
  created_at: Timestamp,
  started_at: Timestamp.nullable(),
  finished_at: Timestamp.nullable(),
});
export type Scan = z.infer<typeof ScanSchema>;

export const ScanResultSchema = z.object({
  id: Id,
  scan_id: Id,
  tracked_query_id: Id,
  surface: SurfaceSchema,
  mentioned: z.boolean(),
  position: z.number().int().positive().nullable(),
  competitors: z.array(z.string()),
  cited_urls: z.array(z.string()),
  answer_excerpt: z.string().nullable(),
  /** The phone numbers a written answer gave for the business, in international form. */
  phones: z.array(z.string()),
  sampled_at: Timestamp,
});
export type ScanResult = z.infer<typeof ScanResultSchema>;

export const RecommendationSchema = z.object({
  id: Id,
  location_id: Id,
  scan_id: Id.nullable(),
  rule: z.string(),
  title: z.string(),
  detail: z.string(),
  status: RecommendationStatusSchema,
  /** When a member said they did the work, or an action did it. A scan never changes it. */
  acted_at: Timestamp.nullable(),
  /** The action that did the work. A member cannot take back a mark that has one. */
  acted_by_action: Id.nullable(),
  created_at: Timestamp,
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

/**
 * What one scan or one prompt of an audit used on one surface with one model, added up over its
 * calls. Counts as the provider reported them. It holds no price: a count is turned into money
 * only on the server, from rates kept outside this repository.
 */
export const ProviderUsageSchema = z.object({
  /** The surface a check was of. Null for use that was not a check: a draft. */
  surface: SurfaceSchema.nullable(),
  /** The model that answered. */
  model: z.string(),
  /** How many calls the counts below are added up over. */
  calls: z.number().int().positive(),
  /** Input tokens charged at the full rate. */
  input_tokens: z.number().int().nonnegative(),
  /** Input tokens read from the provider's cache, charged at a lower rate. */
  cached_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  /** Web searches the provider ran and charges for. */
  searches: z.number().int().nonnegative(),
});
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

// ---------------------------------------------------------------------------
// The operator's view (docs/adr/0004-the-operator-reads-through-policies.md)
// ---------------------------------------------------------------------------

/** What an account is to the product itself. Most accounts have none. */
export const PLATFORM_ROLES = ["operator", "test"] as const;
export const PlatformRoleSchema = z.enum(PLATFORM_ROLES);
export type PlatformRole = z.infer<typeof PlatformRoleSchema>;

/**
 * The things worth the operator's attention, in the order they are shown: what is broken in the
 * product first, then what a customer is stuck on and may not know.
 */
export const ATTENTION_KINDS = [
  "organization_failing",
  "scan_failed",
  "scan_stuck",
  "scan_missed",
  "site_unloaded",
  "site_blocked",
  "audit_failed",
  // An action carried out more than 36 hours ago whose owners have not been told.
  "action_untold",
  "no_prompts",
  // A location with every prompt its plan allows. Having every location allowed is not listed.
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const AttentionItemSchema = z.object({
  kind: z.enum(ATTENTION_KINDS),
  organization_id: Id.nullable(),
  organization_name: z.string().nullable(),
  location_id: Id.nullable(),
  location_name: z.string().nullable(),
  audit_id: Id.nullable(),
  /** What happened, in a sentence. */
  detail: z.string(),
  /** When it happened, or null for a standing condition such as having no prompts. */
  at: Timestamp.nullable(),
});
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

const ScanCountSchema = z.object({
  total: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const OperatorOrganizationSchema = z.object({
  id: Id,
  name: z.string(),
  is_test: z.boolean(),
  /** True for an organization the operator is a member of. */
  is_yours: z.boolean(),
  created_at: Timestamp,
  locations: z.number().int().nonnegative(),
  max_locations: z.number().int().nonnegative(),
  /** Its most recent scan of any location, whatever became of it. */
  last_scan: z.object({ status: ScanStatusSchema, at: Timestamp }).nullable(),
  failed_7d: z.number().int().nonnegative(),
  scan_every_days: z.number().int().positive(),
  surfaces: z.array(SurfaceSchema).nullable(),
  /** The plan it is on. Null when its limits were set by hand. */
  plan_key: z.string().nullable(),
  /**
   * How many of its locations in use have every prompt their plan allows. A sign it may want a
   * larger plan; nothing is wrong, so it is not among the things needing attention.
   */
  locations_at_prompt_limit: z.number().int().nonnegative(),
});
export type OperatorOrganization = z.infer<typeof OperatorOrganizationSchema>;

/** What the operator's first screen shows. Test organizations are listed apart and never counted. */
export const OperatorOverviewSchema = z.object({
  totals: z.object({
    organizations: z.number().int().nonnegative(),
    locations: z.number().int().nonnegative(),
    scans_24h: ScanCountSchema,
    scans_7d: ScanCountSchema,
  }),
  attention: z.array(AttentionItemSchema),
  organizations: z.array(OperatorOrganizationSchema),
  test_organizations: z.array(OperatorOrganizationSchema),
  deployment: z.object({
    /** True when every scan in this deployment is generated. */
    sample_data: z.boolean(),
    /** The model each assistant is asked with, by surface. */
    models: z.record(z.string(), z.string()),
    /** The commit that was deployed, when the deploy recorded it. */
    commit: z.string().nullable(),
  }),
});
export type OperatorOverview = z.infer<typeof OperatorOverviewSchema>;

/**
 * How far an account has got, each stage including the ones before it: signed up, made an
 * organization, added a location, had a scan succeed, and had one succeed in the last week.
 */
export const ACCOUNT_STAGES = [
  "signed_up",
  "organization",
  "location",
  "scanned",
  "active",
] as const;
export type AccountStage = (typeof ACCOUNT_STAGES)[number];

export const OperatorAccountSchema = z.object({
  user_id: Id,
  email: z.string().nullable(),
  created_at: Timestamp,
  last_sign_in_at: Timestamp.nullable(),
  platform_role: PlatformRoleSchema.nullable(),
  /** The organization the account belongs to, when it has made or joined one. */
  organization_id: Id.nullable(),
  organization_name: z.string().nullable(),
  stage: z.enum(ACCOUNT_STAGES),
});
export type OperatorAccount = z.infer<typeof OperatorAccountSchema>;

/** Who has signed up and how far they got. Test accounts are listed and not counted. */
export const OperatorAccountsSchema = z.object({
  funnel: z.array(
    z.object({ stage: z.enum(ACCOUNT_STAGES), count: z.number().int().nonnegative() }),
  ),
  accounts: z.array(OperatorAccountSchema),
});
export type OperatorAccounts = z.infer<typeof OperatorAccountsSchema>;

/** A shareable audit as the operator lists it. The link is the permission to read it. */
export const OperatorAuditSchema = z.object({
  id: Id,
  business_name: z.string(),
  city: z.string(),
  region: z.string().nullable(),
  status: z.enum(["queued", "ready", "failed"]),
  error: z.string().nullable(),
  created_at: Timestamp,
  expires_at: Timestamp,
  revoked_at: Timestamp.nullable(),
  /** Where the audit is read. Null once it is revoked or expired, when the link leads nowhere. */
  link: z.string().nullable(),
});
export type OperatorAudit = z.infer<typeof OperatorAuditSchema>;

/**
 * What was used at the providers in one calendar month (UTC), by one organization or by audits,
 * on one model. Counts only: `usageCost` turns them into money.
 */
export const UsageByMonthSchema = ProviderUsageSchema.omit({ surface: true, calls: true }).extend({
  /** "2026-10". */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  /** Null for an audit, and for an organization that has since been deleted. */
  organization_id: Id.nullable(),
  is_audit: z.boolean(),
  calls: z.number().int().nonnegative(),
});
export type UsageByMonth = z.infer<typeof UsageByMonthSchema>;

/** US dollars. Worked out on the server; the rates never leave it. */
const Dollars = z.number().nonnegative();

export const OperatorSpendMonthSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  /** Everything below, added up. Usage on a model with no known rate is not in it. */
  total: Dollars,
  /** Most spent first. An organization that used nothing is left out. */
  organizations: z.array(
    z.object({ organization_id: Id, name: z.string(), is_yours: z.boolean(), cost: Dollars }),
  ),
  /** Shareable audits, which belong to no organization. */
  audits: Dollars,
  /** Organizations deleted since. What their scans cost was still spent. */
  deleted: Dollars,
  /** Models that answered but have no rate, so their cost is unknown and missing from the total. */
  unpriced: z.array(z.object({ model: z.string(), calls: z.number().int().positive() })),
});
export type OperatorSpendMonth = z.infer<typeof OperatorSpendMonthSchema>;

/** Spend by calendar month in UTC, this month first. */
export const OperatorSpendSchema = z.object({ months: z.array(OperatorSpendMonthSchema) });
export type OperatorSpend = z.infer<typeof OperatorSpendSchema>;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Optional free text: trimmed, and blank collapses to null so the database never stores "". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

/** Required text that has to say something: a name is not a row of digits or punctuation. */
const named = (max: number, missing: string, empty: string) =>
  z
    .string()
    .trim()
    .min(1, missing)
    .max(max, `Use at most ${max} characters`)
    .refine((value) => /\p{L}/u.test(value), empty);

export const OrganizationInputSchema = z.object({
  name: named(120, "Name is required", "Enter the organization's name"),
});
export type OrganizationInput = z.output<typeof OrganizationInputSchema>;

/**
 * The limits the operator may set on an organization. Which surfaces it is checked on is not
 * among them. Lowering a limit removes nothing: it only stops more being added.
 */
const limit = (least: number, most: number) =>
  z
    .number({ error: "Enter a whole number" })
    .int("Enter a whole number")
    .min(least, `Enter ${least} or more`)
    .max(most, `Enter ${most.toLocaleString("en-US")} or fewer`);

/**
 * Allowances as the operator sets them: only kinds that exist, each with a value its kind takes.
 * The first thing wrong is the message, since the fields share one place to show it.
 */
const allowancesInput = z
  .record(z.string(), z.union([z.literal(true), z.number()]))
  .superRefine((allowances, ctx) => {
    const [message] = Object.values(allowanceErrors(allowances));
    if (message) ctx.addIssue({ code: "custom", message });
  });

export const OrganizationLimitsSchema = z.object({
  max_locations: limit(0, 1000),
  max_queries_per_location: limit(0, 200),
  max_manual_scans_per_month: limit(0, 100_000),
  /** 1 is daily. */
  scan_every_days: limit(1, 30),
  allowances: allowancesInput,
});
export type OrganizationLimits = z.infer<typeof OrganizationLimitsSchema>;

/**
 * What the operator may change on a plan. A change to a limit reaches every organization on the
 * plan at once. Prices and the locations a plan includes are changed elsewhere.
 */
export const PlanSettingsSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(40, "Use 40 characters or fewer"),
  on_sale: z.boolean(),
  max_queries_per_location: limit(0, 200),
  /** How many assistants its scans ask. */
  assistants: limit(1, 2),
  /** 1 is daily. */
  scan_every_days: limit(1, 30),
  max_manual_scans_per_month: limit(0, 100_000),
  emails_report: z.boolean(),
  allowances: allowancesInput,
});
export type PlanSettings = z.infer<typeof PlanSettingsSchema>;

/** A price in US cents a month: at least a dollar, and not so much that it is surely a slip. */
const monthlyPrice = z
  .number({ error: "Enter a price" })
  .int("Enter a price in dollars and cents")
  .min(100, "Enter $1 or more")
  .max(1_000_000, "Enter $10,000 or less");

/**
 * What a plan is sold at from now: to new subscribers at once. Current subscribers keep the
 * price they pay until a change is announced to them.
 */
export const PlanPricesInputSchema = z.object({
  /** A month, in US cents, for the locations the plan includes. */
  price_cents: monthlyPrice,
  /** A month, in US cents, for each location beyond those. Null sells no more than it includes. */
  extra_location_price_cents: monthlyPrice.nullable(),
});
export type PlanPricesInput = z.infer<typeof PlanPricesInputSchema>;

/**
 * An announcement that a plan's current subscribers move to its present prices: each at their
 * first renewal on or after `effective_at`.
 */
export const PriceChangeSchema = z.object({
  id: Id,
  plan_key: z.string(),
  /** The provider's name for the plan's price they are moved to, which names the version. */
  stripe_price_id: z.string(),
  effective_at: Timestamp,
  announced_at: Timestamp,
  reminded_at: Timestamp.nullable(),
  called_off_at: Timestamp.nullable(),
  completed_at: Timestamp.nullable(),
});
export type PriceChange = z.infer<typeof PriceChangeSchema>;

/** The day an announced price change takes effect, as the operator picks it. */
export const PriceChangeInputSchema = z.object({
  effective_on: z.iso.date("Choose a day"),
});
export type PriceChangeInput = z.infer<typeof PriceChangeInputSchema>;

/** What a price change does for one organization, one step at a time. */
export const PRICE_CHANGE_STEPS = ["announce", "remind", "call_off", "move"] as const;
export type PriceChangeStep = (typeof PRICE_CHANGE_STEPS)[number];

/** A message asking the worker to take one step of a price change for one organization. */
export const PriceChangeMessageSchema = z.object({
  price_change_id: Id,
  organization_id: Id,
  step: z.enum(PRICE_CHANGE_STEPS),
});
export type PriceChangeMessage = z.infer<typeof PriceChangeMessageSchema>;

/**
 * Allowances that go down, by kind, each with what it was and what it becomes. A kind taken away
 * becomes false.
 */
export const LoweredAllowancesSchema = z.record(
  z.string(),
  z.object({
    from: AllowanceSchema,
    to: z.union([z.literal(false), z.number().int().positive()]),
  }),
);
export type LoweredAllowances = z.infer<typeof LoweredAllowancesSchema>;

/** The limits of a plan that can go down, each with what it was and what it becomes. */
export const LoweredLimitsSchema = z
  .object({
    max_queries_per_location: z.object({ from: z.number().int(), to: z.number().int() }),
    assistants: z.object({ from: z.number().int(), to: z.number().int() }),
    scan_every_days: z.object({ from: z.number().int(), to: z.number().int() }),
    max_manual_scans_per_month: z.object({ from: z.number().int(), to: z.number().int() }),
    emails_report: z.object({ from: z.boolean(), to: z.boolean() }),
    allowances: LoweredAllowancesSchema,
  })
  .partial();
export type LoweredLimits = z.infer<typeof LoweredLimitsSchema>;

/**
 * A reduction in what a plan allows, announced for a day: made for everyone on the plan on
 * `effective_at`. The free plan's are made at once and arrive already completed.
 */
export const LimitChangeSchema = z.object({
  id: Id,
  plan_key: z.string(),
  lowered: LoweredLimitsSchema,
  effective_at: Timestamp,
  announced_at: Timestamp,
  reminded_at: Timestamp.nullable(),
  called_off_at: Timestamp.nullable(),
  completed_at: Timestamp.nullable(),
});
export type LimitChange = z.infer<typeof LimitChangeSchema>;

/** What telling an organization of a reduction comes to, one step at a time. */
export const LIMIT_CHANGE_STEPS = ["announce", "remind", "call_off"] as const;
export type LimitChangeStep = (typeof LIMIT_CHANGE_STEPS)[number];

/** A message asking the worker to tell one organization one thing about a reduction. */
export const LimitChangeMessageSchema = z.object({
  limit_change_id: Id,
  organization_id: Id,
  step: z.enum(LIMIT_CHANGE_STEPS),
});
export type LimitChangeMessage = z.infer<typeof LimitChangeMessageSchema>;

/**
 * What the operator sends to change a plan. `reduce_on` is the day any reductions take effect,
 * needed when subscribers pay for the plan: whatever goes down waits for it, and the rest is
 * saved at once.
 */
export const PlanChangeInputSchema = PlanSettingsSchema.extend({
  reduce_on: z.iso.date("Choose a day").optional(),
});
export type PlanChangeInput = z.infer<typeof PlanChangeInputSchema>;

/** A plan as the operator sees it: what is on sale, and who is on it. Test organizations are left out. */
export const OperatorPlanSchema = PlanSchema.extend({
  /** How many organizations are on it. */
  organizations: z.number().int().nonnegative(),
  /** How many of those have a subscription in force. */
  subscribers: z.number().int().nonnegative(),
  /** What those subscribers pay a month between them, in US cents and before tax. */
  monthly_cents: z.number().int().nonnegative(),
  /**
   * True when the plan has a price at the payment provider, so it can be bought. A paid plan
   * without one is listed and cannot be subscribed to until its prices are saved.
   */
  at_provider: z.boolean(),
  /** The change announced to its current subscribers and not yet finished or called off. */
  price_change: PriceChangeSchema.extend({
    /** How many organizations' owners have been sent the announcement. */
    told: z.number().int().nonnegative(),
    /** How many subscriptions have been moved to the new prices. */
    moved: z.number().int().nonnegative(),
  }).nullable(),
  /** The reduction announced to everyone on it and not yet made or called off. */
  limit_change: LimitChangeSchema.extend({
    /** How many organizations' owners have been sent the announcement. */
    told: z.number().int().nonnegative(),
    /** The organizations on the plan whose owners have not been, by name. */
    not_told: z.array(z.string()),
  }).nullable(),
});
export type OperatorPlan = z.infer<typeof OperatorPlanSchema>;

/** Who a change to a plan's limits would reach, shown to the operator before a limit is lowered. */
export const PlanImpactSchema = z.object({
  /** How many organizations are on the plan. */
  organizations: z.number().int().nonnegative(),
  /** How many of them have a location with more active prompts than the plan would allow. */
  prompts_set_aside: z.number().int().nonnegative(),
});
export type PlanImpact = z.infer<typeof PlanImpactSchema>;

/** Whether the fields a cross-field check reads came through their own checks. */
const sound =
  (...fields: string[]) =>
  (payload: { issues: readonly { path?: readonly PropertyKey[] }[] }) =>
    payload.issues.every((issue) => !fields.includes(String(issue.path?.[0])));

/** A web address as typed, given its scheme. Blank is none. */
const Website = optionalText(200).transform((typed, context) => {
  if (typed === null) return null;
  const website = normalizeWebsite(typed);
  if (website === null) {
    context.addIssue({ code: "custom", message: "Enter a web address, like joespizza.com" });
    return z.NEVER;
  }
  return website;
});

const CountryCode = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isCountry, "Use a two-letter country code, like US")
  .default("US");

/** How much an owner may say about what the business does: a few sentences. */
export const WHAT_WE_DO_MAX = 600;

export const LocationInputSchema = z
  .object({
    name: named(120, "Name is required", "Enter the business's name"),
    website: Website,
    phone: optionalText(40),
    address_line: optionalText(200),
    city: named(80, "City is required", "Enter the city's name"),
    region: optionalText(80),
    postal_code: optionalText(20),
    country_code: CountryCode,
    google_place_id: optionalText(200).refine(
      (value) => value === null || /^[A-Za-z0-9_-]{20,}$/.test(value),
      "Paste the place ID as Google gives it: letters, digits, - and _",
    ),
    primary_category: optionalText(120),
    /**
     * Blank is none, as for the other details. Left out is different here: what is on file stays.
     * A page opened before this field existed sends the whole form without it, and so do the forms
     * that add a location, and none of them should wipe what an owner wrote.
     */
    what_we_do: z
      .string()
      .trim()
      .max(WHAT_WE_DO_MAX, `Use at most ${WHAT_WE_DO_MAX} characters`)
      .nullable()
      .transform((value) => value || null)
      .optional(),
  })
  // The phone number and the postal code are read in the location's own country. These run even
  // when another field is wrong, so a form can show every problem at once.
  .refine(({ phone, country_code }) => !phone || normalizePhone(phone, country_code) !== null, {
    path: ["phone"],
    message: "Enter a full phone number, with the area code",
    when: sound("phone", "country_code"),
  })
  .refine(
    ({ postal_code, country_code }) =>
      !postal_code || "code" in normalizePostalCode(postal_code, country_code),
    {
      path: ["postal_code"],
      error: (issue) => {
        const { postal_code, country_code } = issue.input as Record<string, string>;
        const result = normalizePostalCode(postal_code ?? "", country_code ?? "");
        return "error" in result ? result.error : "Enter a postal code";
      },
      when: sound("postal_code", "country_code"),
    },
  )
  // Once everything is sound, both are put in the form they are stored in.
  .transform((location) => {
    const postal = location.postal_code
      ? normalizePostalCode(location.postal_code, location.country_code)
      : null;
    return {
      ...location,
      phone: location.phone ? normalizePhone(location.phone, location.country_code) : null,
      postal_code: postal && "code" in postal ? postal.code : null,
    };
  });
export type LocationInput = z.output<typeof LocationInputSchema>;
export type LocationFormValues = z.input<typeof LocationInputSchema>;

export const TrackedQueryInputSchema = z.object({
  kind: QueryKindSchema,
  text: z
    .string()
    .trim()
    .min(1, "Enter a prompt or keyword")
    .max(300, "Use at most 300 characters")
    .refine((value) => (value.match(/\p{L}/gu)?.length ?? 0) >= 3, "Use at least three letters"),
});
export type TrackedQueryInput = z.output<typeof TrackedQueryInputSchema>;

/** The assistants a plan's scans can ask. A plan with fewer lets the owner choose which. */
export const PLAN_ASSISTANTS = ["chatgpt", "claude"] as const satisfies readonly Surface[];

/** An owner's choice of assistants. How many it must name is the plan's to say. */
export const AssistantChoiceSchema = z.object({
  surfaces: z.array(z.enum(PLAN_ASSISTANTS)).min(1, "Choose an assistant"),
});
export type AssistantChoice = z.infer<typeof AssistantChoiceSchema>;

/** The plan an owner is subscribing to, and how many locations they are paying for. */
export const CheckoutInputSchema = z.object({
  plan_key: z.string().min(1).max(31),
  /** Left out, it is what the plan includes. More than that is paid for one at a time. */
  locations: limit(1, 1000).optional(),
});
export type CheckoutInput = z.infer<typeof CheckoutInputSchema>;

/**
 * What Account settings shows beyond the organization itself: how much of the month's allowance
 * is used, and, for the organization's owner alone, where it stands with the payment provider.
 */
export const OrganizationAccountSchema = z.object({
  /** Scans started by hand this calendar month (UTC) that count against the plan. */
  manual_scans_used: z.number().int().nonnegative(),
  /** What it has used of its counted allowances this calendar month. None used is absent. */
  allowance_use: AllowanceUseSchema,
  /**
   * A reduction announced for the organization's plan and not made yet: what goes down, and the
   * day. Anyone in the organization is shown it.
   */
  limit_change: z.object({ lowered: LoweredLimitsSchema, at: Timestamp }).nullable(),
  /** Null for everyone but the organization's owner, who alone manages billing. */
  billing: z
    .object({
      /** False where this deployment has no payment provider set up: nobody can subscribe. */
      available: z.boolean(),
      /** True while it has a subscription, whether paid up or being retried. */
      subscribed: z.boolean(),
      /** The provider's own word for the subscription: active, past_due, canceled and so on. */
      status: z.string().nullable(),
      /** True once it has been through checkout, so the provider has account pages to open. */
      has_customer: z.boolean(),
      /** How many locations the subscription pays for. Null when there is none, or not known. */
      locations: z.number().int().positive().nullable(),
      /** When the period paid for ends and the next begins. Null when there is none. */
      renews_at: Timestamp.nullable(),
      /**
       * The prices the subscription is billed at, in US cents a month before tax, which may be
       * older than what the plan is sold at now. Null when there is none, or not known.
       */
      paying: z
        .object({
          price_cents: z.number().int().nonnegative(),
          extra_location_price_cents: z.number().int().positive().nullable(),
          monthly_cents: z.number().int().nonnegative(),
        })
        .nullable(),
      /**
       * A price change announced for the plan that this subscription has not been moved to yet:
       * what it will come to a month, in US cents before tax, from its first renewal on or
       * after `at`.
       */
      price_change: z
        .object({ monthly_cents: z.number().int().nonnegative(), at: Timestamp })
        .nullable(),
      /** A smaller plan or fewer locations chosen, waiting for the period paid for to end. */
      pending: z
        .object({
          plan_key: z.string(),
          locations: z.number().int().positive(),
          /** What it will cost a month, in US cents, before tax. */
          monthly_cents: z.number().int().nonnegative(),
          at: Timestamp,
        })
        .nullable(),
    })
    .nullable(),
});
export type OrganizationAccount = z.infer<typeof OrganizationAccountSchema>;

/**
 * A change to a subscription, as the owner is shown it before confirming and as it was made.
 * Paying more a month is an upgrade and happens at once; paying less is a downgrade and waits
 * for the period already paid for to end.
 */
export const SubscriptionChangeSchema = z.object({
  kind: z.enum(["upgrade", "downgrade"]),
  plan_key: z.string(),
  locations: z.number().int().positive(),
  /** The new price a month, in US cents, before tax. */
  monthly_cents: z.number().int().nonnegative(),
  /** An upgrade: what is charged now for the rest of the period, with tax. Otherwise null. */
  due_now_cents: z.number().int().nullable(),
  /** A downgrade: when it takes effect. Otherwise null. */
  effective_at: Timestamp.nullable(),
});
export type SubscriptionChange = z.infer<typeof SubscriptionChangeSchema>;

/** Where to send the owner next: the payment provider's checkout, or its account pages. */
export const BillingRedirectSchema = z.object({ url: z.url() });
export type BillingRedirect = z.infer<typeof BillingRedirectSchema>;

export const AUDIT_MAX_PROMPTS = 5;
export const AUDIT_MAX_SAMPLES = 5;

/**
 * A shareable audit to make: a business that has not signed up, and what to ask about it. Every
 * prompt is asked `samples` times on every assistant, so each one costs real money.
 */
export const AuditInputSchema = z.object({
  business_name: named(120, "Name is required", "Enter the business's name"),
  website: Website,
  city: named(80, "City is required", "Enter the city's name"),
  region: optionalText(80),
  country_code: CountryCode,
  prompts: z
    .array(
      z
        .string()
        .trim()
        .min(1, "Enter a prompt")
        .max(200, "Use at most 200 characters")
        .refine(
          (value) => (value.match(/\p{L}/gu)?.length ?? 0) >= 3,
          "Use at least three letters",
        ),
    )
    .min(1, "Give at least one prompt")
    .max(AUDIT_MAX_PROMPTS, `Give at most ${AUDIT_MAX_PROMPTS} prompts`)
    .refine(
      (prompts) => new Set(prompts.map((prompt) => prompt.toLowerCase())).size === prompts.length,
      "Two prompts are the same",
    ),
  samples: z
    .number({ error: "Enter a whole number" })
    .int("Enter a whole number")
    .min(1, "Enter 1 or more")
    .max(AUDIT_MAX_SAMPLES, `Enter ${AUDIT_MAX_SAMPLES} or fewer`)
    .default(AUDIT_MAX_SAMPLES),
});
export type AuditInput = z.output<typeof AuditInputSchema>;
export type AuditFormValues = z.input<typeof AuditInputSchema>;

/** Retires a prompt (false) or restores it (true). A retired prompt keeps its results. */
export const TrackedQueryUpdateSchema = z.object({
  is_active: z.boolean(),
});
export type TrackedQueryUpdate = z.output<typeof TrackedQueryUpdateSchema>;

/** One or both: the status, and whether the member has done the work. */
export const RecommendationUpdateSchema = z
  .object({
    status: RecommendationStatusSchema.optional(),
    acted: z.boolean().optional(),
  })
  .refine((update) => update.status !== undefined || update.acted !== undefined, {
    message: "Give a status, or say whether the work was done.",
  });
export type RecommendationUpdate = z.output<typeof RecommendationUpdateSchema>;

// ---------------------------------------------------------------------------
// API responses
// ---------------------------------------------------------------------------

/**
 * The kinds of outside account that can be connected. `sample` stands in for a real one where
 * the data is generated. `wordpress` is a business's own WordPress site (`wordpress.ts`).
 * `hosted_pages` is an answer subdomain of the business's own domain, which the product serves
 * pages on (`hosted-pages.ts`); it has no sign-in. See
 * `docs/adr/0013-a-sign-in-is-sealed-by-the-worker.md`.
 */
export const CONNECTION_KINDS = ["sample", "wordpress", "hosted_pages"] as const;
export const ConnectionKindSchema = z.enum(CONNECTION_KINDS);
export type ConnectionKind = z.infer<typeof ConnectionKindSchema>;

export const CONNECTION_KIND_LABELS: Record<ConnectionKind, string> = {
  sample: "Sample account",
  wordpress: "WordPress site",
  hosted_pages: "Answer subdomain",
};

/**
 * The allowance an organization needs to have a kind of connection, or null for a kind that
 * needs none. The database holds the same in `connection_kind_allowances`.
 */
export const CONNECTION_KIND_ALLOWANCES: Record<ConnectionKind, string | null> = {
  sample: null,
  wordpress: "wordpress",
  hosted_pages: "hosted_pages",
};

/**
 * Why a connection is broken: the outside service refused the sign-in, which waits for its
 * owner, or reading from it failed three days in a row, which is still tried once a day.
 */
export const BROKEN_REASONS = ["refused", "failing"] as const;
export type BrokenReason = (typeof BROKEN_REASONS)[number];

/**
 * Where a connection stands. `broken` cannot be read from. `paused` is one the organization's
 * plan no longer includes: nothing is read or done, and its sign-in is kept for thirty days.
 * `removing` is asked to be removed and waiting for the worker to withdraw access and delete the
 * sign-in; `removed` is done, and kept as a record.
 */
export const CONNECTION_STATUSES = ["working", "broken", "paused", "removing", "removed"] as const;
export const ConnectionStatusSchema = z.enum(CONNECTION_STATUSES);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

/** One thing a connection's sign-in reaches: a profile, a site, a property. */
export const ConnectionChoiceSchema = z.object({
  /** What the outside service calls it. */
  id: z.string().min(1),
  label: z.string(),
});
export type ConnectionChoice = z.infer<typeof ConnectionChoiceSchema>;

/** Which of a connection's choices is a location's. */
export const ConnectionMatchSchema = z.object({
  location_id: Id,
  external_id: z.string(),
  /** What the choice was called when it was chosen, or at the last sync since. */
  external_label: z.string(),
  matched_at: Timestamp,
});
export type ConnectionMatch = z.infer<typeof ConnectionMatchSchema>;

/**
 * An organization's standing sign-in to an outside account, as its members see it. The sign-in
 * itself is never part of this: only the worker reads it.
 */
export const ConnectionSchema = z.object({
  id: Id,
  organization_id: Id,
  kind: ConnectionKindSchema,
  /** What its owner knows the account by at the outside service. */
  label: z.string(),
  status: ConnectionStatusSchema,
  /** Who connected it, as the address they had then. */
  connected_by_email: z.string().nullable(),
  connected_at: Timestamp,
  /** Who asked for it to be removed. */
  removed_by_email: z.string().nullable(),
  removal_requested_at: Timestamp.nullable(),
  /** When the worker had withdrawn access and deleted the sign-in. */
  removed_at: Timestamp.nullable(),
  /** Why it is broken, while it is. */
  broken_reason: z.enum(BROKEN_REASONS).nullable(),
  broken_at: Timestamp.nullable(),
  /** When its plan stopped including it. Thirty days on, its sign-in is removed. */
  paused_at: Timestamp.nullable(),
  /**
   * Why it was removed: someone asked, its plan had stopped including it, or, for an answer
   * subdomain, it never started working, or its location was removed.
   */
  removal_reason: z.enum(["asked", "plan", "unclaimed", "location"]).nullable(),
  /** When the worker last read from it. Null until the first sync, moments after connecting. */
  last_synced_at: Timestamp.nullable(),
  /** What the sign-in reaches, as the last sync found it. */
  choices: z.array(ConnectionChoiceSchema),
  /** Which of those is each location's. A location with none is not matched. */
  matches: z.array(ConnectionMatchSchema),
});
export type Connection = z.infer<typeof ConnectionSchema>;

/** What is sent to say which of a connection's choices is a location's. */
export const ConnectionMatchInputSchema = z.object({
  external_id: z.string().trim().min(1, "Choose one").max(300),
});
export type ConnectionMatchInput = z.infer<typeof ConnectionMatchInputSchema>;

/** An account a location is matched to, as the location's own page shows it. */
export const LocationConnectionSchema = z.object({
  connection_id: Id,
  kind: ConnectionKindSchema,
  /** The account. */
  label: z.string(),
  /** Which of the things it reaches is this location's. */
  external_label: z.string(),
});
export type LocationConnection = z.infer<typeof LocationConnectionSchema>;

/** What the Connections page shows for an organization. */
export const OrganizationConnectionsSchema = z.object({
  /**
   * The kinds that can be connected here now. Empty where this deployment holds no key to seal
   * a sign-in with.
   */
  available: z.array(ConnectionKindSchema),
  /** True for the organization's owner or an admin, who alone may connect and remove. */
  can_manage: z.boolean(),
  /** Every connection it has or had, newest first. */
  connections: z.array(ConnectionSchema),
});
export type OrganizationConnections = z.infer<typeof OrganizationConnectionsSchema>;

/** What is sent to connect an account. */
export const ConnectionInputSchema = z.object({ kind: ConnectionKindSchema });
export type ConnectionInput = z.infer<typeof ConnectionInputSchema>;

/**
 * What checking a location's website for WordPress found (`wordpress.ts`): `ready` to send its
 * owner to approve, `not_wordpress`, `passwords_off` (WordPress, with application passwords
 * switched off), `unreachable`, or `no_website` on file.
 */
export const WORDPRESS_CHECKS = [
  "ready",
  "not_wordpress",
  "passwords_off",
  "unreachable",
  "no_website",
] as const;
export const WordPressCheckSchema = z.object({
  verdict: z.enum(WORDPRESS_CHECKS),
  /** Where the site asks its owner to approve the connection. Only when `ready`. */
  authorize_url: z.string().nullable(),
  /** What the site calls itself, when it said. */
  site_name: z.string().nullable(),
});
export type WordPressCheck = z.infer<typeof WordPressCheckSchema>;

/**
 * What WordPress hands back once its owner approves: the site, their user name and the
 * application password it made. Sent once, to be sealed, and never returned.
 */
export const WordPressApprovedSchema = z.object({
  site_url: z.string().trim().min(1).max(500),
  user_login: z.string().trim().min(1).max(200),
  password: z.string().trim().min(1).max(200),
});
export type WordPressApproved = z.infer<typeof WordPressApprovedSchema>;

/**
 * What the worker last found an answer subdomain's name pointing at: nothing, the connection's own
 * target, a Cloudflare proxy that hides where it points, or something else.
 */
export const ANSWER_RECORDS = ["missing", "ours", "proxied", "elsewhere"] as const;
export type AnswerRecord = (typeof ANSWER_RECORDS)[number];

/**
 * A location's answer subdomain, as its Website tab shows it (`hosted-pages.ts`): the name, the
 * one record its owner adds, and how far it has got.
 */
export const AnswerSubdomainSchema = z.object({
  connection_id: Id,
  location_id: Id,
  hostname: z.string(),
  /** The name the owner's record points at, which is this connection's alone. */
  target: z.string(),
  /** What the name pointed at when it was last looked up. Null before the first look. */
  record: z.enum(ANSWER_RECORDS).nullable(),
  checked_at: Timestamp.nullable(),
  /** When it was registered to be served, once its record pointed at its own target. */
  registered_at: Timestamp.nullable(),
  /** When it was first served with its certificate. */
  live_at: Timestamp.nullable(),
  /** Whether the business's home page links to it, as the worker last read it. */
  home_links: z.boolean().nullable(),
  /** False once the location's website is no longer the domain it sits under. */
  website_matches: z.boolean(),
  /** The day the worker stops waiting for it to start working, while it is waiting. */
  waits_until: Timestamp.nullable(),
  status: ConnectionStatusSchema,
  paused_at: Timestamp.nullable(),
});
export type AnswerSubdomain = z.infer<typeof AnswerSubdomainSchema>;

/**
 * Why a location cannot have hosted pages now, where it cannot: its plan does not include them,
 * this deployment cannot serve them, its website is not on file or is at a site builder's own
 * address, or its WordPress site is connected and pages go there.
 */
export const HOSTED_PAGES_BARS = [
  "not_included",
  "unavailable",
  "no_website",
  "no_own_domain",
  "wordpress",
] as const;

/** A location's hosted pages, as its Website tab shows them. */
export const LocationHostedPagesSchema = z.object({
  /** What stands in the way of connecting one. Null where one can be. */
  barred: z.enum(HOSTED_PAGES_BARS).nullable(),
  /** True for the organization's owner or an admin, who alone may connect and remove. */
  can_manage: z.boolean(),
  /** The location's answer subdomain, while it has one. */
  subdomain: AnswerSubdomainSchema.nullable(),
  /** The last one it had, once removed, until another is set up: what it was and why it went. */
  removed: z
    .object({
      hostname: z.string(),
      removal_reason: ConnectionSchema.shape.removal_reason,
      removed_at: Timestamp.nullable(),
    })
    .nullable(),
});
export type LocationHostedPages = z.infer<typeof LocationHostedPagesSchema>;

/** What is sent to make an answer subdomain: the one word in front of the website's domain. */
export const AnswerSubdomainInputSchema = z.object({
  label: z.string().trim().min(1, "Enter a name").max(63),
});
export type AnswerSubdomainInput = z.infer<typeof AnswerSubdomainInputSchema>;

/**
 * A business as its hosted pages show it: what its location holds of who and where it is, which
 * the page states anyway. Nothing else about the location is answered to anyone.
 */
export const HostedBusinessSchema = z.object({
  name: z.string(),
  website: z.string().nullable(),
  address_line: z.string().nullable(),
  city: z.string(),
  region: z.string().nullable(),
  postal_code: z.string().nullable(),
  country_code: z.string(),
  phone: z.string().nullable(),
});
export type HostedBusiness = z.infer<typeof HostedBusinessSchema>;

/** A page that is live on an answer subdomain, as its list and its sitemap name it. */
export const HostedPageEntrySchema = z.object({
  slug: z.string(),
  title: z.string(),
  published_at: Timestamp,
});
export type HostedPageEntry = z.infer<typeof HostedPageEntrySchema>;

/**
 * What `hosted_page()` answers anyone for one address on an answer subdomain that is served: the
 * list of its pages at `/`, a live page, a page that was taken back, or nothing there. A host that
 * is not served is answered with null, before any of these.
 */
export const HostedAnswerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("list"),
    business: HostedBusinessSchema,
    pages: z.array(HostedPageEntrySchema),
  }),
  z.object({
    kind: z.literal("page"),
    business: HostedBusinessSchema,
    title: z.string(),
    copy: z.string(),
    published_at: Timestamp,
  }),
  z.object({ kind: z.literal("gone"), business: HostedBusinessSchema }),
  z.object({ kind: z.literal("missing"), business: HostedBusinessSchema }),
  // Thirty days into a pause, every address sends a visitor on to the business's own site.
  z.object({ kind: z.literal("redirect"), business: HostedBusinessSchema, to: z.string() }),
]);
export type HostedAnswer = z.infer<typeof HostedAnswerSchema>;

/** What the worker is asked to do for one connection. */
export const CONNECTION_STEPS = ["remove", "sync"] as const;
export type ConnectionStep = (typeof CONNECTION_STEPS)[number];

/** A message asking the worker to take one step for one connection. */
export const ConnectionMessageSchema = z.object({
  connection_id: Id,
  step: z.enum(CONNECTION_STEPS),
});
export type ConnectionMessage = z.infer<typeof ConnectionMessageSchema>;

/**
 * The kinds of action: what the product can do outside itself for a business. `sample` changes
 * a made-up line on a sample listing, where the data is generated. `wordpress_details` puts the
 * business details block at the end of a WordPress home page (`wordpress.ts`), and
 * `wordpress_page` publishes a page task's copy as a new page of the site (`pages.ts`), and
 * `hosted_page` serves it on the location's answer subdomain (`hosted-pages.ts`). See
 * `docs/adr/0014-only-the-worker-carries-out-an-action.md`.
 */
export const ACTION_KINDS = [
  "sample",
  "wordpress_details",
  "wordpress_page",
  "hosted_page",
] as const;
export const ActionKindSchema = z.enum(ACTION_KINDS);
export type ActionKind = z.infer<typeof ActionKindSchema>;

/**
 * The kinds of action whose text a member may change before saying yes. The details block is
 * composed by rule from what the location holds and goes onto a business's site as it is, so it
 * is approved as proposed or declined. A page's copy is prose, written onto the page as text.
 */
export const EDITABLE_ACTION_KINDS: readonly ActionKind[] = [
  "sample",
  "wordpress_page",
  "hosted_page",
];

/**
 * Where an action stands. `proposed` waits for a member's yes. `approved` is on its way to
 * being carried out by the worker, and ends `done` or `failed`. `declined` is a member's no.
 * `lapsed` waited fourteen days, or the thing changed before it was carried out.
 */
export const ACTION_STATUSES = [
  "proposed",
  "approved",
  "done",
  "failed",
  "declined",
  "lapsed",
] as const;
export const ActionStatusSchema = z.enum(ACTION_STATUSES);
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

/**
 * One thing the product does outside itself for a location, once a member said yes: what it
 * would do, what it replaces, who answered and what became of it. See the glossary's "Action".
 */
export const ActionSchema = z.object({
  id: Id,
  location_id: Id,
  kind: ActionKindSchema,
  /** The connection it goes through. */
  connection_id: Id.nullable(),
  /** What it would do, in a sentence composed by rule. */
  summary: z.string(),
  /** What was there when it was proposed, which is what it replaces. */
  seen: z.object({ text: z.string().nullable() }).nullable(),
  /**
   * When what it replaced was dropped, because where it was read from limits how long it may
   * be held. `seen` is null from then on.
   */
  seen_dropped_at: Timestamp.nullable(),
  /** The text it would put there, and whether a rule or a model wrote it. */
  proposed_text: z.string().nullable(),
  written_by: z.enum(["rule", "model"]),
  status: ActionStatusSchema,
  proposed_at: Timestamp,
  /** When it stops waiting, if nobody has answered. */
  lapses_at: Timestamp,
  approved_by_email: z.string().nullable(),
  approved_at: Timestamp.nullable(),
  /** What was approved, when a member changed the text first. Null when it went as proposed. */
  approved_text: z.string().nullable(),
  declined_by_email: z.string().nullable(),
  declined_at: Timestamp.nullable(),
  decline_reason: z.string().nullable(),
  done_at: Timestamp.nullable(),
  failed_at: Timestamp.nullable(),
  /** Why it failed, or why the last try did not work. */
  failure: z.string().nullable(),
  lapsed_at: Timestamp.nullable(),
  lapse_reason: z.enum(["expired", "out_of_date"]).nullable(),
  /** The failed action this one was asked for again from. */
  retry_of: Id.nullable(),
  /** The action this one takes back, where a member asked to have it taken back. */
  takes_back: Id.nullable(),
});
export type Action = z.infer<typeof ActionSchema>;

/**
 * How long an action may go without its owners being told before nothing more is carried out
 * for the organization. The owners are told within 48 hours; this leaves twelve to do it by hand.
 */
export const NOTICE_HOLD_HOURS = 36;

/** A location's actions: what is waiting for a yes, and the record of the rest, newest first. */
export const LocationActionsSchema = z.object({
  waiting: z.array(ActionSchema),
  record: z.array(ActionSchema),
  /**
   * True while nothing more is carried out for the organization: something was done more than
   * 36 hours ago and its owners have not been told yet.
   */
  held: z.boolean(),
});
export type LocationActions = z.infer<typeof LocationActionsSchema>;

/** A member's yes. `text` is sent when they changed what would be published. */
export const ActionApprovalSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, "Write something, or decline it")
    .max(5000, "Use 5,000 characters or fewer")
    .optional(),
});
export type ActionApproval = z.infer<typeof ActionApprovalSchema>;

/** A member's no, with a reason or without. */
export const ActionDeclineSchema = z.object({
  reason: z.string().trim().max(200, "Use 200 characters or fewer").optional(),
});
export type ActionDecline = z.infer<typeof ActionDeclineSchema>;

/** How many actions are waiting for a yes, by location. A location with none is absent. */
export const WaitingActionsSchema = z.record(Id, z.number().int().positive());
export type WaitingActions = z.infer<typeof WaitingActionsSchema>;

/** A message asking the worker to carry out one approved action. */
export const ActionMessageSchema = z.object({
  action_id: Id,
  step: z.enum(["carry_out"]),
});
export type ActionMessage = z.infer<typeof ActionMessageSchema>;

export const ALERT_KINDS = ["drop", "competitor", "site", "phone"] as const;
export const AlertKindSchema = z.enum(ALERT_KINDS);
export type AlertKind = z.infer<typeof AlertKindSchema>;

/**
 * Why the worker cleared an alert: the thing ended, what it was about is no longer checked, it
 * was a first sighting and is no longer news, or it was a phone number the answers no longer
 * give or that is now the one on file.
 */
export const ALERT_CLEAR_REASONS = [
  "named_again",
  "not_tracked",
  "old_news",
  "no_longer_given",
  "now_on_file",
] as const;
export const AlertClearReasonSchema = z.enum(ALERT_CLEAR_REASONS);
export type AlertClearReason = z.infer<typeof AlertClearReasonSchema>;

/** What a drop rests on, as it was counted when the alert was raised. */
export const DropFactsSchema = z.object({
  /** The prompt or keyword, as it is asked. */
  prompt: z.string(),
  /** How many checks in a row, up to the newest, did not name the business. */
  missed: z.number().int().positive(),
  /** How many checks the window held before those, and how many of them named the business. */
  checks_before: z.number().int().positive(),
  named_before: z.number().int().nonnegative(),
});
export type DropFacts = z.infer<typeof DropFactsSchema>;

/** What a sighting was counted over: how many answers, in how many of the scans looked at. */
const SightingCounts = {
  answers: z.number().int().positive(),
  scans: z.number().int().positive(),
  /** How many scans were looked at: the latest few for a first sighting, the window for a number. */
  of_scans: z.number().int().positive(),
};

/** What "a business is named for the first time" rests on. */
export const CompetitorFactsSchema = z.object({
  /** The business, as the answers most often wrote it. */
  name: z.string(),
  ...SightingCounts,
  /** Where it was named, the prompt with the most answers first. A few, not all. */
  places: z.array(z.object({ prompt: z.string(), surfaces: z.array(SurfaceSchema) })),
  /** How many prompts it was named for in all. */
  prompts: z.number().int().positive(),
});
export type CompetitorFacts = z.infer<typeof CompetitorFactsSchema>;

/** What "a site is read for the first time" rests on. */
export const SiteFactsSchema = z.object({
  host: z.string(),
  ...SightingCounts,
  /** How many of those answers named the business. */
  named: z.number().int().nonnegative(),
  /** True for the business's own website. */
  own: z.boolean(),
  /** The page of the site those answers cited most. */
  url: z.string().nullable(),
});
export type SiteFacts = z.infer<typeof SiteFactsSchema>;

/** What "the answers give a phone number that is not the location's" rests on. */
export const PhoneFactsSchema = z.object({
  /** The number the answers gave, and the one on file it differs from, in international form. */
  number: z.string(),
  on_file: z.string(),
  /** The location's country, which is how both are written out. */
  country_code: z.string(),
  ...SightingCounts,
  /** Where it was given, the prompt with the most answers first. A few, not all. */
  places: z.array(z.object({ prompt: z.string(), surfaces: z.array(SurfaceSchema) })),
  /** How many prompts it was given for in all. */
  prompts: z.number().int().positive(),
});
export type PhoneFacts = z.infer<typeof PhoneFactsSchema>;

const AlertRow = z.object({
  id: Id,
  location_id: Id,
  /**
   * When what it says began: the first check that did not name the business, or the first scan
   * that saw the newcomer.
   */
  since: Timestamp,
  /** The scan that raised it. Drops from one scan are shown together. */
  scan_id: Id.nullable(),
  raised_at: Timestamp,
  cleared_at: Timestamp.nullable(),
  clear_reason: AlertClearReasonSchema.nullable(),
  dismissed_at: Timestamp.nullable(),
  dismissed_by_email: z.string().nullable(),
});

/**
 * Something measured that changed at a location, and that its owner would want to know. The
 * worker raises it when a scan finishes and clears it when a later scan shows it has ended. See
 * the glossary's "Alert".
 *
 * - `drop`: a prompt on one surface that named the business and stopped.
 * - `competitor`: a business the written answers name for the first time.
 * - `site`: a site the written answers cite for the first time.
 * - `phone`: a phone number the written answers give for the business that is not the one on
 *   file.
 */
export const AlertSchema = z.discriminatedUnion("kind", [
  AlertRow.extend({
    kind: z.literal("drop"),
    /** The prompt and the surface it is about. */
    tracked_query_id: Id,
    surface: SurfaceSchema,
    facts: DropFactsSchema,
  }),
  AlertRow.extend({ kind: z.literal("competitor"), facts: CompetitorFactsSchema }),
  AlertRow.extend({ kind: z.literal("site"), facts: SiteFactsSchema }),
  AlertRow.extend({ kind: z.literal("phone"), facts: PhoneFactsSchema }),
]);
export type Alert = z.infer<typeof AlertSchema>;
export type DropAlert = Extract<Alert, { kind: "drop" }>;

export const MeSchema = z.object({
  user_id: Id,
  email: z.string().nullable(),
  organizations: z.array(OrganizationSchema),
  /** True when scans return generated data instead of real measurements. */
  sample_data: z.boolean(),
  /** What the account is to the product itself. Null for nearly everyone. */
  platform_role: PlatformRoleSchema.nullable(),
});
export type Me = z.infer<typeof MeSchema>;

export const ScanWithResultsSchema = ScanSchema.extend({
  results: z.array(ScanResultSchema),
});
export type ScanWithResults = z.infer<typeof ScanWithResultsSchema>;

/** One site the answers cited, counted over a set of answers. */
export const SourceSummarySchema = z.object({
  host: z.string(),
  /** How many answers cited the site. */
  answers: z.number().int().positive(),
  /** How many of those answers named the business. */
  named: z.number().int().nonnegative(),
  /** True for the business's own website. */
  own: z.boolean(),
  /** The site's most cited pages. */
  urls: z.array(z.string()),
});
export type SourceSummary = z.infer<typeof SourceSummarySchema>;

export const SITE_CHECK_IDS = [
  "reachable",
  "crawlers_allowed",
  "indexable",
  "text_content",
  "names_business",
  "names_city",
  "structured_data",
] as const;
export type SiteCheckId = (typeof SITE_CHECK_IDS)[number];

/** What the on-page check found on a business's own home page. */
export const SiteCheckSchema = z.object({
  /** The address that was read, after redirects. */
  url: z.string(),
  status: z.number().int().nullable(),
  /**
   * In a fixed order. Only `reachable` is present when the address leads nowhere. Empty when the
   * page could not be loaded and that proves nothing about the site: no claim is made.
   */
  checks: z.array(z.object({ id: z.enum(SITE_CHECK_IDS), passed: z.boolean() })),
  /** The assistants' crawlers the site's robots.txt shuts out. */
  blocked_crawlers: z.array(z.string()),
  /** How many words the page has before any script runs. */
  words: z.number().int().nonnegative(),
});
export type SiteCheck = z.infer<typeof SiteCheckSchema>;

/** How often the business was named, counted over a location's most recent successful scans. */
export const ScanWindowSchema = z.object({
  /** The most scans a rate is counted over. */
  size: z.number().int().positive(),
  /**
   * How many scans it is counted over so far. Fewer than `size` for a new location, and a scan
   * that asked only prompts since retired is not counted.
   */
  scans: z.number().int().nonnegative(),
  cells: z.array(
    z.object({
      tracked_query_id: Id,
      surface: SurfaceSchema,
      checks: z.number().int().positive(),
      mentions: z.number().int().nonnegative(),
      /** Whether each check named the business, oldest first. */
      history: z.array(z.boolean()),
    }),
  ),
  /** How many answers in the window could cite pages, which is what `sources` is counted over. */
  answers: z.number().int().nonnegative(),
  /** The sites those answers cited, most cited first. */
  sources: z.array(SourceSummarySchema),
});
export type ScanWindow = z.infer<typeof ScanWindowSchema>;

export const ACTION_PLAN_STEP_IDS = [
  "fix_website",
  "get_listed",
  "keep_listings",
  "competitors",
] as const;

/** One step of the action plan: what to do, why, and the evidence for it. */
export const ActionPlanStepSchema = z.object({
  id: z.enum(ACTION_PLAN_STEP_IDS),
  title: z.string(),
  /** The observation the action rests on, with its counts. */
  summary: z.string(),
  /** The sites, checks or businesses the action is about. `url` is a page an answer cited. */
  items: z.array(z.object({ label: z.string(), detail: z.string(), url: z.string().nullable() })),
});
export type ActionPlanStep = z.infer<typeof ActionPlanStepSchema>;

/**
 * What sort of site a source is, which decides what an owner can usefully do about it. `reviews`
 * lets a business ask its customers for reviews and `reviews_unasked` forbids it. `unknown` is a
 * site on no list, which is most of them.
 */
export const SOURCE_KINDS = [
  "reviews",
  "reviews_unasked",
  "directory",
  "editorial",
  "unknown",
] as const;
export const SourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/** Of the answers that cited a site, how many named the business. */
export const NamedCountSchema = z.object({
  answers: z.number().int().nonnegative(),
  named: z.number().int().nonnegative(),
});
export type NamedCount = z.infer<typeof NamedCountSchema>;

/** One piece of work for an owner, because of one source. Composed by rule, never by a model. */
/**
 * The kinds of draft: wording written for a task. `note` is a note to the author of a page,
 * `listing` the description a directory or review site asks a business for, and `page` the copy
 * for a page on the business's own site that answers one of its prompts. See
 * `docs/adr/0016-the-worker-writes-a-draft.md`.
 */
export const DRAFT_KINDS = ["note", "listing", "page"] as const;
export const DraftKindSchema = z.enum(DRAFT_KINDS);
export type DraftKind = z.infer<typeof DraftKindSchema>;

/**
 * `asked` while the worker has yet to write it, `written` once it has, `failed` when the last
 * ask wrote nothing.
 */
export const DraftStatusSchema = z.enum(["asked", "written", "failed"]);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

/**
 * The draft for one task. A member asks for it and the worker writes it. `text` is the draft
 * that was last written: it stays while another is being written, and when that one fails.
 */
export const DraftSchema = z.object({
  id: Id,
  location_id: Id,
  /** The task it is for. */
  recommendation_id: Id,
  status: DraftStatusSchema,
  asked_by_email: z.string().nullable(),
  asked_at: Timestamp,
  /** Why the last ask wrote nothing, as a sentence for the page. */
  failure: z.string().nullable(),
  kind: DraftKindSchema.nullable(),
  text: z.string().nullable(),
  written_at: Timestamp.nullable(),
  /** True for generated sample text, which no model wrote. */
  sample_data: z.boolean(),
});
export type Draft = z.infer<typeof DraftSchema>;

/** A message asking the worker to write one draft. */
export const DraftMessageSchema = z.object({
  draft_id: Id,
  step: z.enum(["write"]),
});
export type DraftMessage = z.infer<typeof DraftMessageSchema>;

/** Where an organization's month of drafts stands. */
export const DraftsStandingSchema = z.object({
  /** How many it may have this month, across its locations. Null when its plan includes none. */
  allowed: z.number().int().nonnegative().nullable(),
  used: z.number().int().nonnegative(),
  /** The day the count starts again: the first of next month (UTC), as YYYY-MM-DD. */
  resets_on: z.string(),
});
export type DraftsStanding = z.infer<typeof DraftsStandingSchema>;

/**
 * The address of a location's own page on a site, as a member gave it. One for a location on a
 * site. See `listings.ts`.
 */
export const ListingSchema = z.object({
  location_id: Id,
  /** The site, as the list of known sites names it. */
  site: z.string(),
  url: z.string(),
  set_by_email: z.string().nullable(),
  set_at: Timestamp,
});
export type Listing = z.infer<typeof ListingSchema>;

/** What a member pastes. Its shape is checked against the site by `readListing`. */
export const ListingInputSchema = z.object({
  url: z.string().trim().min(1, "Paste the address of your listing").max(2000),
});
export type ListingInput = z.infer<typeof ListingInputSchema>;

/** What a task holds of the business's listing on its site. */
export const TaskListingSchema = z.object({
  /** The site the listing is kept under, which is what setting it names. */
  site: z.string(),
  /** The listing's address. Null until a member gives it. */
  url: z.string().nullable(),
  /**
   * Where a customer writes a review, made from the listing. Null until there is a listing, and
   * for a site whose form address is not known: the listing is then what a customer is sent.
   */
  review_url: z.string().nullable(),
});
export type TaskListing = z.infer<typeof TaskListingSchema>;

export const TaskSchema = z.object({
  /** The recommendation the task stands on, which is what marking it done updates. */
  id: Id,
  host: z.string(),
  kind: SourceKindSchema,
  title: z.string(),
  /** The observation the task rests on, with its counts. */
  summary: z.string(),
  /** What to do, for a site of this kind. */
  detail: z.string(),
  /** The page of the site an answer cited most, when the window still has one. */
  url: z.string().nullable(),
  /** False once the rule stopped firing for the site. */
  open: z.boolean(),
  acted_at: Timestamp.nullable(),
  /** The action that did the work, when one did. The mark then stays. */
  acted_by_action: Id.nullable(),
  /** Counted over the scans before `acted_at` and over those since. Null until it is marked. */
  before: NamedCountSchema.nullable(),
  since: NamedCountSchema.nullable(),
  /** The kind of draft that can be written for it now. Null when none can. */
  draft_kind: DraftKindSchema.nullable(),
  /** Its draft, once one has been asked for. */
  draft: DraftSchema.nullable(),
  /**
   * The business's own page on the site, for a task that asks for it: one whose site lets a
   * business ask its customers for reviews. Null for every other task.
   */
  listing: TaskListingSchema.nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * Of the answers to one prompt, how many named the business, and how many cited the page that
 * answers it. `cited` is null while nobody has said where the page is.
 */
export const PromptCountSchema = z.object({
  answers: z.number().int().nonnegative(),
  named: z.number().int().nonnegative(),
  cited: z.number().int().nonnegative().nullable(),
});
export type PromptCount = z.infer<typeof PromptCountSchema>;

/** Where the page for a page task is, as a member gave it. */
export const PromptPageSchema = z.object({
  /** The task it is the page for. */
  recommendation_id: Id,
  url: z.string(),
  set_by_email: z.string().nullable(),
  set_at: Timestamp,
  /** The action that published it, where Nearcited did. Null for an address a member gave. */
  action_id: Id.nullable(),
});
export type PromptPage = z.infer<typeof PromptPageSchema>;

/** What a member gives for where a page is. Its form is checked by `readPageAddress`. */
export const PromptPageInputSchema = z.object({
  url: z.string().trim().min(1, "Paste the address of the page").max(2000),
});
export type PromptPageInput = z.infer<typeof PromptPageInputSchema>;

/** How often one fetcher read a hosted page over a stretch of days, and the last day it did. */
export const PageFetchesSchema = z.object({
  fetcher: z.enum(PAGE_FETCHER_KEYS as [PageFetcher, ...PageFetcher[]]),
  count: z.number().int().nonnegative(),
  last_on: z.string(),
});
export type PageFetches = z.infer<typeof PageFetchesSchema>;
/** A hosted page's fetches, with the page task the page does the work of. */
export type TaskPageFetches = PageFetches & { recommendation_id: string };

/**
 * A page on the business's own site that would answer one of its prompts, because no answer to
 * that prompt named the business. Composed by rule; only the copy for the page, its draft, is
 * written by a model.
 */

export const PageTaskSchema = z.object({
  /** The recommendation the task stands on, which is what marking it done updates. */
  id: Id,
  tracked_query_id: Id,
  /** The prompt, as the location tracks it. */
  prompt: z.string(),
  title: z.string(),
  /** The observation the task rests on, with its counts. */
  summary: z.string(),
  /** False once an answer to the prompt named the business. */
  open: z.boolean(),
  acted_at: Timestamp.nullable(),
  /** The action that did the work, when one did. The mark then stays. */
  acted_by_action: Id.nullable(),
  /** Counted over the scans before `acted_at` and over those since. Null until it is marked. */
  before: PromptCountSchema.nullable(),
  since: PromptCountSchema.nullable(),
  /** `page` while the copy can be written for it now, else null. */
  draft_kind: DraftKindSchema.nullable(),
  /** Its draft, once one has been asked for. */
  draft: DraftSchema.nullable(),
  /** Where the page is, once a member said. */
  page: PromptPageSchema.nullable(),
  /**
   * How often each counted fetcher read the task's hosted page over the last thirty days, where
   * it has one and was read. Anyone can claim to be one of these, so this is never proof.
   */
  fetches: z.array(PageFetchesSchema),
});
export type PageTask = z.infer<typeof PageTaskSchema>;

/** Of a set of answers, how many cited the business's own website. */
export const CitedCountSchema = z.object({
  answers: z.number().int().nonnegative(),
  cited: z.number().int().nonnegative(),
});
export type CitedCount = z.infer<typeof CitedCountSchema>;

/**
 * Where the fix for a page with no structured business details stands: whether an owner has
 * said the block is on the page, whether a scan has looked since, and what the answers did
 * before and since. Whether the page has the details now is the on-page check's to say.
 */
export const DetailsFixSchema = z.object({
  /** The recommendation the fix stands on, which is what marking it done updates. */
  id: Id,
  /** When a member said the block was on the page, or an action put it there. */
  acted_at: Timestamp.nullable(),
  /** The action that put it there, when one did. The mark then stays. */
  acted_by_action: Id.nullable(),
  /** Whether a scan has finished since then, so that the check on the page is newer than the mark. */
  checked_since: z.boolean(),
  /** Counted over the scans before `acted_at` and over those since. Null until it is marked. */
  before: CitedCountSchema.nullable(),
  since: CitedCountSchema.nullable(),
});
export type DetailsFix = z.infer<typeof DetailsFixSchema>;

export const LocationDetailSchema = z.object({
  location: LocationSchema,
  queries: z.array(TrackedQuerySchema),
  latest_scan: ScanWithResultsSchema.nullable(),
  window: ScanWindowSchema,
  /** The surfaces a scan checks right now. The rest have no provider set up. */
  surfaces: z.array(SurfaceSchema),
  recommendations: z.array(RecommendationSchema),
  /** The on-page check from the latest successful scan. Null when that scan made none. */
  site: SiteCheckSchema.nullable(),
  /** What the evidence in the window says to do next, most direct first. */
  action_plan: z.array(ActionPlanStepSchema),
  /** The work that follows from the sources, with whether it has been done and what moved. */
  tasks: z.array(TaskSchema),
  /** A page to publish for each prompt no answer named the business for, and those done. */
  page_tasks: z.array(PageTaskSchema),
  /** Where the organization's month of drafts stands. */
  drafts: DraftsStandingSchema,
  /** The connected accounts this location is matched to. */
  connections: z.array(LocationConnectionSchema),
  /** What got worse and has neither ended nor been dismissed, newest first. */
  alerts: z.array(AlertSchema),
  /**
   * The fix for a page with no structured business details, once the on-page check has found
   * them missing. Null until then.
   */
  details_fix: DetailsFixSchema.nullable(),
});
export type LocationDetail = z.infer<typeof LocationDetailSchema>;

/** An assistant a visit to a business's own site can be told to come from. See `visits.ts`. */
export const VISIT_ASSISTANTS = ["chatgpt", "gemini", "perplexity", "copilot", "claude"] as const;
export const VisitAssistantSchema = z.enum(VISIT_ASSISTANTS);
export type VisitAssistant = z.infer<typeof VisitAssistantSchema>;

/** A location's site key, as the line on its site carries it. */
const SiteKey = z.string().regex(/^[0-9a-f]{32}$/);

/** A location's line: the key the line on its own site carries, and whether it was seen there. */
export const VisitLineSchema = z.object({
  location_id: Id,
  key: SiteKey,
  /** When the key was made: with the location, or when an owner or admin last replaced it. */
  key_made_at: Timestamp,
  /** The last day (UTC) the line answered a check from the location's own site. Null until one. */
  checked_on: z.string().nullable(),
});
export type VisitLine = z.infer<typeof VisitLineSchema>;

/** A location's line as its page is sent it. */
export const LocationLineSchema = z.object({
  line: VisitLineSchema,
  /** The line itself, as an owner pastes it into their site. */
  html: z.string(),
  /** Whether the caller may replace the key: an owner or an admin. */
  can_replace: z.boolean(),
});
export type LocationLine = z.infer<typeof LocationLineSchema>;

/**
 * A location's visits from assistants over a run of days, added up: what its own site reported,
 * and no more than that. No part of it is a visit, and none says anything of a visitor.
 */
export const LocationVisitsSchema = z.object({
  /** The first day (UTC) added up. The last is today. */
  since: z.string(),
  /**
   * How many visits arrived on a day from an assistant, for each day and assistant that had any.
   * The assistant is a name this build may not know yet, so it is not held to the list.
   */
  days: z.array(
    z.object({ day: z.string(), assistant: z.string(), count: z.number().int().positive() }),
  ),
  /** The pages landed on most, with how many visits each had. At most ten. */
  pages: z.array(z.object({ path: z.string(), count: z.number().int().positive() })),
  /** The visits to pages past the fiftieth of their day, which are counted together. */
  other_pages: z.number().int().nonnegative(),
});
export type LocationVisits = z.infer<typeof LocationVisitsSchema>;

/**
 * What the line on a business's site sends, with no sign-in. One of two things: its owner
 * checking that the line is there, or a visit that arrived from an assistant. Nothing in either
 * is about the visitor, and which assistant it was is worked out from this, never sent.
 */
export const VisitSentSchema = z.union([
  z.object({ key: SiteKey, check: z.literal(true) }),
  z.object({
    key: SiteKey,
    /** The host name the visitor came from. Never the address, which can hold what they asked. */
    referrer: z.string().max(253).nullable(),
    /** The assistant's own tag on the address landed on, when it carries one. */
    tag: z.string().max(100).nullable(),
    /** The page landed on, from its first slash, without what follows a question mark. */
    path: z.string().startsWith("/").max(2000),
  }),
]);
export type VisitSent = z.infer<typeof VisitSentSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Body of a message on the scan queue. */
export const ScanMessageSchema = z.object({ scan_id: Id });
export type ScanMessage = z.infer<typeof ScanMessageSchema>;

/** A message asking the worker to check one prompt of an audit. One message per prompt. */
export const AuditMessageSchema = z.object({
  audit_id: Id,
  prompt_index: z.number().int().nonnegative(),
});
export type AuditMessage = z.infer<typeof AuditMessageSchema>;
