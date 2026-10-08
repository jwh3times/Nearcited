import type { Location, Observation, Surface, TrackedQuery } from "@nearcited/shared";

/**
 * What one call to a provider used, as the provider reported it. Counts only: what a count costs
 * is priced elsewhere, from rates that are not in this repository.
 */
export interface CallUsage {
  /** The model that answered, which can differ from the one asked for when a fallback ran. */
  model: string;
  /** Input tokens charged at the full rate. */
  input_tokens: number;
  /** Input tokens read from the provider's cache, charged at a lower rate. */
  cached_input_tokens: number;
  output_tokens: number;
  /** Web searches the provider ran and charges for. */
  searches: number;
}

export interface ObserveInput {
  location: Location;
  query: TrackedQuery;
  at: Date;
  /**
   * Called once for each call the provider is charged for, including one whose answer is then
   * thrown away. Per check, not per provider, so a scan can add up what it alone used.
   */
  onUsage?: (usage: CallUsage) => void;
}

/**
 * Fetches what one surface says for one query. A provider only reports what it saw; whether the
 * business was named is decided by `analyzeObservation` in the shared package.
 *
 * Throw on any failure. The scan is marked failed and the queue retries it.
 */
export interface SurfaceProvider {
  readonly surface: Surface;
  observe(input: ObserveInput): Promise<Observation>;
}

/** The surfaces that can be checked right now. A missing surface is skipped, not failed. */
export type ProviderRegistry = Partial<Record<Surface, SurfaceProvider>>;
