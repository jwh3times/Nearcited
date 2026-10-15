import { describe, expect, it } from "vitest";
import { pageProof } from "../src/lib/pages";

describe("what a page task says the scans saw", () => {
  it("is nothing until it is marked", () => {
    expect(pageProof({ before: null, since: null })).toBeNull();
  });

  it("sets the answers to its prompt before beside those since, and those citing the page", () => {
    expect(
      pageProof({
        before: { answers: 8, named: 0, cited: 0 },
        since: { answers: 4, named: 1, cited: 2 },
      }),
    ).toEqual({
      before: "Before: named in 0 of 8 answers to this prompt.",
      since: "Since: named in 1 of 4 answers.",
      cited: "2 of the 4 answers since cited the page.",
    });
  });

  it("says nothing of citations while nobody has said where the page is", () => {
    expect(
      pageProof({
        before: { answers: 0, named: 0, cited: null },
        since: { answers: 3, named: 0, cited: null },
      }),
    ).toEqual({
      before: "Before: no answer to this prompt in the scans before.",
      since: "Since: named in 0 of 3 answers.",
      cited: null,
    });
  });

  it("says it is too early while there are fewer than two answers since", () => {
    expect(
      pageProof({
        before: { answers: 1, named: 0, cited: 0 },
        since: { answers: 1, named: 1, cited: 1 },
      }),
    ).toEqual({
      before: "Before: named in 0 of 1 answer to this prompt.",
      since: "Since: too early to say. Only 1 answer to it yet.",
      cited: null,
    });
  });
});
