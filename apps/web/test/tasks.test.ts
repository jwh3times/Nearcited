import { describe, expect, it } from "vitest";
import { proof } from "../src/lib/tasks";

describe("proof", () => {
  it("says nothing until the task is marked", () => {
    expect(proof({ before: null, since: null })).toBeNull();
  });

  it("sets the counts before beside the counts since", () => {
    expect(proof({ before: { answers: 6, named: 0 }, since: { answers: 4, named: 1 } })).toEqual({
      before: "Before: named in 0 of the 6 answers that cited it.",
      since: "Since: named in 1 of the 4 answers that cited it.",
    });
  });

  it("will not compare on fewer than two answers since", () => {
    const before = { answers: 1, named: 0 };
    expect(proof({ before, since: { answers: 0, named: 0 } })).toEqual({
      before: "Before: named in 0 of the 1 answer that cited it.",
      since: "Since: too early to say. No answer has cited it yet.",
    });
    expect(proof({ before, since: { answers: 1, named: 1 } })?.since).toBe(
      "Since: too early to say. Only 1 answer has cited it yet.",
    );
  });

  it("says so when nothing had cited the site before", () => {
    expect(
      proof({ before: { answers: 0, named: 0 }, since: { answers: 2, named: 0 } })?.before,
    ).toBe("Before: no answer in the scans before had cited it.");
  });
});
