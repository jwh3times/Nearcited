import { z } from "zod";
import {
  DraftKindSchema,
  PLAN_ASSISTANTS,
  type PlanAssistant,
  type ProviderUsage,
} from "./schemas";

/**
 * The values that decide what the product measures and how it scores: prompt wording and score
 * weights. The code that uses them is public; the values a deployment really runs on are kept in
 * the private companion repository and bundled at build time. See docs/adr/0001.
 *
 * `defaultTuning` is what a public clone gets. It is a placeholder that keeps the code runnable,
 * not a measured model, and live scans refuse to run on it.
 *
 * Never import this into the web app as a value. Its bundle is public.
 */

const Weight = z.number().min(0).max(1);

export const ScoreWeightsSchema = z
  .object({
    /** Named, but the surface gave no order. */
    unranked: Weight,
    /** Each entry covers positions up to and including `through`. Ascending. */
    by_position: z.array(z.object({ through: z.number().int().positive(), weight: Weight })).min(1),
    /** Any position past the last entry. */
    beyond: Weight,
  })
  .refine((weights) => isAscending(weights.by_position.map((step) => step.through)), {
    message: "by_position must be in ascending order of `through`",
  })
  .refine(
    (weights) => isDescending([...weights.by_position.map((step) => step.weight), weights.beyond]),
    { message: "A lower rank must never be worth more than a higher one" },
  );
export type ScoreWeights = z.infer<typeof ScoreWeightsSchema>;

/** `{query}`, `{city}` and `{region}` are replaced when the prompt is sent. */
const PromptTemplate = z
  .string()
  .trim()
  .min(1)
  .refine((template) => template.includes("{query}"), {
    message: "A prompt template must contain {query}",
  });

export const PromptsSchema = z.object({
  /** Used for every assistant surface without its own entry below. */
  default: PromptTemplate,
  /** Wording for one assistant, where it needs to differ. */
  by_surface: z
    .partialRecord(z.enum(["chatgpt", "gemini", "perplexity", "claude"]), PromptTemplate)
    .default({}),
});
export type Prompts = z.infer<typeof PromptsSchema>;

const Price = z.number().min(0);

/** What a vendor charges for one model, in US dollars. */
export const ModelRateSchema = z.object({
  /** Input tokens that were not read from the vendor's cache. */
  input_per_million: Price,
  cached_input_per_million: Price,
  output_per_million: Price,
  /** The fee for web searches, charged on top of the tokens their results add. */
  per_thousand_searches: Price,
});
export type ModelRate = z.infer<typeof ModelRateSchema>;

/** Keyed by model name, as the vendor reports it. */
export const RatesSchema = z.record(z.string().trim().min(1), ModelRateSchema);
export type Rates = z.infer<typeof RatesSchema>;

/**
 * What writes a draft, and what it is told. The details a draft is written from are set out for
 * the model by the code, the same way every time; the instructions here are what it is told to
 * make of them.
 */
export const DraftsTuningSchema = z.object({
  model: z.string().trim().min(1),
  /** How hard the model works on a draft. */
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  /** The most a draft may run to. A draft is short: this stops one that does not end. */
  max_tokens: z.number().int().min(200).max(8000),
  /**
   * What the model is told, for each kind of draft. A kind with no instructions here is not
   * written on real data: nothing falls back to a placeholder.
   */
  instructions: z.partialRecord(DraftKindSchema, z.string().trim().min(1)),
});
export type DraftsTuning = z.infer<typeof DraftsTuningSchema>;

const ChatGptSettingsSchema = z.object({
  model: z.string().trim().min(1),
  /** How hard the model reasons before it answers. Which levels a model takes is the vendor's. */
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
});

const ClaudeSettingsSchema = z.object({
  model: z.string().trim().min(1),
  /** How hard the model works on each answer. Higher effort searches and reasons more. */
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  /**
   * The most web searches one check may run. This is the main cost control: each search adds
   * its results to the input billed, and earlier results are read again on every later one.
   */
  max_searches: z.number().int().min(1).max(10),
});

/**
 * How a Google keyword is checked from a location's point. Each changes what is seen, as a
 * sampling setting does, so the values a deployment runs on are kept with the rest of the tuning.
 */
export const GoogleTuningSchema = z.object({
  /** How far around the point Google's results page is searched, in metres. */
  radius_m: z.number().int().min(199).max(199_999),
  /** The map's zoom for the map pack and AI Mode, from 4 (a country) to 18 (a street). */
  zoom: z.number().int().min(4).max(18),
  /** How many organic results are read. Every ten more is charged as another search. */
  organic_depth: z.number().int().min(10).max(100).multipleOf(10),
  /** How many map results are read, as for the organic ones. */
  map_depth: z.number().int().min(10).max(100).multipleOf(10),
});
export type GoogleTuning = z.infer<typeof GoogleTuningSchema>;

/** Placeholders: the public build's guess, not what any deployment was tuned to. */
const DEFAULT_GOOGLE: GoogleTuning = { radius_m: 1000, zoom: 14, organic_depth: 10, map_depth: 20 };

