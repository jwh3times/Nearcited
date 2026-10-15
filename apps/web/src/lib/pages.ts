import { MIN_ANSWERS_SINCE, type PageTask, type PromptCount } from "@nearcited/shared";

const answers = (count: number) => (count === 1 ? "1 answer" : `${count} answers`);
const named = ({ named, answers: of }: PromptCount) => `named in ${named} of ${answers(of)}`;

/**
 * What the scans saw of a page's prompt before its task was marked done, and since: how many
 * answers to it named the business, and, once somebody said where the page is, how many since
 * cited it. Null until it is marked. Nothing here says the page caused anything.
 */
export function pageProof(task: Pick<PageTask, "before" | "since">): {
  before: string;
  since: string;
  cited: string | null;
} | null {
  const { before, since } = task;
  if (!before || !since) return null;
  const early = since.answers < MIN_ANSWERS_SINCE;
  return {
    before:
      before.answers === 0
        ? "Before: no answer to this prompt in the scans before."
        : `Before: ${named(before)} to this prompt.`,
    since: early
      ? `Since: too early to say. ${since.answers === 0 ? "No answer" : "Only 1 answer"} to it yet.`
      : `Since: ${named(since)}.`,
    cited:
      since.cited === null
        ? null
        : early
          ? null
          : `${since.cited} of the ${answers(since.answers)} since cited the page.`,
  };
}
