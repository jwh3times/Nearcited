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

export type { ObserveInput, ProviderRegistry, SurfaceProvider } from "./types";
