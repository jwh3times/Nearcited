import {
  analyzeObservation,
  analyzeSite,
  deriveRecommendations,
  type Location,
  poolWindow,
  SCAN_WINDOW,
  type Scan,
  type ScoreWeights,
  type SiteCheck,
  type SiteSnapshot,
  SURFACES_BY_KIND,
  windowScore,
} from "@nearcited/shared";
import { type ProviderRegistry, planSurfaces } from "../providers";
import { type NewScanResult, type Store, StoreError } from "../store/types";

export interface ScanReport {
  location: Location;
  scan: Scan;
  /** Scored over the window, not from this scan alone. */
  score: number | null;
  /** This scan's own results. */
  results: NewScanResult[];
  /** Every check the score was counted over: this scan and the recent ones before it. */
  window: { scans: number; results: NewScanResult[] };
}

export interface RunScanDeps {
  /** Must be a store made with the secret key. */
  store: Store;
  providers: ProviderRegistry;
  /** Score weights from the tuning. Defaults to the public ones. */
  weights?: ScoreWeights;
  /** When set, no scan can run on this build, and every scan fails with this reason. */
  unavailable?: string;
  /** Whether the providers serve generated sample data. Recorded on the scan. */
  sampleData?: boolean;
  now?: () => Date;
  /**
   * Fetches a location's own website for the on-page check. Left out where no real page should be
   * fetched, such as a deployment serving sample data; the scan then makes no claim about the site.
   */
  inspectSite?: (website: string) => Promise<SiteSnapshot>;
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
  const sampleData = deps.sampleData ?? false;
  const now = deps.now ?? (() => new Date());

  const scan = await store.getScan(scanId);
  if (!scan || scan.status === "succeeded") return "skipped";
  const location = await store.getLocation(scan.location_id);
  if (!location) return "skipped";

  try {
    await store.markScanRunning(scanId, sampleData);
  } catch (error) {
    // A redelivered message for a scan that already failed, while a newer scan for the same
    // location is in flight. The newer one stands; this one stays as it was.
    if (error instanceof StoreError && error.kind === "conflict") return "skipped";
    throw error;
  }

  try {
    if (deps.unavailable) throw new PermanentScanFailure(deps.unavailable);

    const queries = (await store.listQueries(location.id)).filter((query) => query.is_active);
    if (queries.length === 0) {
      throw new PermanentScanFailure("Add at least one prompt or keyword before scanning.");
    }

    // A scan checks the surfaces that are set up and that the organization's plan covers. Each
    // check costs money, so a surface outside the plan is never called.
    const organization = await store.getOrganization(location.organization_id);
    const covered = (kind: (typeof queries)[number]["kind"]) =>
      planSurfaces(SURFACES_BY_KIND[kind], organization?.surfaces ?? null);
    const checks = queries.flatMap((query) =>
      covered(query.kind).flatMap((surface) => {
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

    // One answer is a sample, so the score and the recommendations are counted over this scan and
    // the recent ones before it. This scan is not yet marked succeeded, so it is not among them.
    const earlier = await store.listRecentResults(location.id, SCAN_WINDOW - 1, sampleData);
    const scans: NewScanResult[][] = [results, ...earlier];
    const pooled = poolWindow(scans);
    const score = windowScore(scans, deps.weights);

    // The on-page check never fails a scan: a site that will not load is itself the finding.
    let site: SiteCheck | null = null;
    if (deps.inspectSite && location.website) {
      const snapshot = await deps.inspectSite(location.website).catch(
        (): SiteSnapshot => ({
          url: location.website ?? "",
          status: null,
          html: null,
          robots_txt: null,
          noindex_header: false,
        }),
      );
      site = analyzeSite(snapshot, location);
    }

    await store.completeScan(scanId, {
      score,
      results,
      recommendations: deriveRecommendations(location, pooled, site),
    });

    if (scan.trigger === "scheduled" && deps.notify) {
      try {
        await deps.notify({
          location,
          scan,
          score,
          results,
          window: { scans: scans.length, results: pooled },
        });
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
