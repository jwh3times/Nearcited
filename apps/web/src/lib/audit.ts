import {
  type NameCount,
  type PublicAudit,
  SURFACES,
  type Surface,
  tallyNames,
} from "@nearcited/shared";

/** How long a report may sit unfinished before the page stops waiting for the rest of it. */
export const AUDIT_WAIT_MS = 20 * 60 * 1000;

/** The assistants the report covers, in the product's usual order. */
export function auditSurfaces(audit: PublicAudit): Surface[] {
  const seen = new Set(
    audit.prompts.flatMap((prompt) => (prompt.cells ?? []).map((cell) => cell.surface)),
  );
  return SURFACES.filter((surface) => seen.has(surface));
}

/** How many answers the report is built from so far. */
export function auditAnswers(audit: PublicAudit): number {
  return audit.prompts.reduce(
    (sum, prompt) => sum + (prompt.cells ?? []).reduce((inner, cell) => inner + cell.checks, 0),
    0,
  );
}

/** Who else was named across the whole report, most often first, spellings of one counted together. */
export function auditCompetitors(audit: PublicAudit, limit = 8): NameCount[] {
  return tallyNames(
    audit.prompts.flatMap((prompt) => (prompt.cells ?? []).flatMap((cell) => cell.competitors)),
    limit,
  );
}

/**
 * Whether the page should keep asking for the rest of the report. A prompt whose checks failed
 * for good never reports, so the page gives up waiting after a while and shows what there is.
 */
export function auditPending(audit: PublicAudit, now: Date): boolean {
  return (
    audit.status === "queued" &&
    now.getTime() - new Date(audit.created_at).getTime() < AUDIT_WAIT_MS
  );
}
