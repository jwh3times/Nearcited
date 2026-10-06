import type { Tuning } from "@nearcited/shared";
import type { Env } from "../env";
import { createGeminiProvider } from "./gemini";
import type { ProviderRegistry } from "./types";

/**
 * Real data providers. A surface is registered only when its key is present, and a surface with
 * no provider is skipped, so a scan checks whatever is configured and nothing else.
 *
 * To add one: implement `SurfaceProvider` in its own file, read its key from `Env`, and register
 * it here. What the remaining surfaces need:
 *
 * - chatgpt, perplexity, claude: as `gemini.ts` does. Send the rendered prompt to that vendor's
 *   API with web search turned on, ask for the answer and the businesses it named as structured
 *   output, and collect the URLs it cited. Answers vary between runs, so one call is a sample,
 *   not a measurement.
 *
 * - google_local_pack, google_organic, google_ai_overview: Google has no API for these. Use a
 *   SERP data vendor and pass the location's coordinates, because results change block by block.
 *   Cost is per keyword, per location, per run.
 *
 * See docs/architecture.md for the limits a Worker puts on a scan.
 */
export function createLiveProviders(
  env: Pick<Env, "GEMINI_API_KEY">,
  tuning: Tuning,
): ProviderRegistry {
  const providers: ProviderRegistry = {};
  if (env.GEMINI_API_KEY) {
    providers.gemini = createGeminiProvider({
      apiKey: env.GEMINI_API_KEY,
      tuning,
      // One line per call, so the cost of a check can be read from the Worker's logs.
      onUsage: (usage) => console.log("gemini usage", JSON.stringify(usage)),
    });
  }
  return providers;
}
