import {
  type AuditJob,
  analyzeObservation,
  buildAuditCell,
  type Location,
  type ScoreWeights,
  SURFACES_BY_KIND,
  type TrackedQuery,
} from "@nearcited/shared";
import type { ProviderRegistry } from "../providers";
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
    scan_frequency: "off",
    last_scanned_at: null,
    created_at: at.toISOString(),
  };
  const query: TrackedQuery = {
    id: NIL,
    location_id: audit.id,
    kind: "ai_prompt",
    text: prompt,
    is_active: true,
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
  try {
    const cells = await Promise.all(
      surfaces.map(async (surface) => {
        const provider = providers[surface];
        if (!provider) throw new Error(`No provider for ${surface}`);
        // The same question, asked again: answers differ from one time to the next, and the
        // spread is what the report shows.
        const findings = await Promise.all(
          Array.from({ length: audit.samples }, async () =>
            analyzeObservation(await provider.observe(input), input.location),
          ),
        );
        return buildAuditCell(surface, findings, deps.weights, audit.website);
      }),
    );
    await store.recordAuditPart(auditId, promptIndex, { cells });
    return "done";
  } catch (error) {
    await store.failAudit(auditId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
