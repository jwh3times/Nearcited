import Anthropic from "@anthropic-ai/sdk";
import { type Observation, renderPrompt, type Tuning } from "@nearcited/shared";
import { z } from "zod";
import type { ObserveInput, SurfaceProvider } from "./types";

/**
 * Claude, through Anthropic's Messages API with the web search tool turned on.
 *
 * This is the API with search, not the consumer Claude app: the two share models and a search
 * backend but not a system prompt or a user's memory, so treat a result as "what Claude says when
 * asked through the API", which is the closest thing Anthropic offers.
 *
 * The provider only fetches. It asks for the answer, the businesses it named and the pages it
 * relied on as structured output, and returns an `Observation`. Whether the business was named
 * is decided by `analyzeObservation`.
 *
 * Anthropic's guidance is to show citations to the original source wherever output is displayed.
 * The URLs returned here are what the app lists beside an excerpt.
 */

const TIMEOUT_MS = 120_000;
/** A long search turn can pause and ask to be resumed. Resume this many times, then give up. */
const MAX_RESUMES = 2;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

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
    sources: {
      type: "array",
      items: { type: "string" },
      description:
        "The URLs of the search results your answer relied on, most important first. Only URLs that appeared in your search results.",
    },
  },
  required: ["answer", "businesses", "sources"],
  additionalProperties: false,
};

const AnswerSchema = z.object({
  answer: z.string(),
  businesses: z.array(z.string()),
  sources: z.array(z.string()),
});

type Message = Anthropic.Beta.BetaMessage;
type ContentBlock = Anthropic.Beta.BetaContentBlock;

/**
 * Turns the content of one finished turn into an observation. Throws when it is unusable.
 *
 * With a JSON output format Claude attaches no citations to its text, so the sources come from
 * the answer itself. Only URLs the search really returned are kept: a model can misremember a
 * link, and a cited page has to be one it was actually shown.
 */
export function parseClaudeContent(content: readonly ContentBlock[]): Observation {
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (!text.trim()) throw new Error("Claude returned no answer text.");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Claude's answer was not the JSON it was asked for.");
  }
  const answer = AnswerSchema.safeParse(json);
  if (!answer.success) throw new Error("Claude's answer did not match the requested shape.");

  const returned = new Set<string>();
  for (const block of content) {
    // A failed search carries one error object here instead of a list of results.
    if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
    for (const result of block.content) returned.add(result.url);
  }

  return {
    kind: "answer",
    text: answer.data.answer,
    businesses: answer.data.businesses,
    cited_urls: [...new Set(answer.data.sources.filter((url) => returned.has(url)))],
  };
}

export interface ClaudeOptions {
  apiKey: string;
  tuning: Pick<Tuning, "prompts" | "claude">;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
  /** Called with what each successful scan used, for measuring cost. */
  onUsage?: (used: { model: string; usage: unknown }) => void;
}

export function createClaudeProvider(options: ClaudeOptions): SurfaceProvider {
  const client = new Anthropic({
    apiKey: options.apiKey,
    fetch: options.fetch,
    timeout: TIMEOUT_MS,
    // A failed check fails the scan, and the queue redelivers the whole scan.
    maxRetries: 0,
  });

  return {
    surface: "claude",
    async observe({ location, query }: ObserveInput): Promise<Observation> {
      const prompt = renderPrompt(options.tuning.prompts, "claude", {
        query: query.text,
        city: location.city,
        region: location.region,
      });
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
      const content: ContentBlock[] = [];

      let response: Message;
      for (let resumes = 0; ; resumes++) {
        try {
          response = await client.beta.messages.create({
            model: options.tuning.claude.model,
            max_tokens: 16000,
            betas: [FALLBACK_BETA],
            // If a safety classifier declines the prompt, Anthropic re-runs it on its
            // recommended fallback model inside the same call.
            fallbacks: "default",
            output_config: {
              effort: "medium",
              format: { type: "json_schema", schema: ANSWER_SCHEMA },
            },
            tools: [
              {
                type: "web_search_20260209",
                name: "web_search",
                // Each search adds its results to the input tokens billed, so cap them.
                max_uses: 3,
                // Plain searches. The default on this tool version filters results through code
                // execution, which took twice the time and tokens for the same answer.
                allowed_callers: ["direct"],
                // Searches as someone in the business's own town would.
                user_location: {
                  type: "approximate",
                  city: location.city,
                  region: location.region ?? undefined,
                  country: location.country_code,
                },
              },
            ],
            messages,
          });
        } catch (error) {
          // The API's own message only. Most specific first; a connection error has no status.
          if (error instanceof Anthropic.APIConnectionTimeoutError) {
            throw new Error("Claude request timed out.");
          }
          if (error instanceof Anthropic.APIConnectionError) {
            throw new Error(`Claude request failed to connect: ${error.message}`);
          }
          if (error instanceof Anthropic.APIError) {
            throw new Error(`Claude request failed (${error.status}): ${error.message}`);
          }
          throw error;
        }

        content.push(...response.content);
        if (response.stop_reason !== "pause_turn") break;
        if (resumes >= MAX_RESUMES) {
          throw new Error("Claude paused the search more times than this check allows.");
        }
        // Resume by sending the paused turn back exactly as it arrived.
        messages.push({ role: "assistant", content: response.content });
      }

      if (response.stop_reason === "refusal") {
        const category = response.stop_details?.category;
        throw new Error(`Claude declined to answer the prompt${category ? ` (${category})` : ""}.`);
      }
      if (response.stop_reason !== "end_turn") {
        throw new Error(
          `Claude did not finish the request (stop reason: ${response.stop_reason}).`,
        );
      }

      const observation = parseClaudeContent(content);
      // `model` is the one that answered, which differs from the tuning's when a fallback ran.
      options.onUsage?.({ model: response.model, usage: response.usage });
      return observation;
    },
  };
}
