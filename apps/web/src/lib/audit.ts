import { type PublicAudit, SURFACES, type Surface } from "@nearcited/shared";
import { businessKey } from "./format";

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

/** Who else was named across the whole report, most often first. */
export function auditCompetitors(audit: PublicAudit, limit = 8): { name: string; count: number }[] {
  // "Tony's" and "Tony's, LLC" are one business. Count them together under the shorter name.
  const counts = new Map<string, { name: string; count: number }>();
  for (const prompt of audit.prompts) {
    for (const cell of prompt.cells ?? []) {
      for (const { name, count } of cell.competitors) {
        const key = businessKey(name);
        const entry = counts.get(key);
        if (!entry) counts.set(key, { name, count });
        else {
          entry.count += count;
          if (name.length < entry.name.length) entry.name = name;
        }
      }
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
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
