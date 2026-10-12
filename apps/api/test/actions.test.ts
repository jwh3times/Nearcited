import {
  type ActionMessage,
  ActionSchema,
  type ConnectionMessage,
  ConnectionSchema,
  LocationActionsSchema,
  LocationSchema,
  OperatorOverviewSchema,
  OrganizationSchema,
  WaitingActionsSchema,
} from "@nearcited/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  carryOutAction,
  proposeAfterSync,
  requeueStalledActions,
  sampleOpeningLine,
} from "../src/actions";
import { sendActionNotices } from "../src/actions/notice";
import { createApp } from "../src/app";
import { syncConnection } from "../src/connections";
import { sealingKey } from "../src/connections/seal";
import type { Email } from "../src/email/report";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const carol = "c0000000-0000-4000-8000-000000000003";
const DAY = 86_400_000;

const SECRET = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

let db: MemoryDb;
let queued: (ActionMessage | ConnectionMessage)[];
let queueFails: boolean;
let env: Env;

/** In these tests the bearer token is simply the user's ID. */
const app = createApp({
  authenticate: async (request) => {
    const userId = request.headers.get("Authorization")?.replace("Bearer ", "");
    return userId
      ? { user: { id: userId, email: `${userId}@example.com` }, store: memoryStore(db, userId) }
      : null;
  },
  publicStore: () => memoryStore(db, "nobody"),
});

