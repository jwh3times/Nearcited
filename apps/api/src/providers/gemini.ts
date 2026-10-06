import { type Observation, renderPrompt, type Tuning } from "@nearcited/shared";
import { z } from "zod";
import type { ObserveInput, SurfaceProvider } from "./types";

/**
 * Gemini, through Google's Interactions API with Grounding with Google Search turned on.
 *
 * This is the API with search, not the consumer Gemini app: the two share models and a search
 * index but not a system prompt, so treat a result as "what Gemini says when asked through the
 * API", which is the closest thing Google offers.
 *
 * The provider only fetches. It asks for the answer and the businesses it named as structured
 * output, collects the URLs the answer cited, and returns an `Observation`. Whether the business
 * was named is decided by `analyzeObservation`.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const TIMEOUT_MS = 60_000;

/** What the model is asked to return. The descriptions are instructions to the model. */
const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description: "Your full answer to the user, written as you normally would.",
    },
    businesses: {
      type: "array",
      items: { type: "string" },
      description:
        "Every business your answer names or recommends, by name only, in the order the answer names them. Empty if it names none.",
    },
  },
  required: ["answer", "businesses"],
} as const;

const AnswerSchema = z.object({
  answer: z.string(),
  businesses: z.array(z.string()),
});

const AnnotationSchema = z.looseObject({
  type: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
});

const ContentSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  annotations: z.array(AnnotationSchema).optional(),
});

const StepSchema = z.looseObject({
  type: z.string(),
  content: z.array(ContentSchema).optional(),
});

const InteractionSchema = z.looseObject({
  status: z.string().optional(),
  steps: z.array(StepSchema).optional(),
  usage: z.unknown().optional(),
});

const ErrorSchema = z.looseObject({
  error: z.looseObject({ message: z.string().optional(), status: z.string().optional() }),
});

/** Google sometimes cites through its own redirect host and puts the real site in the title. */
const REDIRECT_HOST = "vertexaisearch.cloud.google.com";
const LOOKS_LIKE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

function citedUrl(annotation: z.infer<typeof AnnotationSchema>): string | null {
  if (!annotation.url) return null;
  const title = annotation.title?.trim();
  if (annotation.url.includes(REDIRECT_HOST) && title && LOOKS_LIKE_HOST.test(title)) {
    return `https://${title.toLowerCase()}`;
  }
  return annotation.url;
}

/** Turns one Interactions API response body into an observation. Throws when it is unusable. */
export function parseGeminiInteraction(body: unknown): Observation {
  const interaction = InteractionSchema.parse(body);
  if (interaction.status && interaction.status !== "completed") {
    throw new Error(`Gemini did not finish the request (status: ${interaction.status}).`);
  }

  const content = (interaction.steps ?? [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? [])
    .filter((part) => part.type === "text");
  const text = content.map((part) => part.text ?? "").join("");
  if (!text.trim()) throw new Error("Gemini returned no answer text.");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Gemini's answer was not the JSON it was asked for.");
  }
  const answer = AnswerSchema.safeParse(json);
  if (!answer.success) throw new Error("Gemini's answer did not match the requested shape.");

  const cited = content
    .flatMap((part) => part.annotations ?? [])
    .map(citedUrl)
    .filter((url): url is string => url !== null);

  return {
    kind: "answer",
    text: answer.data.answer,
    businesses: answer.data.businesses,
    cited_urls: [...new Set(cited)],
  };
}

export interface GeminiOptions {
  apiKey: string;
  tuning: Pick<Tuning, "prompts" | "gemini">;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
  /** Called with the usage block of each successful response, for measuring cost. */
  onUsage?: (usage: unknown) => void;
}

export function createGeminiProvider(options: GeminiOptions): SurfaceProvider {
  const send = options.fetch ?? fetch;

  return {
    surface: "gemini",
    async observe({ location, query }: ObserveInput): Promise<Observation> {
      const prompt = renderPrompt(options.tuning.prompts, "gemini", {
        query: query.text,
        city: location.city,
        region: location.region,
      });

      const response = await send(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey },
        body: JSON.stringify({
          model: options.tuning.gemini.model,
          input: prompt,
          tools: [{ type: "google_search" }],
          response_format: { type: "text", mime_type: "application/json", schema: ANSWER_SCHEMA },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        // The message only: an error body can echo the request, and the request holds the prompt.
        const error = ErrorSchema.safeParse(body);
        const detail = error.success ? (error.data.error.message ?? error.data.error.status) : null;
        throw new Error(`Gemini request failed (${response.status})${detail ? `: ${detail}` : ""}`);
      }

      const observation = parseGeminiInteraction(body);
      const usage = InteractionSchema.safeParse(body);
      if (usage.success && usage.data.usage !== undefined) options.onUsage?.(usage.data.usage);
      return observation;
    },
  };
}
