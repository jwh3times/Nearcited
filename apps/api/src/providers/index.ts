import { SURFACES, type Surface, type Tuning, type TuningSource } from "@nearcited/shared";
import type { Env } from "../env";
import { createLiveProviders, liveSurfaces } from "./live";
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
export function createProviders(env: Env, tuning: Tuning): ProviderRegistry {
  return usesSampleData(env) ? createMockProviders() : createLiveProviders(env, tuning);
}

/** The surfaces a scan checks in this environment. Sample data covers all of them. */
export function checkedSurfaces(
  env: Pick<Env, "PROVIDER_MODE" | "OPENAI_API_KEY" | "ANTHROPIC_API_KEY">,
): Surface[] {
  return usesSampleData(env) ? [...SURFACES] : liveSurfaces(env);
}

/**
 * Narrows a set of surfaces to the ones an organization's plan covers. `allowed` is the
 * organization's `surfaces`: null means it gets everything that is set up.
 */
export function planSurfaces<T extends Surface>(
  available: readonly T[],
  allowed: readonly Surface[] | null,
): T[] {
  return allowed === null
    ? [...available]
    : available.filter((surface) => allowed.includes(surface));
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
