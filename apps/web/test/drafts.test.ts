import type { Draft, DraftsStanding } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import {
  draftLabel,
  draftOffer,
  draftsBeingWritten,
  draftsLeft,
  plansLineBelongs,
  usedUpLine,
} from "../src/lib/drafts";

const standing = (allowed: number | null, used = 0): DraftsStanding => ({
  allowed,
  used,
  resets_on: "2026-11-01",
});
const draft = (fields: Partial<Draft> = {}): Draft => ({
  id: "d0000000-0000-4000-8000-000000000001",
  location_id: "00000000-0000-4000-8000-0000000000aa",
  recommendation_id: "00000000-0000-4000-8000-0000000000bb",
  status: "written",
  asked_by_email: "joe@example.com",
  asked_at: "2026-10-06T00:00:00.000Z",
  failure: null,
  kind: "note",
  text: "Hello.",
  written_at: "2026-10-06T00:00:05.000Z",
  sample_data: false,
  ...fields,
});
const none = { draft: null, draft_kind: "note" as const };

describe("what a task's card offers for its draft", () => {
  it("is to write one where the plan has room and none is written", () => {
    expect(draftOffer(none, standing(5, 4), false)).toBe("write");
  });

  it("is to write it again where one is written, or the last ask wrote nothing new", () => {
    expect(draftOffer({ ...none, draft: draft() }, standing(5), false)).toBe("again");
    const failedAfter = draft({ status: "failed", failure: "It could not be written." });
    expect(draftOffer({ ...none, draft: failedAfter }, standing(5), false)).toBe("again");
    // A first ask that failed left nothing to write again: it is a first draft still.
    const failedFirst = draft({ status: "failed", text: null, kind: null, written_at: null });
    expect(draftOffer({ ...none, draft: failedFirst }, standing(5), false)).toBe("write");
  });

  it("is that one is being written, whoever is reading", () => {
    const asked = { ...none, draft: draft({ status: "asked", text: null }) };
    expect(draftOffer(asked, standing(5), false)).toBe("writing");
    expect(draftOffer(asked, standing(5), true)).toBe("writing");
    expect(draftsBeingWritten([none, asked])).toBe(true);
    expect(draftsBeingWritten([none, { draft: draft() }])).toBe(false);
    expect(draftsBeingWritten(undefined)).toBe(false);
  });

  it("is that the month is used, once it is", () => {
    expect(draftOffer(none, standing(5, 5), false)).toBe("used_up");
    expect(draftOffer({ ...none, draft: draft() }, standing(5, 6), false)).toBe("used_up");
  });

  it("is nothing for a task with no wording to write, a plan with none, or a reader who cannot ask", () => {
    expect(draftOffer({ draft: null, draft_kind: null }, standing(5), false)).toBe("nothing");
    expect(draftOffer(none, standing(null), false)).toBe("nothing");
    expect(draftOffer(none, standing(5), true)).toBe("nothing");
    // A draft already written is still there to read: only the asking is gone.
    expect(draftOffer({ draft: draft(), draft_kind: null }, standing(null), true)).toBe("nothing");
  });
});

describe("what the page says about the month", () => {
  it("counts what is left, and never below none", () => {
    expect(draftsLeft(standing(10, 3))).toBe("7 of 10 left this month");
    expect(draftsLeft(standing(10, 12))).toBe("0 of 10 left this month");
    expect(draftsLeft(standing(null))).toBeNull();
  });

  it("names the day more come, which is the first of next month wherever the reader is", () => {
    expect(usedUpLine(standing(5, 5))).toMatch(
      /^This month's drafts are used\. More on .*\b1\b.*\.$/,
    );
    expect(usedUpLine(standing(5, 5))).toMatch(/Nov/);
  });
});

describe("who wrote a draft", () => {
  it("is a model, said beside it", () => {
    expect(draftLabel(draft())).toMatch(/^Written by a model\./);
  });

  it("is nobody, for sample text, which is never called a model's", () => {
    const label = draftLabel(draft({ sample_data: true }));
    expect(label).toMatch(/^Sample text\./);
    expect(label).not.toMatch(/written by a model/i);
  });
});

describe("the line for a plan with no drafts", () => {
  const tasks = [{ draft_kind: null }, { draft_kind: "note" as const }];

  it("belongs where a draft could be written if the plan had them", () => {
    expect(plansLineBelongs(tasks, standing(null), false)).toBe(true);
  });

  it("does not where the plan has them, no task has one, or the reader cannot ask", () => {
    expect(plansLineBelongs(tasks, standing(5, 5), false)).toBe(false);
    expect(plansLineBelongs([{ draft_kind: null }], standing(null), false)).toBe(false);
    expect(plansLineBelongs(tasks, standing(null), true)).toBe(false);
  });
});