export const TuningSchema = z.object({
  score: ScoreWeightsSchema,
  prompts: PromptsSchema,
  /**
   * Request settings for the ChatGPT provider. `stronger` is what an organization that pays for
   * a stronger model on it is asked with; left out, none is offered on ChatGPT.
   */
  chatgpt: ChatGptSettingsSchema.extend({ stronger: ChatGptSettingsSchema.optional() }),
  /** Request settings for the Claude provider, and its stronger ones, as for ChatGPT. */
  claude: ClaudeSettingsSchema.extend({ stronger: ClaudeSettingsSchema.optional() }),
  /**
   * What each model costs, for turning recorded usage into spend. A model that answered but has
   * no entry here has no known cost: it is never priced as another model.
   */
  rates: RatesSchema,
  /** How Google results are checked. Left out, the placeholders are used. */
  google: GoogleTuningSchema.default(DEFAULT_GOOGLE),
  /**
   * Request settings and instructions for drafts. Left out, no draft is written on real data: a
   * tuning file from before drafts existed still loads, and writes none.
   */
  drafts: DraftsTuningSchema.optional(),
});
export type Tuning = z.infer<typeof TuningSchema>;

export const defaultTuning: Tuning = {
  score: {
    unranked: 0.6,
    by_position: [
      { through: 1, weight: 1 },
      { through: 2, weight: 0.8 },
      { through: 3, weight: 0.65 },
      { through: 5, weight: 0.5 },
      { through: 10, weight: 0.3 },
    ],
    beyond: 0.15,
  },
  prompts: {
    default: "{query} in {city}, {region}",
    by_surface: {},
  },
  chatgpt: {
    model: "gpt-6.1-sol",
    effort: "medium",
    stronger: { model: "gpt-6.1-sol", effort: "high" },
  },
  claude: {
    model: "claude-sonnet-5-5",
    effort: "low",
    max_searches: 1,
    stronger: { model: "claude-opus-5-5", effort: "low", max_searches: 1 },
  },
  rates: {},
  google: DEFAULT_GOOGLE,
  drafts: {
    model: "claude-sonnet-5-5",
    effort: "low",
    max_tokens: 1000,
    instructions: {
      note: "Write a short note from the owner of the business to the author of the page, asking to be considered for it. Use only the details given.",
      listing:
        "Write a short description of the business for its listing on the site. Use only the details given.",
      page: "Write a page for the business's own website that answers the question. Put its title on the first line. Use only the details given.",
    },
  },
};

/** The assistants the tuning has a stronger model for, which are the only ones it is sold on. */
export function strongerAssistants(tuning: Tuning): PlanAssistant[] {
  return PLAN_ASSISTANTS.filter((surface) => tuning[surface].stronger !== undefined);
}

/**
 * The tuning a stronger check is asked with: each assistant's stronger settings in place of its
 * own. An assistant with none keeps its own here, and is never asked on Stronger.
 */
export function strongerTuning(tuning: Tuning): Tuning {
  return {
    ...tuning,
    chatgpt: tuning.chatgpt.stronger ?? tuning.chatgpt,
    claude: tuning.claude.stronger ?? tuning.claude,
  };
}

export type TuningSource = "private" | "default";

export interface ActiveTuning {
  source: TuningSource;
  tuning: Tuning;
}

/** What `scripts/prepare-tuning.mjs` writes for the Worker bundle. */
const BundledTuningSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("default") }),
  z.object({ source: z.literal("private"), tuning: TuningSchema }),
]);

/**
 * Turns the bundled file into the tuning to run on. Throws when a private file is present but
 * invalid: a deployment must fail loudly, never fall back to the defaults.
 */
export function resolveTuning(bundled: unknown): ActiveTuning {
  const parsed = BundledTuningSchema.parse(bundled);
  return parsed.source === "private"
    ? { source: "private", tuning: parsed.tuning }
    : { source: "default", tuning: defaultTuning };
}

/**
 * The rate for the model that answered. A vendor can report a dated snapshot of the model that
 * was asked for (`name-2026-08-01`), so a name with no entry of its own takes the longest entry
 * it extends.
 */
export function rateFor(rates: Rates, model: string): ModelRate | null {
  const exact = rates[model];
  if (exact) return exact;
  const base = Object.keys(rates)
    .filter((name) => model.startsWith(`${name}-`))
    .sort((a, b) => b.length - a.length)[0];
  return base === undefined ? null : (rates[base] ?? null);
}

/** What some recorded usage cost in US dollars, or null when its model has no rate. */
export function usageCost(
  rates: Rates,
  usage: Omit<ProviderUsage, "surface" | "calls">,
): number | null {
  const rate = rateFor(rates, usage.model);
  if (!rate) return null;
  return (
    (usage.input_tokens * rate.input_per_million +
      usage.cached_input_tokens * rate.cached_input_per_million +
      usage.output_tokens * rate.output_per_million) /
      1_000_000 +
    (usage.searches * rate.per_thousand_searches) / 1000
  );
}

export interface PromptValues {
  query: string;
  city: string;
  region: string | null;
}

/** The prompt to send to one assistant. An unknown placeholder is left as written. */
export function renderPrompt(
  prompts: Prompts,
  surface: keyof Prompts["by_surface"],
  values: PromptValues,
): string {
  const template = prompts.by_surface[surface] ?? prompts.default;
  const replacements: Record<string, string> = {
    query: values.query,
    city: values.city,
    region: values.region ?? "",
  };
  return template
    .replace(/\{(\w+)\}/g, (placeholder, name: string) => replacements[name] ?? placeholder)
    .replace(/,\s*$/, "")
    .trim();
}

function isAscending(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] ?? value));
}

function isDescending(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value <= (values[index - 1] ?? value));
}
