import type { Surface, Tuning } from "@nearcited/shared";
import type { Env } from "../env";
import { createChatGptProvider } from "./chatgpt";
import { createClaudeProvider } from "./claude";
import type { ProviderRegistry } from "./types";

/**
 * Real data providers. A surface is registered only when its key is present, and a surface with
 * no provider is skipped, so a scan checks whatever is configured and nothing else.
 *
 * To add one: implement `SurfaceProvider` in its own file, read its key from `Env`, and register
 * it here. What the remaining surfaces need:
 *
 * - perplexity: as `chatgpt.ts` and `claude.ts` do. Send the rendered prompt to that vendor's
 *   API with web search turned on, ask for the answer and the businesses it named as structured
 *   output, and collect the URLs it cited. Answers vary between runs, so one call is a sample,
 *   not a measurement.
 *
 * - gemini: not through Google's own API. Its terms for Grounding with Google Search do not
 *   allow grounded results to be stored, analysed or collected, which is what a scan does. It
 *   would have to come from a data vendor.
 *
 * - google_local_pack, google_organic, google_ai_overview: Google has no API for these. Use a
 *   SERP data vendor and pass the location's coordinates, because results change block by block.
 *   Cost is per keyword, per location, per run.
 *
 * See docs/architecture.md for the limits a Worker puts on a scan.
 */
export function createLiveProviders(
  env: Pick<Env, "OPENAI_API_KEY" | "ANTHROPIC_API_KEY">,
  tuning: Tuning,
): ProviderRegistry {
  const providers: ProviderRegistry = {};
  if (env.OPENAI_API_KEY) {
    providers.chatgpt = createChatGptProvider({
      apiKey: env.OPENAI_API_KEY,
      tuning,
    });
  }
  if (env.ANTHROPIC_API_KEY) {
    providers.claude = createClaudeProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      tuning,
    });
  }
  return providers;
}

/** The surfaces `createLiveProviders` would register for this environment, without building them. */
export function liveSurfaces(env: Pick<Env, "OPENAI_API_KEY" | "ANTHROPIC_API_KEY">): Surface[] {
  const surfaces: Surface[] = [];
  if (env.OPENAI_API_KEY) surfaces.push("chatgpt");
  if (env.ANTHROPIC_API_KEY) surfaces.push("claude");
  return surfaces;
}
