import { type Observation, renderPrompt, type Tuning } from "@nearcited/shared";
import { z } from "zod";
import type { CallUsage, ObserveInput, SurfaceProvider } from "./types";

/**
 * ChatGPT, through OpenAI's Responses API with the web search tool turned on.
 *
 * This is the API with search, not the consumer ChatGPT app: the two share models and a search
 * backend but not a system prompt or a user's memory, so treat a result as "what ChatGPT says
 * when asked through the API", which is the closest thing OpenAI offers.
 *
 * The provider only fetches. It asks for the answer and the businesses it named as structured
 * output, collects the URLs the answer cited, and returns an `Observation`. Whether the business
 * was named is decided by `analyzeObservation`.
 *
 * OpenAI requires citations to be shown, visible and clickable, wherever information from web
 * results is displayed. The cited URLs returned here are what the app shows beside an excerpt.
 */

const ENDPOINT = "https://api.openai.com/v1/responses";
const TIMEOUT_MS = 90_000;

/** What the model is asked to return. The descriptions are instructions to the model. */
const ANSWER_FORMAT = {
  type: "json_schema",
  name: "local_recommendations",
  strict: true,
  schema: {
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
    additionalProperties: false,
  },
} as const;

const AnswerSchema = z.object({
  answer: z.string(),
  businesses: z.array(z.string()),
});

const ContentSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  refusal: z.string().optional(),
  annotations: z
    .array(z.looseObject({ type: z.string().optional(), url: z.string().optional() }))
    .optional(),
});

const ResponseSchema = z.looseObject({
  status: z.string().optional(),
  incomplete_details: z.looseObject({ reason: z.string().optional() }).nullish(),
  output: z
    .array(z.looseObject({ type: z.string(), content: z.array(ContentSchema).optional() }))
    .optional(),
});

const count = z.number().int().nonnegative().catch(0);

/** The parts of a response that say what it used. Anything missing counts as none. */
const UsedSchema = z.looseObject({
  model: z.string().optional(),
  usage: z
    .looseObject({
      input_tokens: count,
      output_tokens: count,
      input_tokens_details: z.looseObject({ cached_tokens: count }).optional(),
    })
    .optional(),
  tool_usage: z
    .looseObject({ web_search: z.looseObject({ num_requests: count }).optional() })
    .optional(),
});

/**
 * What a response says it used. OpenAI counts cached tokens inside `input_tokens`, so they are
 * taken back out: the two are charged at different rates.
 */
export function chatGptUsage(body: unknown, askedFor: string): CallUsage | null {
  const parsed = UsedSchema.safeParse(body);
  if (!parsed.success || !parsed.data.usage) return null;
  const { usage, tool_usage, model } = parsed.data;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return {
    model: model ?? askedFor,
    input_tokens: Math.max(0, usage.input_tokens - cached),
    cached_input_tokens: cached,
    output_tokens: usage.output_tokens,
    searches: tool_usage?.web_search?.num_requests ?? 0,
  };
}

const ErrorSchema = z.looseObject({
  error: z.looseObject({ message: z.string().optional(), code: z.string().nullish() }),
});

/** OpenAI tags the links it cites. The tag is theirs, not part of the page's address. */
const OPENAI_TAGS = new Set(["openai", "chatgpt.com"]);

function withoutTracking(url: string): string {
  try {
    const parsed = new URL(url);
    if (OPENAI_TAGS.has(parsed.searchParams.get("utm_source") ?? "")) {
      parsed.searchParams.delete("utm_source");
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Turns one Responses API body into an observation. Throws when it is unusable. */
export function parseChatGptResponse(body: unknown): Observation {
  const response = ResponseSchema.parse(body);
  if (response.status && response.status !== "completed") {
    const reason = response.incomplete_details?.reason;
    throw new Error(
      `ChatGPT did not finish the request (status: ${response.status}${reason ? `, ${reason}` : ""}).`,
    );
  }

  const content = (response.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? []);
  if (content.some((part) => part.type === "refusal")) {
    throw new Error("ChatGPT declined to answer the prompt.");
  }

  const parts = content.filter((part) => part.type === "output_text");
  const text = parts.map((part) => part.text ?? "").join("");
  if (!text.trim()) throw new Error("ChatGPT returned no answer text.");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("ChatGPT's answer was not the JSON it was asked for.");
  }
  const answer = AnswerSchema.safeParse(json);
  if (!answer.success) throw new Error("ChatGPT's answer did not match the requested shape.");

  const cited = parts
    .flatMap((part) => part.annotations ?? [])
    .filter((annotation) => annotation.type === "url_citation" && annotation.url)
    .map((annotation) => withoutTracking(annotation.url as string));

  return {
    kind: "answer",
    text: answer.data.answer,
    businesses: answer.data.businesses,
    cited_urls: [...new Set(cited)],
  };
}

export interface ChatGptOptions {
  apiKey: string;
  tuning: Pick<Tuning, "prompts" | "chatgpt">;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
}

export function createChatGptProvider(options: ChatGptOptions): SurfaceProvider {
  const send = options.fetch ?? fetch;

  return {
    surface: "chatgpt",
    async observe({ location, query, onUsage }: ObserveInput): Promise<Observation> {
      const prompt = renderPrompt(options.tuning.prompts, "chatgpt", {
        query: query.text,
        city: location.city,
        region: location.region,
      });

      const response = await send(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: options.tuning.chatgpt.model,
          input: prompt,
          tools: [
            {
              type: "web_search",
              // Searches as someone in the business's own town would, which is what a local
              // recommendation depends on.
              user_location: {
                type: "approximate",
                city: location.city,
                region: location.region,
                country: location.country_code,
              },
            },
          ],
          text: { format: ANSWER_FORMAT },
          // Nothing here needs to be retrievable from OpenAI later.
          store: false,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        // The message only: an error body can echo the request, and the request holds the prompt.
        const error = ErrorSchema.safeParse(body);
        const detail = error.success ? (error.data.error.message ?? error.data.error.code) : null;
        throw new Error(
          `ChatGPT request failed (${response.status})${detail ? `: ${detail}` : ""}`,
        );
      }

      // Before the answer is read: a response that turns out to be unusable was still paid for.
      const used = chatGptUsage(body, options.tuning.chatgpt.model);
      if (used) onUsage?.(used);

      return parseChatGptResponse(body);
    },
  };
}
