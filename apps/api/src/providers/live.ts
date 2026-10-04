import type { Env } from "../env";
import type { ProviderRegistry } from "./types";

/**
 * Real data providers. None are implemented yet, so live mode checks nothing and every scan
 * fails with "No data provider is configured".
 *
 * To add one: implement `SurfaceProvider` in its own file, read its key from `Env`, and register
 * it here only when that key is present. What each surface needs:
 *
 * - chatgpt, gemini, perplexity, claude: send the prompt, with the location's city and region
 *   stated in it, to that vendor's API with web search or grounding turned on. Return the answer
 *   text, the URLs it cited, and the businesses it named in order (ask for those as structured
 *   output; do not parse them out of prose). Answers vary between runs, so one call is a sample,
 *   not a measurement: decide how many samples per check before trusting a trend.
 *
 * - google_local_pack, google_organic, google_ai_overview: Google has no API for these. Use a
 *   SERP data vendor and pass the location's coordinates, because results change block by block.
 *   Cost is per keyword, per location, per run.
 *
 * See docs/architecture.md for the limits a Worker puts on a scan.
 */
export function createLiveProviders(_env: Env): ProviderRegistry {
  return {};
}
