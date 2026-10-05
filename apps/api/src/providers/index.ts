import type { TuningSource } from "@nearcited/shared";
import type { Env } from "../env";
import { createLiveProviders } from "./live";
import { createMockProviders } from "./mock";
import type { ProviderRegistry } from "./types";

/** True only when generated data was asked for by name. */
export function usesSampleData(env: Pick<Env, "PROVIDER_MODE">): boolean {
  return env.PROVIDER_MODE === "mock";
}

/**
 * Anything other than an explicit "mock" is treated as live, so a missing or mistyped setting
 * fails scans loudly instead of quietly filling the product with generated data.
 */
export function createProviders(env: Env): ProviderRegistry {
  return usesSampleData(env) ? createMockProviders() : createLiveProviders(env);
}

/**
 * Why live scans cannot run on this build, or undefined when they can. A build without the
 * private tuning would send placeholder prompts and score on guessed weights, and store the
 * result as if it were a measurement.
 */
export function liveScansUnavailable(
  env: Pick<Env, "PROVIDER_MODE">,
  tuningSource: TuningSource,
): string | undefined {
  if (usesSampleData(env) || tuningSource === "private") return undefined;
  return "This build has only the public default tuning, so live scans are turned off. Deploy with the private tuning file, or set PROVIDER_MODE to mock.";
}

export type { ObserveInput, ProviderRegistry, SurfaceProvider } from "./types";
