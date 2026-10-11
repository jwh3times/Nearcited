import type { NamedCount, Recommendation, SourceKind, SourceSummary, Task } from "./schemas";
import { sourceKind } from "./source-kinds";
import { type SourcedAnswer, summarizeSources } from "./sources";

/**
 * Tasks: the work that follows from a source, and what the scans showed before and after it.
 *
 * A task stands on a `source:<host>` recommendation, so the sites are the ones the rule chose.
 * What it asks depends on the kind of site. Everything here is composed by rule from counts the
 * product holds. Nothing says the work caused a change: the counts are set side by side and the
 * reader draws the conclusion.
 */

const SOURCE_RULE = "source:";
/** Tasks whose rule stopped firing are kept in view while they are few, newest first. */
const MAX_CLOSED_TASKS = 3;
/** Fewer answers than this since the work was done say too little to compare. */
export const MIN_ANSWERS_SINCE = 2;
/** How far back the scans since are read. More than a year of weekly scans. */
export const MAX_SCANS_SINCE = 60;

/** The answers that cited a site before the work was done, and since. */
export interface TaskEvidence {
  before: readonly SourcedAnswer[];
  since: readonly SourcedAnswer[];
}

export interface TaskInput {
  /** The business the tasks are for. */
  name: string;
  recommendations: readonly Recommendation[];
  /** Every site the answers in the scan window cited. */
  sources: readonly SourceSummary[];
  /** How many answers `sources` is counted over. */
  answers: number;
  /** By recommendation ID, for each one a member has marked. */
  evidence: ReadonlyMap<string, TaskEvidence>;
}

/** The host a recommendation is about, or null when its rule is not about a source. */
export function sourceOfRule(rule: string): string | null {
  return rule.startsWith(SOURCE_RULE) ? rule.slice(SOURCE_RULE.length) || null : null;
}

/** Of the answers that cited `host`, how many named the business. */
export function namedCount(answers: readonly SourcedAnswer[], host: string): NamedCount {
  const site = summarizeSources(answers, null, Number.POSITIVE_INFINITY).find(
    (source) => source.host === host,
  );
  return { answers: site?.answers ?? 0, named: site?.named ?? 0 };
}

const WORK: Record<SourceKind, { title: (host: string) => string; detail: string }> = {
  reviews: {
    title: (host) => `Ask your customers for reviews on ${host}`,
    detail:
      "This site ranks businesses by what their customers say, and lets a business ask for reviews. Check that the business is on it under the same name and city, then ask recent customers to leave one. Ask all of them, not only the happy ones, and offer nothing in return.",
  },
  reviews_unasked: {
    title: (host) => `Claim and complete your listing on ${host}`,
    detail:
      "This site does not allow a business to ask for reviews, so do not. Claim the listing, fill in every field, and answer the reviews it already has.",
  },
  directory: {
    title: (host) => `Check your listing on ${host}`,
    detail:
      "Claim the listing if you have not, or add the business if it is missing. Make the name, address, phone and hours match your website exactly.",
  },
  editorial: {
    title: (host) => `Ask to be included on ${host}`,
    detail:
      "This is a page somebody wrote, not a listing you can claim. A short note to its author saying what the business does and where may get it added. It is a long shot, so do the other tasks first.",
  },
  unknown: {
    title: (host) => `See whether you can be listed on ${host}`,
    detail:
      "We do not know what kind of site this is. Open the page that was read. If it is a directory or a review site, check that the business is on it under the same name and city. If it is an article, or another business's own site, there may be nothing to do.",
  },
};

function summaryOf(
  host: string,
  name: string,
  open: boolean,
  source: SourceSummary | undefined,
  answers: number,
): string {
  if (open && source) {
    return `${host} was cited in ${source.answers} of ${answers} answers, and none of them named ${name}.`;
  }
  if (source && source.named > 0) {
    return `${source.named} of the ${source.answers} ${source.answers === 1 ? "answer" : "answers"} that cited ${host} in the latest scans named ${name}.`;
  }
  return `${host} is no longer one of the sites read most for answers that leave ${name} out.`;
}

/**
 * The tasks to show: one for each source the rule fires for now, most cited first, then the few
 * most recently done whose rule has since stopped firing. A dismissed recommendation has none.
 */
export function buildTasks(input: TaskInput): Task[] {
  const tasks: Task[] = [];
  for (const recommendation of input.recommendations) {
    const host = sourceOfRule(recommendation.rule);
    if (!host || recommendation.status === "dismissed") continue;
    const open = recommendation.status === "open";
    if (!open && !recommendation.acted_at) continue;

    const source = input.sources.find((candidate) => candidate.host === host);
    const kind = sourceKind(host);
    const evidence = recommendation.acted_at ? input.evidence.get(recommendation.id) : undefined;
    tasks.push({
      id: recommendation.id,
      host,
      kind,
      title: WORK[kind].title(host),
      summary: summaryOf(host, input.name, open, source, input.answers),
      detail: WORK[kind].detail,
      url: source?.urls[0] ?? null,
      open,
      acted_at: recommendation.acted_at,
      before: evidence ? namedCount(evidence.before, host) : null,
      since: evidence ? namedCount(evidence.since, host) : null,
    });
  }

  const cited = (task: Task) =>
    input.sources.find((source) => source.host === task.host)?.answers ?? 0;
  const current = tasks
    .filter((task) => task.open)
    .sort((a, b) => cited(b) - cited(a) || a.host.localeCompare(b.host));
  const closed = tasks
    .filter((task) => !task.open)
    .sort((a, b) => Date.parse(b.acted_at ?? "") - Date.parse(a.acted_at ?? ""))
    .slice(0, MAX_CLOSED_TASKS);
  return [...current, ...closed];
}
