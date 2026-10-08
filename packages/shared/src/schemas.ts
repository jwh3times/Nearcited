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
  /** How many scans members may start by hand, across the organization, in any 24 hours. */
  max_manual_scans_per_day: z.number().int().nonnegative(),
  /** How many days apart its locations are scanned. 1 is daily. */
  scan_every_days: z.number().int().positive(),
  /** The surfaces its scans check. Null means every surface that is set up. */
  surfaces: z.array(SurfaceSchema).nullable(),
  created_at: Timestamp,
});
export type Organization = z.infer<typeof OrganizationSchema>;

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
  created_at: Timestamp,
});
export type TrackedQuery = z.infer<typeof TrackedQuerySchema>;

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

/** Whether the fields a cross-field check reads came through their own checks. */
const sound =
  (...fields: string[]) =>
  (payload: { issues: readonly { path?: readonly PropertyKey[] }[] }) =>
    payload.issues.every((issue) => !fields.includes(String(issue.path?.[0])));

export const LocationInputSchema = z
  .object({
    name: named(120, "Name is required", "Enter the business's name"),
    website: optionalText(200).transform((typed, context) => {
      if (typed === null) return null;
      const website = normalizeWebsite(typed);
      if (website === null) {
        context.addIssue({ code: "custom", message: "Enter a web address, like joespizza.com" });
        return z.NEVER;
      }
      return website;
    }),
    phone: optionalText(40),
    address_line: optionalText(200),
    city: named(80, "City is required", "Enter the city's name"),
    region: optionalText(80),
    postal_code: optionalText(20),
    country_code: z
      .string()
      .trim()
      .toUpperCase()
      .refine(isCountry, "Use a two-letter country code, like US")
      .default("US"),
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
