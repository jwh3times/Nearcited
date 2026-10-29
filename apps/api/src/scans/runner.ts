import {
  type AlertScan,
  type AlertsToTell,
  analyzeCitedPage,
  analyzeObservation,
  analyzeSite,
  type CitedPage,
  type CitedPageSnapshot,
  type CitedPageTarget,
  citedPagesToRead,
  coveredSurfaces,
  type DerivedRecommendation,
  daysToRead,
  deriveAlerts,
  deriveRecommendations,
  FETCHES_ALLOWANCE,
  FIRST_SEEN_SCANS,
  hasNewcomers,
  isCountedAnswer,
  isGoogle,
  type Location,
  needsPoint,
  pointQuery,
  poolWindow,
  SCAN_WINDOW,
  type Scan,
  type ScoreWeights,
  type SiteCheck,
  type SiteSnapshot,
  SURFACES_BY_KIND,
  type Surface,
  sampleFetches,
  sourceOfRule,
  summarizeSources,
  type Tier,
  tierOf,
  windowScore,
} from "@nearcited/shared";
import { type ProviderRegistry, planSurfaces } from "../providers";
import type { Geocoder } from "../providers/mapbox";
import type { CallUsage } from "../providers/types";
import { usageTally } from "../providers/usage";
import { type LocationPoint, type NewScanResult, type Store, StoreError } from "../store/types";

export interface ScanReport {
  location: Location;
  scan: Scan;
  /** Scored over the window, not from this scan alone. */
  score: number | null;
  /** This scan's own results. */
  results: NewScanResult[];
  /** Every check the score was counted over: this scan and the recent ones before it. */
  window: { scans: number; results: NewScanResult[] };
  /** What the owners have not been told yet: new alerts, and drops that have ended. */
  alerts: AlertsToTell;
}

export interface RunScanDeps {
  /** Must be a store made with the secret key. */
  store: Store;
  providers: ProviderRegistry;
  /**
   * The same assistants asked with the tuning's stronger settings, for an organization that pays
   * for them. An assistant with none here is asked on Standard, and the result says so.
   */
  strongerProviders?: ProviderRegistry;
  /** Score weights from the tuning. Defaults to the public ones. */
  weights?: ScoreWeights;
  /** When set, no scan can run on this build, and every scan fails with this reason. */
  unavailable?: string;
  /** Whether the providers serve generated sample data. Recorded on the scan. */
  sampleData?: boolean;
  /**
   * Providers of generated data, for a test organization's scans in a deployment that is
   * otherwise live. Without them such a scan fails: it must never reach a real provider.
   */
  sampleProviders?: ProviderRegistry;
  now?: () => Date;
  /**
   * Fetches a location's own website for the on-page check. Left out where no real page should be
   * fetched, such as a deployment serving sample data; the scan then makes no claim about the site.
   */
  inspectSite?: (website: string) => Promise<SiteSnapshot>;
  /**
   * Fetches the pages answers cited for the directory tasks, for the cited-page check. Left out
   * where no real page should be fetched, as `inspectSite` is; the scan then reads none.
   */
  readCitedPages?: (targets: CitedPageTarget[]) => Promise<CitedPageSnapshot[]>;
  /**
   * Finds the point a location's Google results are checked from. Without it, a location with no
   * point kept is not checked on Google.
   */
  geocode?: Geocoder;
  /**
   * Called after a scheduled scan succeeds, and answers whether the report went to anyone. A
   * failure here is logged and does not fail the scan.
   */
  notify?: (report: ScanReport) => Promise<boolean>;
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
  const { store } = deps;
  const now = deps.now ?? (() => new Date());

  const scan = await store.getScan(scanId);
  if (!scan || scan.status === "succeeded") return "skipped";
  const stored = await store.getLocation(scan.location_id);
  if (!stored) return "skipped";
  // Its point may be found below, before its Google checks.
  let location: Location = stored;
  const organization = await store.getOrganization(location.organization_id);

  // A test organization's scans are generated even where everyone else's are real: they ask no
  // provider, fetch no site and email nobody. See docs/adr/0003.
  const generated = organization?.is_test === true && deps.sampleData !== true;
  const sampleData = generated || (deps.sampleData ?? false);
  const providers = generated ? (deps.sampleProviders ?? {}) : deps.providers;
  // A test organization pays for nothing, so its generated scans are all Standard.
  const tierOn = (surface: Surface): Tier =>
    organization && !organization.is_test ? tierOf(organization, surface) : "standard";

  try {
    await store.markScanRunning(scanId, sampleData);
  } catch (error) {
    // A redelivered message for a scan that already failed, while a newer scan for the same
    // location is in flight. The newer one stands; this one stays as it was.
    if (error instanceof StoreError && error.kind === "conflict") return "skipped";
    throw error;
  }