function call(user: string | null, method: string, path: string, body?: unknown) {
  return app.request(
    `/api${path}`,
    {
      method,
      headers: {
        ...(user ? { Authorization: `Bearer ${user}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

/** What the worker has: every row, and the key. */
const worker = async () => ({ store: memoryStore(db, null), key: await sealingKey(SECRET) });

/**
 * Alice's organization, with Bob in it as a member, a location, and a synced sample account the
 * location is matched to. The worker has then proposed what the sync showed could be done.
 */
async function matched() {
  const organization = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  db.memberships.push({ organization_id: organization.id, user_id: bob, role: "member" });
  db.emails.set(alice, "alice@example.com");
  db.emails.set(bob, "bob@example.com");
  const location = LocationSchema.parse(
    await (
      await call(alice, "POST", `/organizations/${organization.id}/locations`, {
        name: "Joe's Pizza",
        city: "Raleigh",
      })
    ).json(),
  );
  const connection = ConnectionSchema.parse(
    await (
      await call(alice, "POST", `/organizations/${organization.id}/connections`, {
        kind: "sample",
      })
    ).json(),
  );
  await syncConnection(connection.id, await worker());
  await call(alice, "PUT", `/connections/${connection.id}/locations/${location.id}`, {
    external_id: "sample-listing-2",
  });
  await syncConnection(connection.id, await worker());
  await proposeAfterSync(connection.id, await worker());
  queued = [];
  return { organization, location, connection };
}

const actionsOf = async (user: string, locationId: string) =>
  LocationActionsSchema.parse(
    await (await call(user, "GET", `/locations/${locationId}/actions`)).json(),
  );
const approve = (user: string | null, id: string, body: unknown = {}) =>
  call(user, "POST", `/actions/${id}/approve`, body);
const decline = (user: string | null, id: string, body: unknown = {}) =>
  call(user, "POST", `/actions/${id}/decline`, body);
const retry = (user: string | null, id: string) => call(user, "POST", `/actions/${id}/retry`);
const line = () => [...db.sampleLines.values()][0] ?? null;
const LINE = "Joe's Pizza in Raleigh: open every day. Call ahead for large orders.";

beforeEach(() => {
  db = createMemoryDb();
  queued = [];
  queueFails = false;
  env = {
    PROVIDER_MODE: "mock",
    CONNECTIONS_KEY: SECRET,
    SCAN_QUEUE: {
      send: async (message: ActionMessage | ConnectionMessage) => {
        if (queueFails) throw new Error("The queue is down.");
        queued.push(message);
      },
      sendBatch: async (messages: { body: ActionMessage | ConnectionMessage }[]) => {
        queued.push(...messages.map((message) => message.body));
      },
    },
  } as unknown as Env;
});

describe("what the worker proposes", () => {
  it("is composed by rule from the location's own details", () => {
    expect(sampleOpeningLine({ name: "Joe's Pizza", city: "Raleigh" })).toBe(LINE);
    expect(sampleOpeningLine({ name: "Joe's Pizza", city: null })).toBe(
      "Joe's Pizza: open every day. Call ahead for large orders.",
    );
  });

  it("follows a sync, once for each thing, and says what it would replace", async () => {
    const { location, connection } = await matched();
    const { waiting, record } = await actionsOf(bob, location.id);
    expect(record).toEqual([]);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      location_id: location.id,
      kind: "sample",
      connection_id: connection.id,
      summary: "Set the opening line of Sample listing: Riverside",
      seen: { text: null },
      proposed_text: LINE,
      written_by: "rule",
      status: "proposed",
      approved_at: null,
    });
    // Fourteen days to answer.
    const waits =
      Date.parse(waiting[0]?.lapses_at ?? "") - Date.parse(waiting[0]?.proposed_at ?? "");
    expect(waits).toBe(14 * DAY);
    // A second sync proposes nothing more while the first is waiting.
    expect(await proposeAfterSync(connection.id, await worker())).toBe(0);
    expect(db.actions).toHaveLength(1);
  });

  it("is queued for by a match, so it appears without waiting for the daily run", async () => {
    const { organization, connection } = await matched();
    const second = LocationSchema.parse(
      await (
        await call(alice, "POST", `/organizations/${organization.id}/locations`, {
          name: "Joe's Pizza Uptown",
          city: "Raleigh",
        })
      ).json(),
    );
    const response = await call(
      alice,
      "PUT",
      `/connections/${connection.id}/locations/${second.id}`,
      { external_id: "sample-listing-3" },
    );
    expect(response.status).toBe(200);
    expect(queued).toEqual([{ connection_id: connection.id, step: "sync" }]);
    expect(await proposeAfterSync(connection.id, await worker())).toBe(1);
  });

  it("is never made by a request, or for an account that is not working", async () => {
    const { location, connection } = await matched();
    await expect(
      memoryStore(db, alice).proposeAction({
        location_id: location.id,
        kind: "sample",
        connection_id: connection.id,
        subject: "planted",
        basis: "planted",
        summary: "Planted",
        seen: null,
        proposed_text: "Planted",
        written_by: "rule",
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await decline(alice, db.actions[0]?.id ?? "");
    await call(alice, "DELETE", `/connections/${connection.id}`);
    expect(await proposeAfterSync(connection.id, await worker())).toBe(0);
  });
});

describe("a location's actions", () => {
  it("are read by its members and the operator, and by nobody else", async () => {
    const { organization, location } = await matched();
    expect((await actionsOf(alice, location.id)).waiting).toHaveLength(1);
    expect((await call(carol, "GET", `/locations/${location.id}/actions`)).status).toBe(404);
    expect((await call(null, "GET", `/locations/${location.id}/actions`)).status).toBe(401);
    const counts = async (user: string) =>
      WaitingActionsSchema.parse(
        await (await call(user, "GET", `/organizations/${organization.id}/actions/waiting`)).json(),
      );
    expect(await counts(bob)).toEqual({ [location.id]: 1 });
    expect(
      (await call(carol, "GET", `/organizations/${organization.id}/actions/waiting`)).status,
    ).toBe(404);

    db.operators.add(carol);
    expect((await actionsOf(carol, location.id)).waiting).toHaveLength(1);
    expect(await counts(carol)).toEqual({ [location.id]: 1 });
    // The operator reads, and answers nothing.
    const id = db.actions[0]?.id ?? "";
    expect((await approve(carol, id)).status).toBe(404);
    expect((await decline(carol, id)).status).toBe(404);
    expect(db.actions[0]?.status).toBe("proposed");
  });

  it("never carry the worker's own bookkeeping", async () => {
    const { location } = await matched();
    const text = await (await call(alice, "GET", `/locations/${location.id}/actions`)).text();
    for (const kept of ["subject", "basis", "attempts", "carrying_since"]) {
      expect(text, kept).not.toContain(`"${kept}"`);
    }
  });
});

describe("a member's yes", () => {
  it("is any member's, is recorded with who gave it, and queues the worker", async () => {
    const { location } = await matched();
    const id = db.actions[0]?.id ?? "";
    const response = await approve(bob, id);
    expect(response.status).toBe(200);
    expect(ActionSchema.parse(await response.json())).toMatchObject({
      status: "approved",
      approved_by_email: "bob@example.com",
      approved_text: null,
    });
    expect(queued).toEqual([{ action_id: id, step: "carry_out" }]);
    // The request changed nothing outside: only the worker carries an action out.
    expect(line()).toBeNull();

    expect(await carryOutAction(id, await worker())).toBe("done");
    expect(line()).toBe(LINE);
    const { waiting, record } = await actionsOf(alice, location.id);
    expect(waiting).toEqual([]);
    expect(record[0]).toMatchObject({ status: "done", approved_by_email: "bob@example.com" });
    expect(record[0]?.done_at).not.toBeNull();
  });

  it("may change the text first, and the record keeps both", async () => {
    await matched();
    const id = db.actions[0]?.id ?? "";
    const edited = "Joe's Pizza: open late on Fridays.";
    const response = await approve(alice, id, { text: `  ${edited}  ` });
    expect(ActionSchema.parse(await response.json())).toMatchObject({
      proposed_text: LINE,
      approved_text: edited,
    });
    await carryOutAction(id, await worker());
    expect(line()).toBe(edited);
  });

  it("is not recorded as a change when the text sent is what was proposed", async () => {
    await matched();
    const id = db.actions[0]?.id ?? "";
    const response = await approve(alice, id, { text: LINE });
    expect(ActionSchema.parse(await response.json()).approved_text).toBeNull();
    expect((await approve(alice, crypto.randomUUID())).status).toBe(404);
    expect((await approve(null, id)).status).toBe(401);
    expect((await approve(alice, id, { text: "   " })).status).toBe(422);
  });

  it("cannot be given twice, or after a no, or once it has lapsed", async () => {
    await matched();
    const id = db.actions[0]?.id ?? "";
    await approve(alice, id);
    const again = await approve(bob, id);
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("limit_reached");
    expect((await decline(bob, id)).status).toBe(409);
    expect(queued).toHaveLength(1);
  });

  it("still stands when its message is lost: the schedule asks the worker again", async () => {
    await matched();
    const id = db.actions[0]?.id ?? "";
    queueFails = true;
    expect((await approve(alice, id)).status).toBe(200);
    expect(queued).toEqual([]);
    queueFails = false;

    const store = memoryStore(db, null);
    const approved = Date.parse(db.actions[0]?.approved_at ?? "");
    expect(await requeueStalledActions(store, env.SCAN_QUEUE, approved + 14 * 60_000)).toBe(0);
    expect(await requeueStalledActions(store, env.SCAN_QUEUE, approved + 16 * 60_000)).toBe(1);
    expect(queued).toEqual([{ action_id: id, step: "carry_out" }]);
    await carryOutAction(id, await worker());
    expect(await requeueStalledActions(store, env.SCAN_QUEUE, approved + 60 * 60_000)).toBe(0);
  });
});

describe("a member's no", () => {
  it("is recorded with who gave it and why, and nothing is done", async () => {
    const { location } = await matched();
    const id = db.actions[0]?.id ?? "";
    const response = await decline(bob, id, { reason: "  We close on Mondays.  " });
    expect(response.status).toBe(200);
    expect(ActionSchema.parse(await response.json())).toMatchObject({
      status: "declined",
      declined_by_email: "bob@example.com",
      decline_reason: "We close on Mondays.",
    });
    expect(queued).toEqual([]);
    expect(await carryOutAction(id, await worker())).toBe("not_approved");
    expect(line()).toBeNull();
    expect((await actionsOf(alice, location.id)).record[0]?.status).toBe("declined");
    expect((await approve(alice, id)).status).toBe(409);
    expect((await decline(alice, id, { reason: "x".repeat(201) })).status).toBe(422);
  });

  it("stops the same thing being proposed again, until what it rests on changes", async () => {
    const { location, connection } = await matched();
    await decline(alice, db.actions[0]?.id ?? "");
    expect(await proposeAfterSync(connection.id, await worker())).toBe(0);

    // The location is renamed, so there is something else to propose.
    const kept = db.locations.find((candidate) => candidate.id === location.id);
    if (kept) kept.name = "Joe's Pizza and Subs";
    expect(await proposeAfterSync(connection.id, await worker())).toBe(1);
    expect((await actionsOf(alice, location.id)).waiting[0]?.proposed_text).toContain(
      "Joe's Pizza and Subs",
    );
  });
});

describe("carrying an action out", () => {
  it("writes nothing a second time when its message is delivered twice", async () => {
    await matched();
    const id = db.actions[0]?.id ?? "";
    await approve(alice, id);
    expect(await carryOutAction(id, await worker())).toBe("done");
    expect(await carryOutAction(id, await worker())).toBe("not_approved");
    expect(db.sampleLines.size).toBe(1);
  });

  it("is done without writing when the thing is already as the action would make it", async () => {
    const { connection } = await matched();
    const id = db.actions[0]?.id ?? "";
    await approve(alice, id);
    // The worker wrote it and died before it could say so.
    db.sampleLines.set(`${connection.id}:sample-listing-2`, LINE);
    expect(await carryOutAction(id, await worker())).toBe("done");
    expect(db.actions[0]?.status).toBe("done");
  });

  it("writes nothing when the thing has changed since the member was shown it", async () => {
    const { location, connection } = await matched();
    const id = db.actions[0]?.id ?? "";
    await approve(alice, id);
    db.sampleLines.set(`${connection.id}:sample-listing-2`, "Changed at the account itself.");
    expect(await carryOutAction(id, await worker())).toBe("out_of_date");
    expect(line()).toBe("Changed at the account itself.");
    expect((await actionsOf(alice, location.id)).record[0]).toMatchObject({
      status: "lapsed",
      lapse_reason: "out_of_date",
    });
    // A fresh one is proposed against what is there now.
    expect(await proposeAfterSync(connection.id, await worker())).toBe(1);
    expect((await actionsOf(alice, location.id)).waiting[0]?.seen).toEqual({
      text: "Changed at the account itself.",
    });
  });

  it("is not started twice at once", async () => {
    await matched();
    const id = db.actions[0]?.id ?? "";
    await approve(alice, id);
    const store = memoryStore(db, null);
    expect(await store.claimAction(id)).toBe(1);
    expect(await carryOutAction(id, await worker())).toBe("busy");
    expect(line()).toBeNull();
    // Whoever had it is taken to have died after ten minutes.
    db.now = new Date(Date.now() + 11 * 60_000).toISOString();
    expect(await carryOutAction(id, await worker())).toBe("done");
  });

  it("is taken up again by the schedule when the worker that had it died", async () => {
    await matched();
    const id = db.actions[0]?.id ?? "";
    await approve(alice, id);
    const store = memoryStore(db, null);
    const start = Date.now();
    db.now = new Date(start).toISOString();
    // A worker takes it and is never heard from again.
    expect(await store.claimAction(id)).toBe(1);
    // The queue delivers the message again within its hold, and is told someone is on it.
    expect(await carryOutAction(id, await worker())).toBe("busy");

    queued = [];
    expect(await requeueStalledActions(store, env.SCAN_QUEUE, start + 9 * 60_000)).toBe(0);
    expect(await requeueStalledActions(store, env.SCAN_QUEUE, start + 16 * 60_000)).toBe(1);
    expect(queued).toEqual([{ action_id: id, step: "carry_out" }]);
    db.now = new Date(start + 16 * 60_000).toISOString();
    expect(await carryOutAction(id, await worker())).toBe("done");
    expect(line()).toBe(LINE);
  });

  it("fails, with the reason, when the account it goes through is gone or not working", async () => {
    const { location, connection } = await matched();
    const id = db.actions[0]?.id ?? "";
    await approve(alice, id);
    await call(alice, "DELETE", `/connections/${connection.id}/locations/${location.id}`);
    expect(await carryOutAction(id, await worker())).toBe("failed");
    expect(db.actions[0]).toMatchObject({
      status: "failed",
      failure: "This location is no longer matched to that account.",
    });
    expect(line()).toBeNull();
  });

  it("is tried three times before it fails, and then only when a member asks again", async () => {
    const { location } = await matched();
    const id = db.actions[0]?.id ?? "";
    await approve(alice, id);
    const down = memoryStore(db, null);
    const failing = {
      key: await sealingKey(SECRET),
      store: {
        ...down,
        setSampleLine: async () => {
          throw new Error("The outside service is down.");
        },
      },
    };
    expect(await carryOutAction(id, failing)).toBe("again");
    expect(await carryOutAction(id, failing)).toBe("again");
    expect(db.actions[0]).toMatchObject({
      status: "approved",
      failure: "The outside service is down.",
    });
    expect(await carryOutAction(id, failing)).toBe("failed");
    expect(db.actions[0]).toMatchObject({
      status: "failed",
      failure: "The outside service is down.",
    });
    // Nothing more happens by itself.
    expect(await carryOutAction(id, await worker())).toBe("not_approved");
    expect(await requeueStalledActions(down, env.SCAN_QUEUE, Date.now() + DAY)).toBe(0);

    queued = [];
    expect((await retry(carol, id)).status).toBe(404);
    const response = await retry(bob, id);
    expect(response.status).toBe(201);
    const again = ActionSchema.parse(await response.json());
    expect(again).toMatchObject({
      status: "approved",
      retry_of: id,
      approved_by_email: "bob@example.com",
      proposed_text: LINE,
    });
    expect(queued).toEqual([{ action_id: again.id, step: "carry_out" }]);
    expect(await carryOutAction(again.id, await worker())).toBe("done");
    expect(line()).toBe(LINE);
    // The record keeps both: the one that failed and the one that was asked for again.
    expect((await actionsOf(alice, location.id)).record.map((kept) => kept.status).sort()).toEqual([
      "done",
      "failed",
    ]);
    expect((await retry(bob, again.id)).status).toBe(409);
  });
});

describe("a proposal nobody answers", () => {
  it("lapses after fourteen days, and can then be proposed again", async () => {
    const { location, connection } = await matched();
    const id = db.actions[0]?.id ?? "";
    const store = memoryStore(db, null);
    const proposed = Date.parse(db.actions[0]?.proposed_at ?? "");
    db.now = new Date(proposed + 13 * DAY).toISOString();
    expect(await store.lapseActions()).toBe(0);
    db.now = new Date(proposed + 15 * DAY).toISOString();
    // Past its day it cannot be approved, even before the daily run has marked it.
    expect((await approve(alice, id)).status).toBe(409);
    expect(await store.lapseActions()).toBe(1);
    expect((await actionsOf(alice, location.id)).record[0]).toMatchObject({
      status: "lapsed",
      lapse_reason: "expired",
    });
    expect(await store.lapseActions()).toBe(0);
    expect(await proposeAfterSync(connection.id, await worker())).toBe(1);
  });
});

describe("telling the owners", () => {
  const HOUR = 3_600_000;
  let sent: { to: string[]; email: Email }[];
  const notices = (now = Date.now(), send = true) =>
    sendActionNotices({
      store: memoryStore(db, null),
      send: send
        ? async (to, email) => {
            sent.push({ to, email });
          }
        : undefined,
      appUrl: "https://app.example/",
      now: new Date(now),
    });
  /** Approves the waiting action as `user` and has the worker carry it out at `at`. */
  async function carriedOut(user: string, at = Date.now()) {
    const id = db.actions.find((action) => action.status === "proposed")?.id ?? "";
    await approve(user, id);
    db.now = new Date(at).toISOString();
    expect(await carryOutAction(id, await worker())).toBe("done");
    return id;
  }

  beforeEach(() => {
    sent = [];
  });

  it("puts what is newly waiting in one message to the owners, once", async () => {
    await matched();
    expect(await notices()).toBe(1);
    expect(sent).toHaveLength(1);
    // The owner, and not the member.
    expect(sent[0]?.to).toEqual(["alice@example.com"]);
    expect(sent[0]?.email.subject).toBe("Waiting for your yes at Raleigh Pizza Group");
    expect(sent[0]?.email.text).toContain(
      "- Joe's Pizza: Set the opening line of Sample listing: Riverside.",
    );
    expect(sent[0]?.email.text).toContain("Nothing waiting is done until someone");
    expect(sent[0]?.email.text).toContain("https://app.example");
    // Mentioned once: the next day's run has nothing to say.
    expect(await notices()).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("says what was done and who approved it, an owner's own approvals included", async () => {
    const { connection, location } = await matched();
    await notices();
    sent = [];
    await carriedOut(alice);
    // Something else comes up to be answered on the same day.
    const kept = db.locations.find((candidate) => candidate.id === location.id);
    if (kept) kept.name = "Joe's Pizza and Subs";
    await proposeAfterSync(connection.id, await worker());

    expect(await notices()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.email.subject).toBe("What Nearcited did for Raleigh Pizza Group");
    expect(sent[0]?.email.text).toContain("Approved by alice@example.com, and done on");
    expect(sent[0]?.email.text).toContain("1 thing is also waiting for a yes:");
    expect(await notices()).toBe(0);
  });

  it("says when a member changed the text before approving", async () => {
    await matched();
    const id = db.actions[0]?.id ?? "";
    await approve(bob, id, { text: "Open late on Fridays." });
    await carryOutAction(id, await worker());
    await notices();
    expect(sent[0]?.email.text).toContain(
      "Approved by bob@example.com, who changed the text first",
    );
  });

  it("never writes to a test organization, whose record on the page is the notice", async () => {
    db.testAccounts.add(alice);
    await matched();
    await carriedOut(alice);
    expect(await notices()).toBe(0);
    expect(sent).toEqual([]);
    // Marked told all the same, so nothing waits on an email that will never go.
    expect(await memoryStore(db, null).listActionsToTell()).toEqual([]);
  });

  it("leaves them untold where it cannot send, has nobody to send to, or the send fails", async () => {
    await matched();
    await carriedOut(alice);
    expect(await notices(Date.now(), false)).toBe(0);
    expect(await memoryStore(db, null).listActionsToTell()).toHaveLength(1);

    db.emails.delete(alice);
    expect(await notices()).toBe(0);
    db.emails.set(alice, "alice@example.com");
    expect(
      await sendActionNotices({
        store: memoryStore(db, null),
        send: async () => {
          throw new Error("The mail service is down.");
        },
        appUrl: "https://app.example/",
      }),
    ).toBe(0);
    expect(await memoryStore(db, null).listActionsToTell()).toHaveLength(1);
    // The next run tells them.
    expect(await notices()).toBe(1);
    expect(await memoryStore(db, null).listActionsToTell()).toEqual([]);
  });

  it("holds everything for an organization whose owners have gone 36 hours untold", async () => {
    const { connection, location } = await matched();
    // It was done 37 hours before now, as the clock on the wall has it: the operator's view
    // reads that clock, and the store's is moved to match.
    const start = Date.now() - 37 * HOUR;
    await carriedOut(alice, start);
    // Nobody could be told. A day and a half later something else is approved.
    const kept = db.locations.find((candidate) => candidate.id === location.id);
    if (kept) kept.name = "Joe's Pizza and Subs";
    await proposeAfterSync(connection.id, await worker());
    const next = db.actions.find((action) => action.status === "proposed")?.id ?? "";
    db.now = new Date(start + 35 * HOUR).toISOString();
    expect((await actionsOf(bob, location.id)).held).toBe(false);

    db.now = new Date(start + 37 * HOUR).toISOString();
    await approve(bob, next);
    expect(await carryOutAction(next, await worker())).toBe("held");
    expect(db.actions.find((action) => action.id === next)?.status).toBe("approved");
    expect(await memoryStore(db, null).claimAction(next)).toBe(0);
    expect((await actionsOf(bob, location.id)).held).toBe(true);
    // A stranger is told nothing about it.
    expect(await memoryStore(db, carol).isLocationHeld(location.id)).toBe(false);

    // The operator is shown it.
    db.operators.add(carol);
    const overview = OperatorOverviewSchema.parse(
      await (await call(carol, "GET", "/operator/overview")).json(),
    );
    expect(overview.attention.map((item) => item.kind)).toContain("action_untold");

    // Once the owners have been told, it goes ahead.
    expect(await notices(start + 37 * HOUR)).toBe(1);
    expect((await actionsOf(bob, location.id)).held).toBe(false);
    expect(await carryOutAction(next, await worker())).toBe("done");
  });

  it("cannot be approved where no notice could be sent, except on sample data", async () => {
    await matched();
    const id = db.actions[0]?.id ?? "";
    // Real data, no outgoing email: the yes is refused before it is recorded.
    env = { ...env, PROVIDER_MODE: "live" } as Env;
    const refused = await approve(alice, id);
    expect(refused.status).toBe(503);
    expect(await errorCode(refused)).toBe("actions_unavailable");
    expect(db.actions[0]?.status).toBe("proposed");
    // A stranger learns nothing from the refusal.
    expect((await approve(carol, id)).status).toBe(404);

    env = { ...env, RESEND_API_KEY: "re_test" } as Env;
    expect((await approve(alice, id)).status).toBe(200);
  });

  it("lets a test organization answer without email, since it is never written to", async () => {
    db.testAccounts.add(alice);
    await matched();
    env = { ...env, PROVIDER_MODE: "live" } as Env;
    expect((await approve(alice, db.actions[0]?.id ?? "")).status).toBe(200);
  });
});
