import type { Draft, DraftsStanding, Task } from "@nearcited/shared";

/** How often the page asks again while the worker is writing a draft. */
export const WRITING_MS = 2000;

/** Whether any task's draft is being written, so the page should ask again shortly. */
export const draftsBeingWritten = (tasks: readonly Pick<Task, "draft">[] | undefined): boolean =>
  tasks?.some((task) => task.draft?.status === "asked") ?? false;

/** Whether the month's drafts are all used. False for a plan that includes none. */
export const draftsUsedUp = ({ allowed, used }: DraftsStanding): boolean =>
  allowed !== null && used >= allowed;

/** "7 of 10 left this month", for a plan that includes drafts. */
export function draftsLeft({ allowed, used }: DraftsStanding): string | null {
  if (allowed === null) return null;
  return `${Math.max(allowed - used, 0)} of ${allowed} left this month`;
}

const day = new Intl.DateTimeFormat(undefined, {
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/** What the page says in place of the button once the month is used: when more come. */
export const usedUpLine = ({ resets_on }: DraftsStanding): string =>
  `This month's drafts are used. More on ${day.format(new Date(`${resets_on}T00:00:00Z`))}.`;

/**
 * Who wrote a draft, which is said beside every one. Sample text is generated to show where a
 * draft goes, and no model wrote it, so it is never called a model's.
 */
export const draftLabel = (draft: Pick<Draft, "sample_data">): string =>
  draft.sample_data
    ? "Sample text. No model wrote this: it shows where a draft goes."
    : "Written by a model. Read it before you use it, and change what is not right.";

/**
 * What a task's card offers for its draft:
 *
 *   nothing  no draft can be asked for here: the task has none, the plan includes none, or the
 *            reader cannot ask
 *   writing  the worker is on it
 *   used_up  the month has no more
 *   again    a draft is there and another can be written in its place
 *   write    none yet
 */
export type DraftOffer = "nothing" | "writing" | "used_up" | "again" | "write";

export function draftOffer(
  task: Pick<Task, "draft" | "draft_kind">,
  standing: DraftsStanding,
  readOnly: boolean,
): DraftOffer {
  if (task.draft?.status === "asked") return "writing";
  if (readOnly || task.draft_kind === null || standing.allowed === null) return "nothing";
  if (draftsUsedUp(standing)) return "used_up";
  return task.draft?.text ? "again" : "write";
}

/**
 * Whether the line saying the plan includes no drafts belongs above the tasks: only where a draft
 * could be written if it did, and only once some plan offers them, so nobody is pointed at a
 * price list that has none.
 */
export function plansLineBelongs(
  tasks: readonly Pick<Task, "draft_kind">[],
  standing: DraftsStanding,
  readOnly: boolean,
): boolean {
  return !readOnly && standing.allowed === null && tasks.some((task) => task.draft_kind !== null);
}
