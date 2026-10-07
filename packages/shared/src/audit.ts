import { z } from "zod";
import type { Finding } from "./analysis";
import { SourceSummarySchema, type Surface, SurfaceSchema } from "./schemas";
import { positionWeight } from "./scoring";
import { mergeSources, summarizeSources } from "./sources";
import { defaultTuning, type ScoreWeights } from "./tuning";

/**
 * A shareable audit: a one-off report for a business that has not signed up. Each prompt is asked
 * several times on each assistant in one go, because a prospect cannot wait for a window of daily
 * scans to fill.
 */

const Timestamp = z.string().min(1);

/** One prompt on one assistant, over every time it was asked. */
export const AuditCellSchema = z.object({
  surface: SurfaceSchema,
  checks: z.number().int().positive(),
  mentions: z.number().int().nonnegative(),
  /** Where the business ranked each time it was named with a rank, in the order asked. */
  positions: z.array(z.number().int().positive()),
  /** The sum of each check's score weight. Kept so a reader's page never needs the weights. */
  weight: z.number().nonnegative(),
  /** Who else was named, most often first. */
  competitors: z.array(z.object({ name: z.string(), count: z.number().int().positive() })),
  /** A quote from one answer: one that names the business when any did. */
  excerpt: z.string().nullable(),
  /** The pages that answer cited. Shown with the quote, as the providers' terms require. */
  cited_urls: z.array(z.string()),
  /** The sites every answer cited, not only the quoted one. Absent from audits made before it. */
  sources: z.array(SourceSummarySchema).default([]),
});
export type AuditCell = z.infer<typeof AuditCellSchema>;

/** One prompt's results across the assistants. Stored as each prompt finishes. */
export const AuditPartSchema = z.object({
  cells: z.array(AuditCellSchema),
});
export type AuditPart = z.infer<typeof AuditPartSchema>;

export const AuditStatusSchema = z.enum(["queued", "ready", "failed"]);

/** An audit as the worker reads it to run a prompt. */
export const AuditJobSchema = z.object({
  id: z.uuid(),
  business_name: z.string(),
  website: z.string().nullable(),
  city: z.string(),
  region: z.string().nullable(),
  country_code: z.string(),
  prompts: z.array(z.string()),
  samples: z.number().int().positive(),
  status: AuditStatusSchema,
  revoked_at: Timestamp.nullable(),
});
export type AuditJob = z.infer<typeof AuditJobSchema>;

/** What the database returns for a token. `parts` is keyed by the prompt's position. */
export const StoredAuditSchema = z.object({
  business_name: z.string(),
  website: z.string().nullable(),
  city: z.string(),
  region: z.string().nullable(),
  prompts: z.array(z.string()),
  samples: z.number().int().positive(),
  status: AuditStatusSchema,
  parts: z.record(z.string(), AuditPartSchema),
  created_at: Timestamp,
  expires_at: Timestamp,
});
export type StoredAudit = z.infer<typeof StoredAuditSchema>;

/** The audit as the public page receives it. */
export const PublicAuditSchema = z.object({
  business_name: z.string(),
  website: z.string().nullable(),
  city: z.string(),
  region: z.string().nullable(),
  status: AuditStatusSchema,
  samples: z.number().int().positive(),
  /** 0 to 100 over the prompts answered so far. Null until one has been. */
  score: z.number().nullable(),
  /** In the order they were asked. `cells` is null while that prompt is still being checked. */
  prompts: z.array(z.object({ text: z.string(), cells: z.array(AuditCellSchema).nullable() })),
  /** The sites the answers cited across the whole report, most cited first. */
  sources: z.array(SourceSummarySchema),
  created_at: Timestamp,
  expires_at: Timestamp,
});
export type PublicAudit = z.infer<typeof PublicAuditSchema>;

const MAX_COMPETITORS = 8;

/** Folds every answer one assistant gave to one prompt into a cell. */
export function buildAuditCell(
  surface: Surface,
  findings: readonly Finding[],
  weights: ScoreWeights = defaultTuning.score,
  website: string | null = null,
): AuditCell {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    for (const name of finding.competitors) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  // Quote an answer that names the business when one did; it is the one a reader wants to see.
  const quoted =
    findings.find((finding) => finding.mentioned && finding.answer_excerpt) ??
    findings.find((finding) => finding.answer_excerpt) ??
    null;

  return {
    surface,
    checks: findings.length,
    mentions: findings.filter((finding) => finding.mentioned).length,
    positions: findings.flatMap((finding) =>
      finding.mentioned && finding.position !== null ? [finding.position] : [],
    ),
    weight: findings.reduce(
      (sum, finding) => sum + (finding.mentioned ? positionWeight(finding.position, weights) : 0),
      0,
    ),
    competitors: [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, MAX_COMPETITORS),
    excerpt: quoted?.answer_excerpt ?? null,
    cited_urls: quoted?.cited_urls ?? [],
    sources: summarizeSources(findings, website),
  };
}

/**
 * 0 to 100, one decimal: each cell averaged over its own checks, then the cells averaged. The
 * same rule the scan window uses, so an audit and a week of scans mean the same thing.
 */
export function auditScore(parts: readonly AuditPart[]): number | null {
  const cells = parts.flatMap((part) => part.cells).filter((cell) => cell.checks > 0);
  if (cells.length === 0) return null;
  const mean = cells.reduce((sum, cell) => sum + cell.weight / cell.checks, 0) / cells.length;
  return Math.round(mean * 1000) / 10;
}

/** Turns the stored audit into what the page shows. */
export function toPublicAudit(stored: StoredAudit): PublicAudit {
  const prompts = stored.prompts.map((text, index) => ({
    text,
    cells: stored.parts[String(index)]?.cells ?? null,
  }));
  return {
    business_name: stored.business_name,
    website: stored.website,
    city: stored.city,
    region: stored.region,
    status: stored.status,
    samples: stored.samples,
    score: auditScore(prompts.flatMap((prompt) => (prompt.cells ? [{ cells: prompt.cells }] : []))),
    prompts,
    sources: mergeSources(
      prompts.flatMap((prompt) => (prompt.cells ?? []).map((cell) => cell.sources)),
    ),
    created_at: stored.created_at,
    expires_at: stored.expires_at,
  };
}