  // What this scan's calls use, kept whether it goes on to succeed or not: a check that was
  // answered was charged for, even when another check then fails the scan.
  const used = usageTally();
  const keepUsage = async () => {
    try {
      await store.recordUsage(
        { organization_id: location.organization_id, scan_id: scanId },
        used.take(),
      );
    } catch (error) {
      // Losing the record must not change what happens to the scan.
      console.error(`Scan ${scanId} could not record what it used`, error);
    }
  };

  try {
    // What stops a live scan on this build does not stop a generated one.
    if (deps.unavailable && !generated) throw new PermanentScanFailure(deps.unavailable);

    const queries = (await store.listQueries(location.id)).filter((query) => query.is_active);
    if (queries.length === 0) {
      throw new PermanentScanFailure("Add at least one prompt or keyword before scanning.");
    }

    // A scan checks the surfaces that are set up and that the organization's plan covers. Each
    // check costs money, so a surface outside the plan is never called.
    const covered = (kind: (typeof queries)[number]["kind"]) =>
      planSurfaces(SURFACES_BY_KIND[kind], organization ? coveredSurfaces(organization) : null);
    let checks = queries.flatMap((query) =>
      covered(query.kind).flatMap((surface) => {
        const strong =
          tierOn(surface) === "stronger" ? deps.strongerProviders?.[surface] : undefined;
        const provider = strong ?? providers[surface];
        const tier: Tier = strong ? "stronger" : "standard";
        return provider ? [{ query, provider, tier }] : [];
      }),
    );
    // Google is checked from the location's own point, found from its address before the first
    // Google check, again when the address changes, and again at each scan while it cannot be
    // placed at all. Generated results need none.
    if (!sampleData && checks.some((check) => isGoogle(check.provider.surface))) {
      if ((needsPoint(location) || location.latitude === null) && deps.geocode) {
        const point = await findPoint(location, deps.geocode, used.on(null));
        await store.setLocationPoint(location.id, point);
        location = { ...location, ...point };
      }
      // A location that could not be placed is not checked on Google this time.
      if (location.latitude === null) {
        checks = checks.filter((check) => !isGoogle(check.provider.surface));
        if (checks.length === 0) {
          throw new PermanentScanFailure(
            "Google was not checked: the location's address could not be found on the map. Check its city and street address.",
          );
        }
      }
    }
    if (checks.length === 0) {
      throw new PermanentScanFailure("No data provider is configured for these queries.");
    }
    const checked = location;

    const at = now();
    // One failed check fails the whole scan. Scoring a partial scan would move the number for
    // reasons that have nothing to do with the business.
    const results: NewScanResult[] = await Promise.all(
      checks.map(async ({ query, provider, tier }) => {
        const observation = await provider.observe({
          location: checked,
          query,
          at,
          onUsage: used.on(provider.surface),
        });
        return {
          tracked_query_id: query.id,
          surface: provider.surface,
          tier,
          ...analyzeObservation(observation, checked, provider.surface),
        };
      }),
    );

    await keepUsage();

    // One answer is a sample, so the score and the recommendations are counted over this scan and
    // the recent ones before it. This scan is not yet marked succeeded, so it is not among them.
    const earlier = await store.listRecentResults(location.id, SCAN_WINDOW - 1, sampleData);
    const scans: NewScanResult[][] = [results, ...earlier];
    const pooled = poolWindow(scans);
    const score = windowScore(scans, deps.weights);

    // The on-page check never fails a scan: a site that will not load is itself the finding.
    let site: SiteCheck | null = null;
    if (deps.inspectSite && location.website && !generated) {
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

    // An alert is kept from one scan to the next, so its rules are given the ones still
    // current beside the window. Each earlier scan is known by the results it left.
    const recent: AlertScan[] = [
      { id: scanId, at: at.toISOString(), checks: results },
      ...earlier.map((checks) => ({
        id: checks[0]?.scan_id ?? null,
        at: checks[0]?.sampled_at ?? at.toISOString(),
        checks,
      })),
    ];
    const alerts = deriveAlerts({
      scans: recent,
      current: await store.listAlerts(location.id, sampleData),
      prompts: queries,
      website: location.website,
      phone: location.phone,
      country_code: location.country_code,
      // "For the first time" is said of the whole record, which is read only when the latest
      // scans hold something it might be said of. This scan is not yet among the finished ones.
      seen: hasNewcomers(recent, location.website)
        ? await store.listSeenBefore(location.id, sampleData, FIRST_SEEN_SCANS - 1)
        : null,
    });

    const recommendations = deriveRecommendations(location, pooled, site, queries);
    // Like the on-page check, a page that cannot be read never fails the scan.
    let citedPages: CitedPage[] | null = null;
    if (deps.readCitedPages && !generated) {
      citedPages = await checkCitedPages(
        location,
        pooled,
        recommendations,
        deps.readCitedPages,
        store,
      );
    }

    await store.completeScan(scanId, {
      score,
      results,
      recommendations,
      site,
      cited_pages: citedPages,
      alerts,
    });

    // On sample data the site's fetches are made up too, for the page to show what a Cloudflare
    // connection would read. Nothing asks Cloudflare, and nothing is worked out from them.
    if (sampleData && organization?.allowances[FETCHES_ALLOWANCE] !== undefined) {
      const days = daysToRead(null, now());
      const [from, to] = [days[0], days.at(-1)];
      try {
        if (from && to) {
          await store.recordSiteFetches(
            location.id,
            { from, to, sample: true },
            sampleFetches(location.id, days),
          );
        }
      } catch (error) {
        // The scan stands. The next one makes them.
        console.error(`Scan ${scanId}: could not make its sample fetches`, error);
      }
    }

    // A test organization's owner is automation: there is nobody to tell.
    // A report is emailed only where the organization's plan includes one.
    if (
      scan.trigger === "scheduled" &&
      deps.notify &&
      !organization?.is_test &&
      organization?.emails_report !== false
    ) {
      // An alert is told once, in the report: the ones not yet told lead it. A manual scan
      // sends no report, so what it raised goes in the next one that is sent.
      let news: AlertsToTell = { raised: [], named_again: [] };
      try {
        news = await store.listAlertsToTell(location.id, sampleData);
      } catch (error) {
        // The report still goes. What it would have said of alerts leads the next one.
        console.error(`Scan ${scanId}: its report goes without its alerts, unread`, error);
      }
      let sent = false;
      try {
        sent = await deps.notify({
          location,
          scan,
          score,
          results,
          window: { scans: scans.length, results: pooled },
          alerts: news,
        });
      } catch (error) {
        console.error(`Scan ${scanId} finished but its report was not sent`, error);
      }
      if (sent && news.raised.length + news.named_again.length > 0) {
        try {
          await store.markAlertsTold(
            {
              raised: news.raised.map((alert) => alert.id),
              named_again: news.named_again.map((alert) => alert.id),
            },
            now().toISOString(),
          );
        } catch (error) {
          // The report went. Without this the next one says the same alerts again.
          console.error(`Scan ${scanId}: could not keep that its alerts were told`, error);
        }
      }
    }
    return "succeeded";
  } catch (error) {
    await keepUsage();
    const message = error instanceof Error ? error.message : String(error);
    await store.failScan(scanId, message);
    if (error instanceof PermanentScanFailure) return "failed";
    throw error;
  }
}

/**
 * The cited-page check (docs/adr/0027): the pages the answers in the window cited most for the
 * directory tasks this scan leaves open, read and compared with the location's details. A task a
 * member dismissed is not read. What a page shows is kept; the page is not.
 */
async function checkCitedPages(
  location: Location,
  pooled: readonly NewScanResult[],
  recommendations: readonly DerivedRecommendation[],
  read: NonNullable<RunScanDeps["readCitedPages"]>,
  store: Store,
): Promise<CitedPage[]> {
  const answers = pooled
    .filter(isCountedAnswer)
    .map((result) => ({ mentioned: result.mentioned, cited_urls: result.cited_urls ?? [] }));
  const sources = summarizeSources(answers, location.website, Number.POSITIVE_INFINITY);
  const dismissed = new Set(
    (await store.listRecommendations(location.id))
      .filter((recommendation) => recommendation.status === "dismissed")
      .flatMap((recommendation) => sourceOfRule(recommendation.rule) ?? []),
  );
  const targets = citedPagesToRead(recommendations, sources, dismissed);
  if (targets.length === 0) return [];
  const snapshots = await read(targets).catch((error) => {
    console.error(`Location ${location.id}: the cited pages could not be read`, error);
    return targets.map(
      (target): CitedPageSnapshot => ({
        ...target,
        status: null,
        html: null,
        not_read: "unreachable",
      }),
    );
  });
  return snapshots.map((snapshot) => analyzeCitedPage(snapshot, location));
}

/**
 * Where a location's Google results are checked from: its street address, or the middle of its
 * city when it has none or the address cannot be found, or nowhere when neither can. What was
 * looked for is kept either way, so it is not looked for again until the address changes.
 */
async function findPoint(
  location: Location,
  geocode: Geocoder,
  onUsage: (usage: CallUsage) => void,
): Promise<LocationPoint> {
  const wanted = pointQuery(location);
  const where = { country_code: location.country_code };
  const found = await geocode({ ...wanted, ...where }, onUsage);
  const city =
    found || wanted.source === "city"
      ? null
      : await geocode({ ...pointQuery({ ...location, address_line: null }), ...where }, onUsage);
  const point = found ?? city;
  return {
    latitude: point?.latitude ?? null,
    longitude: point?.longitude ?? null,
    point_source: point ? (found ? wanted.source : "city") : null,
    geocoded_from: wanted.query,
  };
}
