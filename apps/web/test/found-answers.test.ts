import type { LocationFoundAnswers } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import { FOUND_WORDS, foundShown, foundVisible } from "../src/lib/found-answers";

/**
 * How a location's page shows what customers said for "How did you find us?" (issue #148): by
 * answer and by month over the months shown, assistants named apart, skips counted, and always
 * that it is what customers tapped, and never added to the visits.
 */

const months: LocationFoundAnswers["months"] = [
  { month: "2026-10", answer: "assistant", assistant: "chatgpt", count: 3 },
  { month: "2026-10", answer: "search", assistant: null, count: 4 },
  { month: "2026-10", answer: "skipped", assistant: null, count: 2 },
  { month: "2026-11", answer: "assistant", assistant: null, count: 1 },
  { month: "2026-11", answer: "assistant", assistant: "claude", count: 1 },
  { month: "2026-11", answer: "assistant", assistant: "chatgpt", count: 2 },
  { month: "2026-11", answer: "been_before", assistant: null, count: 5 },
];

describe("a location's found answers", () => {
  it("counts each answer over the months, assistants named apart, and skips last", () => {
    const shown = foundShown({ months, sample_data: false });
    expect(shown.answered).toBe(16);
    expect(shown.skipped).toBe(2);
    expect(shown.answers.map((row) => [row.label, row.count])).toEqual([
      ["An AI assistant", 7],
      ["I've been before", 5],
      ["A search, like Google", 4],
      ["Skipped the question", 2],
    ]);
    expect(shown.answers[0]?.assistants).toEqual([
      { name: "ChatGPT", count: 5 },
      { name: "Claude", count: 1 },
      { name: "Didn't say which", count: 1 },
    ]);
  });

  it("counts each month, the newest first, answered and skipped apart", () => {
    expect(foundShown({ months, sample_data: false }).months).toEqual([
      { month: "2026-11", label: "November 2026", answered: 9, skipped: 0 },
      { month: "2026-10", label: "October 2026", answered: 7, skipped: 2 },
    ]);
  });

  it("is shown where the location asks for reviews, or where something was counted", () => {
    expect(foundVisible(true, 0)).toBe(true);
    expect(foundVisible(false, 3)).toBe(true);
    expect(foundVisible(false, 0)).toBe(false);
  });

  it("says it is what customers tapped, that anyone could, and that it is not a visit", () => {
    expect(FOUND_WORDS.tapped).toMatch(/tapped/);
    expect(FOUND_WORDS.anyone).toMatch(/anyone/i);
    expect(FOUND_WORDS.apart).toMatch(/never added to the visits/);
  });
});
