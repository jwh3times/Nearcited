import { z } from "zod";
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

export const ScanFrequencySchema = z.enum(["off", "weekly", "daily"]);
export type ScanFrequency = z.infer<typeof ScanFrequencySchema>;

export const RecommendationStatusSchema = z.enum(["open", "done", "dismissed"]);
export type RecommendationStatus = z.infer<typeof RecommendationStatusSchema>;

const Id = z.uuid();
const Timestamp = z.string();

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

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
  scan_frequency: ScanFrequencySchema,
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
  created_at: Timestamp,
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

/**
 * What one scan or one prompt of an audit used on one surface with one model, added up over its
 * calls. Counts as the provider reported them. It holds no price: a count is turned into money
 * only on the server, from rates kept outside this repository.
 */
export const ProviderUsageSchema = z.object({
  surface: SurfaceSchema,
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

export const OrganizationLimitsSchema = z.object({
  max_locations: limit(0, 1000),
  max_queries_per_location: limit(0, 200),
  max_manual_scans_per_month: limit(0, 100_000),
  /** 1 is daily. */
  scan_every_days: limit(1, 30),
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

/** A plan as the operator sees it: what is on sale, and who is on it. Test organizations are left out. */
export const OperatorPlanSchema = PlanSchema.extend({
  /** How many organizations are on it. */
  organizations: z.number().int().nonnegative(),
  /** How many of those have a subscription in force. */
  subscribers: z.number().int().nonnegative(),
  /** What those subscribers pay a month between them, in US cents and before tax. */
  monthly_cents: z.number().int().nonnegative(),
  /** The change announced to its current subscribers and not yet finished or called off. */
  price_change: PriceChangeSchema.extend({
    /** How many organizations' owners have been sent the announcement. */
    told: z.number().int().nonnegative(),
    /** How many subscriptions have been moved to the new prices. */
    moved: z.number().int().nonnegative(),
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
    scan_frequency: ScanFrequencySchema.default("daily"),
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

export const RecommendationUpdateSchema = z.object({
  status: RecommendationStatusSchema,
});
export type RecommendationUpdate = z.output<typeof RecommendationUpdateSchema>;

// ---------------------------------------------------------------------------
// API responses
// ---------------------------------------------------------------------------

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

export const ACTION_IDS = ["fix_website", "get_listed", "keep_listings", "competitors"] as const;

/** One step of the action plan: what to do, why, and the evidence for it. */
export const ActionSchema = z.object({
  id: z.enum(ACTION_IDS),
  title: z.string(),
  /** The observation the action rests on, with its counts. */
  summary: z.string(),
  /** The sites, checks or businesses the action is about. `url` is a page an answer cited. */
  items: z.array(z.object({ label: z.string(), detail: z.string(), url: z.string().nullable() })),
});
export type Action = z.infer<typeof ActionSchema>;

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
  actions: z.array(ActionSchema),
});
export type LocationDetail = z.infer<typeof LocationDetailSchema>;

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
