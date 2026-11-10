import { hashOf } from "./fetches";
import {
  FOUND_ANSWERS,
  FOUND_ASSISTANTS,
  type FoundAnswer,
  type FoundAssistant,
  type FoundGiven,
} from "./schemas";
import { VISIT_ASSISTANT_LABELS } from "./visits";

/**
 * Found answers (issue #148,
 * `docs/adr/0033-a-found-answer-is-counted-on-the-way-to-the-review-form.md`): what a customer taps
 * for "How did you find us?" on the way from a review request to the review form. Counted for a
 * location by month and answer, never recorded, never added to the visits from assistants, and
 * nothing is worked out from them: anyone holding a link can tap anything.
 */

/** How many months of found answers a location's page shows, this one included. */
export const FOUND_MONTHS_SHOWN = 6;

/** Each answer as the question's page offers it, and as a location's page counts it. */
export const FOUND_ANSWER_LABELS: Record<FoundAnswer, string> = {
  assistant: "An AI assistant",
  search: "A search, like Google",
  someone_they_know: "Someone I know",
  been_before: "I've been before",
  something_else: "Something else",
  skipped: "Skipped the question",
};

/** Each assistant a customer may name, as the page offers it. */
export const FOUND_ASSISTANT_LABELS: Record<FoundAssistant, string> = {
  ...VISIT_ASSISTANT_LABELS,
  other: "Another one",
};

/** What one tap on the question's page posts: the answer, and for an assistant, `:` and which. */
export const tapValue = ({ answer, assistant }: FoundGiven): string =>
  assistant === null ? answer : `${answer}:${assistant}`;

const isAnswer = (value: string): value is FoundAnswer =>
  (FOUND_ANSWERS as readonly string[]).includes(value);
const isAssistant = (value: string): value is FoundAssistant =>
  (FOUND_ASSISTANTS as readonly string[]).includes(value);

/**
 * What a tap posted, as it is counted. Anything that is not one of the page's own values is the way
 * past the question: whatever was tapped, the customer goes on to the review form.
 */
export function readTap(value: unknown): FoundGiven {
  const [answer = "", assistant, ...rest] = typeof value === "string" ? value.split(":") : [];
  if (!isAnswer(answer) || rest.length > 0) return { answer: "skipped", assistant: null };
  if (assistant === undefined) return { answer, assistant: null };
  return answer === "assistant" && isAssistant(assistant)
    ? { answer, assistant }
    : { answer: "skipped", assistant: null };
}

/**
 * The answer made up for a review request that went to nobody, on sample data or for a test
 * organization: the same for the same request, so its location's page shows the block working.
 */
export function sampleFoundAnswer(actionId: string): FoundGiven {
  const answer = FOUND_ANSWERS[hashOf(`found|${actionId}`) % FOUND_ANSWERS.length] ?? "skipped";
  if (answer !== "assistant") return { answer, assistant: null };
  // One in seven says no more than "an assistant".
  const pick = hashOf(`found assistant|${actionId}`) % (FOUND_ASSISTANTS.length + 1);
  return { answer, assistant: FOUND_ASSISTANTS[pick] ?? null };
}
