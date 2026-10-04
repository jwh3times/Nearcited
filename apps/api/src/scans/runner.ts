import {
  analyzeObservation,
  deriveRecommendations,
  type Location,
  type Scan,
  SURFACES_BY_KIND,
  visibilityScore,
} from "@nearcited/shared";
import type { ProviderRegistry } from "../providers";
import type { NewScanResult, Store } from "../store/types";

export interface ScanReport {
  location: Location;
  scan: Scan;
  score: number | null;
  results: NewScanResult[];
}

export interface RunScanDeps {
  /** Must be a store made with the secret key. */
  store: Store;
  providers: ProviderRegistry;
  now?: () => Date;
  /** Called after a scheduled scan succeeds. A failure here is logged and does not fail the scan. */
  notify?: (report: ScanReport) => Promise<void>;
}

export type ScanOutcome = "succeeded" | "failed" | "skipped";

/** A failure that retrying cannot fix, such as a location with nothing to check. */
class PermanentScanFailure extends Error {}

/**
 * Runs one scan to completion.
 *
 * Returns "failed" for failures that will not change on retry. Throws for everything else, after
 * recording the failure on the scan, so the queue redelivers the message. Safe to call again for
 * the same scan: a finished scan is skipped and a re-run replaces its earlier results.
 */
export async function runScan(scanId: string, deps: RunScanDeps): Promise<ScanOutcome> {
  const { store, providers } = deps;
  const now = deps.now ?? (() => new Date());

  const scan = await store.getScan(scanId);
  if (!scan || scan.status === "succeeded") return "skipped";
  const location = await store.getLocation(scan.location_id);
  if (!location) return "skipped";

  try {
    await store.markScanRunning(scanId);

    const queries = (await store.listQueries(location.id)).filter((query) => query.is_active);
    if (queries.length === 0) {
      throw new PermanentScanFailure("Add at least one prompt or keyword before scanning.");
    }

    const checks = queries.flatMap((query) =>
      SURFACES_BY_KIND[query.kind].flatMap((surface) => {
        const provider = providers[surface];
        return provider ? [{ query, provider }] : [];
      }),
    );
    if (checks.length === 0) {
      throw new PermanentScanFailure("No data provider is configured for these queries.");
    }

    const at = now();
    // One failed check fails the whole scan. Scoring a partial scan would move the number for
    // reasons that have nothing to do with the business.
    const results: NewScanResult[] = await Promise.all(
      checks.map(async ({ query, provider }) => {
        const observation = await provider.observe({ location, query, at });
        return {
          tracked_query_id: query.id,
          surface: provider.surface,
          ...analyzeObservation(observation, location),
        };
      }),
    );

    const score = visibilityScore(results);
    await store.completeScan(scanId, {
      score,
      results,
      recommendations: deriveRecommendations(location, results),
    });

    if (scan.trigger === "scheduled" && deps.notify) {
      try {
        await deps.notify({ location, scan, score, results });
      } catch (error) {
        console.error(`Scan ${scanId} finished but its report was not sent`, error);
      }
    }
    return "succeeded";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.failScan(scanId, message);
    if (error instanceof PermanentScanFailure) return "failed";
    throw error;
  }
}
