import {
  FOUND_ANSWER_LABELS,
  FOUND_ANSWERS,
  FOUND_ASSISTANT_LABELS,
  FOUND_MONTHS_SHOWN,
  type FoundAnswer,
  type LocationFoundAnswers,
} from "@nearcited/shared";

/**
 * What customers said for "How did you find us?" on the way from a review request to the review
 * form (issue #148), as a location's page shows it. Kept apart from the visits from assistants and
 * never added to them; nothing is worked out from it.
 */

export const foundAnswersKey = (locationId: string) => ["found-answers", locationId];

/** One answer over the months shown, and for an assistant, which ones customers named. */
export interface FoundAnswerRow {
  answer: FoundAnswer;
  label: string;
  count: number;
  /** For an assistant answer, by assistant, the most first, and those who did not say last. */
  assistants: { name: string; count: number }[];
}

/** A location's found answers as its page lays them out. */
export interface FoundShown {
  /** How many answered, skips left out. */
  answered: number;
  skipped: number;
  /** By answer, the most first, and the skipped last. */
  answers: FoundAnswerRow[];
  /** By month, the newest first. */
  months: { month: string; label: string; answered: number; skipped: number }[];
}

const DIDNT_SAY = "Didn't say which";

const monthLabel = (month: string) =>
  new Date(`${month}-01T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** Adds a location's found answers up the two ways its page shows them. */
export function foundShown(found: LocationFoundAnswers): FoundShown {
  const byAnswer = new Map<FoundAnswer, number>();
  const byAssistant = new Map<string, number>();
  const byMonth = new Map<string, { answered: number; skipped: number }>();
  for (const { month, answer, assistant, count } of found.months) {
    byAnswer.set(answer, (byAnswer.get(answer) ?? 0) + count);
    if (answer === "assistant") {
      const name = assistant === null ? DIDNT_SAY : FOUND_ASSISTANT_LABELS[assistant];
      byAssistant.set(name, (byAssistant.get(name) ?? 0) + count);
    }
    const kept = byMonth.get(month) ?? { answered: 0, skipped: 0 };
    if (answer === "skipped") kept.skipped += count;
    else kept.answered += count;
    byMonth.set(month, kept);
  }
  const assistants = [...byAssistant]
    .map(([name, count]) => ({ name, count }))
    .sort(
      (a, b) =>
        Number(a.name === DIDNT_SAY) - Number(b.name === DIDNT_SAY) ||
        b.count - a.count ||
        a.name.localeCompare(b.name),
    );
  const order = (answer: FoundAnswer) => FOUND_ANSWERS.indexOf(answer);
  const answers = [...byAnswer]
    .map(([answer, count]) => ({
      answer,
      label: FOUND_ANSWER_LABELS[answer],
      count,
      assistants: answer === "assistant" ? assistants : [],
    }))
    .sort(
      (a, b) =>
        Number(a.answer === "skipped") - Number(b.answer === "skipped") ||
        b.count - a.count ||
        order(a.answer) - order(b.answer),
    );
  const skipped = byAnswer.get("skipped") ?? 0;
  return {
    answered: answers.reduce((sum, row) => sum + row.count, 0) - skipped,
    skipped,
    answers,
    months: [...byMonth]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([month, counts]) => ({ month, label: monthLabel(month), ...counts })),
  };
}

/** Shown where the location asks for reviews, and kept where something was counted. */
export const foundVisible = (reviewRequestsOn: boolean, counted: number): boolean =>
  reviewRequestsOn || counted > 0;

const customersOf = (count: number) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? "customer" : "customers"}`;

export const FOUND_WORDS = {
  heading: "How customers say they found you",
  none: `Nobody who followed a review request has answered "How did you find us?" in the last ${FOUND_MONTHS_SHOWN} months.`,
  some: (answered: number) =>
    `${customersOf(answered)} who followed a review request answered "How did you find us?" in the last ${FOUND_MONTHS_SHOWN} months.`,
  tapped:
    "This is what customers tapped on the way from a review request to the review form, whether they then wrote a review or not.",
  anyone:
    "Anyone holding a request's link could tap anything, so take it as what customers say, not as a measure.",
  sample: "These answers are made up, as sample data: no customer was asked.",
  apart:
    "It is kept apart from the visits from assistants and never added to the visits: a customer counted here may also be one of them.",
};
