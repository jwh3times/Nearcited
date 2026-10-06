import { z } from "zod";

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

export const TuningSchema = z.object({
  score: ScoreWeightsSchema,
  prompts: PromptsSchema,
  /** Request settings for the ChatGPT provider. */
  chatgpt: z.object({ model: z.string().trim().min(1) }),
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
  chatgpt: { model: "gpt-6.1-sol" },
};

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
