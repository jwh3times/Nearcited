import { z } from "zod";

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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const OrganizationInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
});
export type OrganizationInput = z.output<typeof OrganizationInputSchema>;

export const LocationInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  website: optionalText(200).refine((value) => value === null || isHttpUrl(value), {
    message: "Website must start with http:// or https://",
  }),
  phone: optionalText(40),
  address_line: optionalText(200),
  city: z.string().trim().min(1, "City is required").max(80),
  region: optionalText(80),
  postal_code: optionalText(20),
  country_code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Use a two-letter country code")
    .default("US"),
  google_place_id: optionalText(200),
  primary_category: optionalText(120),
  scan_frequency: ScanFrequencySchema.default("daily"),
});
export type LocationInput = z.output<typeof LocationInputSchema>;
export type LocationFormValues = z.input<typeof LocationInputSchema>;

export const TrackedQueryInputSchema = z.object({
  kind: QueryKindSchema,
  text: z.string().trim().min(1, "Enter a prompt or keyword").max(300),
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

/** How often the business was named, counted over a location's most recent successful scans. */
export const ScanWindowSchema = z.object({
  /** The most scans a rate is counted over. */
  size: z.number().int().positive(),
  /** How many scans it is counted over so far. Fewer than `size` for a new location. */
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
});
export type ScanWindow = z.infer<typeof ScanWindowSchema>;

export const LocationDetailSchema = z.object({
  location: LocationSchema,
  queries: z.array(TrackedQuerySchema),
  latest_scan: ScanWithResultsSchema.nullable(),
  window: ScanWindowSchema,
  /** The surfaces a scan checks right now. The rest have no provider set up. */
  surfaces: z.array(SurfaceSchema),
  recommendations: z.array(RecommendationSchema),
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
