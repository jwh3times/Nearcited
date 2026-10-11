import {
  type AuditJob,
  analyzeObservation,
  analyzeSite,
  buildAuditCell,
  type Location,
  type ScoreWeights,
  type SiteSnapshot,
  SURFACES_BY_KIND,
  type TrackedQuery,
} from "@nearcited/shared";
import type { ProviderRegistry } from "../providers";
import { usageTally } from "../providers/usage";
import type { Store } from "../store/types";

export interface RunAuditDeps {
  /** Must be a store made with the secret key. */
  store: Store;
  providers: ProviderRegistry;
  /** Score weights from the tuning. Defaults to the public ones. */
  weights?: ScoreWeights;
  /** True when the providers serve generated sample data. An audit never runs on it. */
  sampleData: boolean;
  /** When set, live checks cannot run on this build, and the audit fails with this reason. */
  unavailable?: string;
  /** Fetches the business's own website for the on-page check. Without it, no check is made. */
  inspectSite?: (website: string) => Promise<SiteSnapshot>;
  now?: () => Date;
}

export type AuditOutcome = "done" | "failed" | "skipped";

const NIL = "00000000-0000-4000-8000-000000000000";

/** Providers take a location and a tracked query. An audit has neither, so it makes them up. */
function standIns(audit: AuditJob, prompt: string, at: Date) {
  const location: Location = {
    id: audit.id,
    organization_id: NIL,
    name: audit.business_name,
    website: audit.website,
    phone: null,
    address_line: null,
    city: audit.city,
    region: audit.region,
    postal_code: null,
    country_code: audit.country_code,
    google_place_id: null,
    primary_category: null,
    paused_by_plan: false,
    last_scanned_at: null,
    created_at: at.toISOString(),
  };
  const query: TrackedQuery = {
    id: NIL,
    location_id: audit.id,
    kind: "ai_prompt",
    text: prompt,
    is_active: true,
    set_aside_by_plan: false,
    created_at: at.toISOString(),
  };
  return { location, query };
}

/**
 * Asks one of an audit's prompts on every assistant, several times each, and stores the result.
 *
 * One prompt per call keeps a call well inside what a Worker may do in one invocation: each
 * answer is a subrequest, and a whole audit can be fifty of them.
 *
 * Returns "failed" for failures that will not change on retry. Throws for everything else, after
 * recording the failure, so the queue redelivers the message. Safe to repeat: a prompt asked
 * again replaces its earlier result.
 */
export async function runAuditPart(
  auditId: string,
  promptIndex: number,
  deps: RunAuditDeps,
): Promise<AuditOutcome> {
  const { store, providers } = deps;
  const audit = await store.getAudit(auditId);
  if (!audit || audit.revoked_at !== null) return "skipped";
  const prompt = audit.prompts[promptIndex];
  if (prompt === undefined) return "skipped";

  // A prospect is shown this as a measurement. It must never be built from generated data, nor
  // from placeholder prompts and guessed weights.
  if (deps.sampleData) {
    await store.failAudit(
      auditId,
      "Audits need live data, and this deployment serves sample data.",
    );
    return "failed";
  }
  if (deps.unavailable) {
    await store.failAudit(auditId, deps.unavailable);
    return "failed";
  }

  const surfaces = SURFACES_BY_KIND.ai_prompt.filter((surface) => providers[surface]);
  if (surfaces.length === 0) {
    await store.failAudit(auditId, "No assistant is set up to check.");
    return "failed";
  }

  const at = (deps.now ?? (() => new Date()))();
  const input = { ...standIns(audit, prompt, at), at };
  // What this prompt's calls use, kept whether or not it goes on to report: see the scan runner.
  const used = usageTally();
  const keepUsage = async () => {
    try {
      await store.recordUsage({ audit_id: auditId }, used.take());
    } catch (error) {
      console.error(`Audit ${auditId} prompt ${promptIndex} could not record what it used`, error);
    }
  };
  try {
    const cells = await Promise.all(
      surfaces.map(async (surface) => {
        const provider = providers[surface];
        if (!provider) throw new Error(`No provider for ${surface}`);
        // The same question, asked again: answers differ from one time to the next, and the
        // spread is what the report shows.
        const findings = await Promise.all(
          Array.from({ length: audit.samples }, async () =>
            analyzeObservation(
              await provider.observe({ ...input, onUsage: used.on(surface) }),
              input.location,
            ),
          ),
        );
        return buildAuditCell(surface, findings, deps.weights, audit.website);
      }),
    );
    // The website is checked once per audit, alongside the first prompt. A page that cannot be
    // fetched is a finding, not a failure, so this never throws.
    const site =
      promptIndex === 0 && audit.website && deps.inspectSite
        ? analyzeSite(
            await deps.inspectSite(audit.website).catch(
              (): SiteSnapshot => ({
                url: audit.website ?? "",
                status: null,
                html: null,
                robots_txt: null,
                noindex_header: false,
              }),
            ),
            { name: audit.business_name, city: audit.city },
          )
        : null;
    await keepUsage();
    await store.recordAuditPart(auditId, promptIndex, site ? { cells, site } : { cells });
    return "done";
  } catch (error) {
    await keepUsage();
    await store.failAudit(auditId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
