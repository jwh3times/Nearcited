import type { Action, LocationActions } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import {
  actionState,
  actionsQuery,
  actionText,
  hasActions,
  whatItReplaced,
  writtenBy,
} from "../src/lib/actions";

const action = (extra: Partial<Action> = {}): Action => ({
  id: "ac000000-0000-4000-8000-000000000001",
  location_id: "10000000-0000-4000-8000-000000000001",
  kind: "sample",
  connection_id: "c0000000-0000-4000-8000-000000000001",
  summary: "Set the opening line of Sample listing: Riverside",
  seen: { text: null },
  seen_dropped_at: null,
  proposed_text: "Joe's Pizza in Raleigh: open every day.",
  written_by: "rule",
  status: "proposed",
  proposed_at: "2026-10-12T09:00:00.000Z",
  lapses_at: "2026-10-26T09:00:00.000Z",
  approved_by_email: null,
  approved_at: null,
  approved_text: null,
  declined_by_email: null,
  declined_at: null,
  decline_reason: null,
  done_at: null,
  failed_at: null,
  failure: null,
  lapsed_at: null,
  lapse_reason: null,
  retry_of: null,
  ...extra,
});
const day = (iso: string) => iso.slice(0, 10);
const found = (extra: Partial<LocationActions> = {}): LocationActions => ({
  waiting: [],
  record: [],
  held: false,
  ...extra,
});

describe("hasActions", () => {
  it("is false until it is known, and for a location nothing was ever proposed for", () => {
    expect(hasActions(undefined)).toBe(false);
    expect(hasActions(found())).toBe(false);
    expect(hasActions(found({ waiting: [action()] }))).toBe(true);
    expect(hasActions(found({ record: [action({ status: "declined" })] }))).toBe(true);
  });
});

describe("actionsQuery", () => {
  const interval = (record: Action[]) =>
    actionsQuery("10000000-0000-4000-8000-000000000001").refetchInterval({
      state: { data: found({ record }) },
    });

  it("asks again while the worker is carrying one out, and not otherwise", () => {
    expect(interval([action({ status: "done" })])).toBe(false);
    expect(interval([action({ status: "approved" })])).toBe(2000);
    expect(
      actionsQuery("10000000-0000-4000-8000-000000000001").refetchInterval({ state: {} }),
    ).toBe(false);
  });
});

describe("actionText and writtenBy", () => {
  it("is what was approved, which is the proposal unless a member changed it", () => {
    expect(actionText(action())).toBe("Joe's Pizza in Raleigh: open every day.");
    expect(actionText(action({ approved_text: "Open late on Fridays." }))).toBe(
      "Open late on Fridays.",
    );
    expect(actionText(action({ proposed_text: null }))).toBeNull();
  });

  it("says whether a rule or a model wrote it", () => {
    expect(writtenBy(action())).toBe("Composed by rule from this location's details");
    expect(writtenBy(action({ written_by: "model" }))).toBe("Written by a model");
  });
});

describe("actionState", () => {
  const approved = {
    approved_by_email: "owner@example.com",
    approved_at: "2026-10-13T09:00:00.000Z",
  };

  it("says how long one waits", () => {
    expect(actionState(action(), day)).toBe("Waiting for a yes until 2026-10-26.");
  });

  it("says who approved it, whether they changed it, and what became of it", () => {
    expect(actionState(action({ status: "approved", ...approved }), day)).toBe(
      "Approved by owner@example.com. Being carried out.",
    );
    expect(
      actionState(
        action({ status: "done", done_at: "2026-10-13T09:01:00.000Z", ...approved }),
        day,
      ),
    ).toBe("Done on 2026-10-13. Approved by owner@example.com.");
    expect(
      actionState(
        action({
          status: "done",
          done_at: "2026-10-13T09:01:00.000Z",
          ...approved,
          approved_text: "Changed",
        }),
        day,
      ),
    ).toBe("Done on 2026-10-13. Approved by owner@example.com, who changed the text.");
    expect(
      actionState(
        action({
          status: "failed",
          failed_at: "2026-10-13T10:00:00.000Z",
          failure: "The outside service is down.",
          ...approved,
        }),
        day,
      ),
    ).toBe("Failed on 2026-10-13: The outside service is down. Approved by owner@example.com.");
  });

  it("says who declined it and why, when they said", () => {
    const declined = {
      status: "declined" as const,
      declined_by_email: "owner@example.com",
      declined_at: "2026-10-13T09:00:00.000Z",
    };
    expect(actionState(action(declined), day)).toBe("Declined by owner@example.com on 2026-10-13.");
    expect(actionState(action({ ...declined, decline_reason: "We close on Mondays." }), day)).toBe(
      "Declined by owner@example.com on 2026-10-13: We close on Mondays.",
    );
  });

  it("tells the two ways of lapsing apart", () => {
    expect(
      actionState(
        action({
          status: "lapsed",
          lapse_reason: "expired",
          lapsed_at: "2026-10-26T09:00:00.000Z",
        }),
        day,
      ),
    ).toBe("Lapsed on 2026-10-26: nobody answered in fourteen days.");
    expect(
      actionState(action({ status: "lapsed", lapse_reason: "out_of_date", ...approved }), day),
    ).toBe(
      "Not done: what it would have replaced had changed since it was proposed. Approved by owner@example.com.",
    );
  });
});

describe("whatItReplaced", () => {
  it("is what was there, or that nothing was", () => {
    expect(whatItReplaced(action({ seen: { text: "The old line" } }), day)).toBe("The old line");
    expect(whatItReplaced(action({ seen: { text: null } }), day)).toBe("Nothing");
  });

  it("is nothing to show for an action that read nothing", () => {
    expect(whatItReplaced(action({ seen: null }), day)).toBeNull();
  });

  it("says when it was dropped, once it could be kept no longer", () => {
    expect(
      whatItReplaced(action({ seen: null, seen_dropped_at: "2026-11-11T09:00:00.000Z" }), day),
    ).toBe("No longer kept. It was dropped on 2026-11-11.");
  });
});

describe("actionState for an action that was out of date", () => {
  const lapsed = (extra: Partial<Action>) =>
    actionState(
      action({
        status: "lapsed",
        lapse_reason: "out_of_date",
        lapsed_at: "2026-10-20T09:00:00.000Z",
        ...extra,
      }),
      day,
    );

  it("says the thing had changed, and who had approved it", () => {
    expect(lapsed({ approved_by_email: "alice@example.com", approved_at: "2026-10-13" })).toBe(
      "Not done: what it would have replaced had changed since it was proposed. Approved by alice@example.com.",
    );
  });

  it("still says so when what it replaced was dropped long afterwards", () => {
    expect(
      lapsed({
        approved_by_email: "alice@example.com",
        approved_at: "2026-10-13",
        seen: null,
        seen_dropped_at: "2026-11-11T09:00:00.000Z",
      }),
    ).toContain("had changed since it was proposed");
  });

  it("says it could not be checked when what it replaced was dropped first", () => {
    const dropped = { seen: null, seen_dropped_at: "2026-10-20T09:00:00.000Z" };
    // Nobody had answered: there is no approver to name.
    expect(lapsed(dropped)).toBe(
      "Not done: what it would have replaced could no longer be kept, so it could not be checked.",
    );
    expect(
      lapsed({ ...dropped, approved_by_email: "bob@example.com", approved_at: "2026-10-13" }),
    ).toBe(
      "Not done: what it would have replaced could no longer be kept, so it could not be checked. Approved by bob@example.com.",
    );
  });
});
