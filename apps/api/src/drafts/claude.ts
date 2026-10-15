import Anthropic from "@anthropic-ai/sdk";
import {
  type ActiveTuning,
  DRAFT_KINDS,
  type DraftGiven,
  type DraftKind,
  type DraftsTuning,
} from "@nearcited/shared";
import type { Env } from "../env";
import { claudeUsage } from "../providers/claude";
import type { DraftWriter } from "./sample";

/**
 * A draft written by Claude, through Anthropic's Messages API, with no tools: it is given the
 * details and writes from them, and searches for nothing.
 *
 * The writer only writes. It returns the text and reports what the call used. Whether the text
 * may be kept is decided by `factsNobodyGave`, on whatever comes back.
 */

const TIMEOUT_MS = 60_000;

/** A detail as one line for the model. One that is not on file is said to be so, not left blank. */
const line = (label: string, value: string | null) => `${label}: ${value ?? "not on file"}`;

/**
 * What a draft is written from, set out for the model. Everything in `DraftGiven` and nothing
 * else: this is all the model is told about the business.
 */
export function setOut(given: DraftGiven): string {
  const lines = [
    line("Business name", given.name),
    line("City", given.city),
    line("State or region", given.region),
    line("Category", given.category),
    line("Website", given.website),
    line("What the business does, in its owner's words", given.what_we_do),
  ];
  // A page answers a prompt on the business's own site, so it has no other site or page to name.
  if (given.prompt !== null)
    return [...lines, line("The question the page answers", given.prompt)].join("\n");
  return [...lines, line("The site", given.host), line("The page", given.url)].join("\n");
}

export interface ClaudeDraftOptions {
  apiKey: string;
  tuning: DraftsTuning;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
}

export function createClaudeDraftWriter(options: ClaudeDraftOptions): DraftWriter {
  const { tuning } = options;
  const client = new Anthropic({
    apiKey: options.apiKey,
    fetch: options.fetch,
    timeout: TIMEOUT_MS,
    // A draft that fails is not counted, and its reader asks again.
    maxRetries: 0,
  });

  return {
    model: tuning.model,
    kinds: DRAFT_KINDS.filter((kind) => tuning.instructions[kind] !== undefined),
    async write({ kind, given }, onUsage) {
      const instructions = tuning.instructions[kind];
      if (!instructions) throw new Error(`This build has no instructions for a ${kind} draft.`);

      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model: tuning.model,
          max_tokens: tuning.max_tokens,
          output_config: { effort: tuning.effort },
          system: instructions,
          messages: [{ role: "user", content: setOut(given) }],
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

      // Every response is a call that was charged for, one refused or cut short as much as any.
      onUsage?.(claudeUsage(response));

      if (response.stop_reason === "refusal") {
        throw new Error("Claude declined to write the draft.");
      }
      if (response.stop_reason !== "end_turn") {
        throw new Error(`Claude did not finish the draft (stop reason: ${response.stop_reason}).`);
      }
      return response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    },
  };
}

/**
 * The kinds of draft this build can write on real data: those its private tuning has
 * instructions for. None on the default tuning, whose wording is a placeholder, for the reason
 * live scans refuse it: what it wrote would be shown as the product's own work.
 */
export function liveDraftKinds(active: ActiveTuning): DraftKind[] {
  if (active.source !== "private" || !active.tuning.drafts) return [];
  const { instructions } = active.tuning.drafts;
  return DRAFT_KINDS.filter((kind) => instructions[kind] !== undefined);
}

/** What writes a real draft on this build, or undefined where nothing can: no key, or no wording. */
export function createLiveDraftWriter(
  env: Pick<Env, "ANTHROPIC_API_KEY">,
  active: ActiveTuning,
): DraftWriter | undefined {
  const { drafts } = active.tuning;
  if (!env.ANTHROPIC_API_KEY || !drafts || liveDraftKinds(active).length === 0) return undefined;
  return createClaudeDraftWriter({ apiKey: env.ANTHROPIC_API_KEY, tuning: drafts });
}
