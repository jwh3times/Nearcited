import { GOOGLE_SURFACES, type Surface, type Tuning } from "@nearcited/shared";
import type { Env } from "../env";
import { createChatGptProvider } from "./chatgpt";
import { createClaudeProvider } from "./claude";
import { createDataForSeoProviders } from "./dataforseo";
import type { ProviderRegistry } from "./types";

/** The keys live scans read. */
export type LiveKeys = Pick<
  Env,
  | "OPENAI_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "DATAFORSEO_LOGIN"
  | "DATAFORSEO_PASSWORD"
  | "MAPBOX_TOKEN"
>;

/**
 * DataForSEO's sign-in where Google can be checked: it gives the results, and Mapbox the point
 * they are checked from, so one without the other checks nothing. Null where it cannot.
 */
function googleSignIn(env: LiveKeys): { login: string; password: string } | null {
  return env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD && env.MAPBOX_TOKEN
    ? { login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD }
    : null;
}

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
 * Google's map pack, organic results, AI Overview and AI Mode come from a SERP data vendor,
 * DataForSEO (`dataforseo.ts`), checked from the location's point.
 *
 * See docs/architecture.md for the limits a Worker puts on a scan.
 */
export function createLiveProviders(env: LiveKeys, tuning: Tuning): ProviderRegistry {
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
  const signIn = googleSignIn(env);
  if (signIn) Object.assign(providers, createDataForSeoProviders({ ...signIn, tuning }));
  return providers;
}

/** The surfaces `createLiveProviders` would register for this environment, without building them. */
export function liveSurfaces(env: LiveKeys): Surface[] {
  const surfaces: Surface[] = [];
  if (env.OPENAI_API_KEY) surfaces.push("chatgpt");
  if (env.ANTHROPIC_API_KEY) surfaces.push("claude");
  if (googleSignIn(env)) surfaces.push(...GOOGLE_SURFACES);
  return surfaces;
}
