import { MIN_ANSWERS_SINCE, type NamedCount, type SourceKind, type Task } from "@nearcited/shared";

/** The few words that say what kind of site a task is about. */
export const KIND_LABELS: Record<SourceKind, string> = {
  reviews: "Review site",
  reviews_unasked: "Review site",
  directory: "Directory",
  editorial: "Article",
  unknown: "Kind not known",
};

const answers = (count: number) => (count === 1 ? "1 answer" : `${count} answers`);
const named = ({ named, answers: of }: NamedCount) =>
  `named in ${named} of the ${answers(of)} that cited it`;

/**
 * What the scans saw before a task was marked done, and since. Null until it is marked. The two
 * are set side by side and nothing more: neither line says the work caused anything.
 */
export function proof(task: Pick<Task, "before" | "since">): {
  before: string;
  since: string;
} | null {
  if (!task.before || !task.since) return null;
  return {
    before:
      task.before.answers === 0
        ? "Before: no answer in the scans before had cited it."
        : `Before: ${named(task.before)}.`,
    since:
      task.since.answers < MIN_ANSWERS_SINCE
        ? `Since: too early to say. ${task.since.answers === 0 ? "No answer has" : "Only 1 answer has"} cited it yet.`
        : `Since: ${named(task.since)}.`,
  };
}

/**
 * Who says a task is done, and since when. An action that did the work says so itself, and
 * that mark is not a member's to take back.
 */
export const markedDone = (task: Pick<Task, "acted_by_action">, day: string): string =>
  task.acted_by_action ? `Done by Nearcited on ${day}.` : `Marked done ${day}.`;
