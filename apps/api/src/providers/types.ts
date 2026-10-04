import type { Location, Observation, Surface, TrackedQuery } from "@nearcited/shared";

export interface ObserveInput {
  location: Location;
  query: TrackedQuery;
  at: Date;
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
