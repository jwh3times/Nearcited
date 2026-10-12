import { describe, expect, it } from "vitest";
import { detailsProof, detailsStatus } from "../src/lib/details";

const day = (iso: string) => iso.slice(0, 10);
const MARKED = "2026-10-05T09:00:00Z";

describe("detailsStatus", () => {
  it("says nothing until the block is marked as on the page", () => {
    expect(detailsStatus({ acted_at: null, checked_since: false }, true, day)).toBeNull();
  });

  it("says a scan has yet to look, while none has finished since the mark", () => {
    expect(detailsStatus({ acted_at: MARKED, checked_since: false }, true, day)).toBe(
      "Marked done 2026-10-05. The next scan will look for it.",
    );
  });

  it("says what the scan since found on the page, either way", () => {
    expect(detailsStatus({ acted_at: MARKED, checked_since: true }, true, day)).toBe(
      "Marked done 2026-10-05. The scan since did not find it on the page.",
    );
    expect(detailsStatus({ acted_at: MARKED, checked_since: true }, false, day)).toBe(
      "Marked done 2026-10-05. The scan since found it on the page.",
    );
  });

  it("claims nothing of a scan that has not happened", () => {
    expect(detailsStatus({ acted_at: MARKED, checked_since: false }, false, day)).toBe(
      "Marked done 2026-10-05.",
    );
  });
});

describe("detailsProof", () => {
  const count = (cited: number, answers: number) => ({ cited, answers });

  it("is nothing until the block is marked", () => {
    expect(detailsProof({ before: null, since: null })).toBeNull();
  });

  it("sets what the answers did before beside what they have done since", () => {
    expect(detailsProof({ before: count(0, 12), since: count(2, 9) })).toEqual({
      before: "Before: 0 of 12 answers cited your website.",
      since: "Since: 2 of 9 answers cited your website.",
    });
  });

  it("says it is too early while fewer than two answers have come in since", () => {
    expect(detailsProof({ before: count(1, 6), since: count(0, 0) })?.since).toBe(
      "Since: too early to say. No answer has come in yet.",
    );
    expect(detailsProof({ before: count(1, 6), since: count(1, 1) })?.since).toBe(
      "Since: too early to say. Only 1 answer has come in yet.",
    );
  });

  it("says so when there was nothing before to compare with", () => {
    expect(detailsProof({ before: count(0, 0), since: count(1, 4) })?.before).toBe(
      "Before: no answer had come in yet.",
    );
    expect(detailsProof({ before: count(1, 1), since: count(1, 4) })?.before).toBe(
      "Before: 1 of 1 answer cited your website.",
    );
  });
});
