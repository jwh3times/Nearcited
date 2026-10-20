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
const worker = async () => ({
  store: memoryStore(db, null),
  key: await sealingKey(SECRET),
  queue: env.SCAN_QUEUE,
});

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
    for (const kept of [
      "subject",
      "basis",
      "attempts",
      "carrying_since",
      "recommendation_id",
      "seen_until",
      "allowance_month",
    ]) {
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

  it("marks them told on sample data with no email to send with, where nothing left the product", async () => {
    await matched();
    await carriedOut(alice);
    expect(
      await sendActionNotices({
        store: memoryStore(db, null),
        appUrl: "https://app.example/",
        sampleData: true,
      }),
    ).toBe(0);
    // Not left to hold the organization 36 hours on: the record on the page is the notice.
    expect(await memoryStore(db, null).listActionsToTell()).toEqual([]);
  });

  it("sends the notice on sample data where it has email to send with", async () => {
    await matched();
    await carriedOut(alice);
    expect(
      await sendActionNotices({
        store: memoryStore(db, null),
        send: async (to, email) => {
          sent.push({ to, email });
        },
        appUrl: "https://app.example/",
        sampleData: true,
      }),
    ).toBe(1);
    expect(sent).toHaveLength(1);
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

describe("what an action replaced", () => {
  it("is on the record, and is dropped once it may be kept no longer, which the record says", async () => {
    const { connection, location } = await matched();
    const first = db.actions[0]?.id ?? "";
    await approve(alice, first);
    expect(await carryOutAction(first, await worker())).toBe("done");
    // A second change, so there is something it replaced.
    const kept = db.locations.find((candidate) => candidate.id === location.id);
    if (kept) kept.name = "Joe's Pizza and Subs";
    await proposeAfterSync(connection.id, await worker());
    const second = db.actions[1]?.id ?? "";
    await approve(bob, second);
    expect(await carryOutAction(second, await worker())).toBe("done");
    const recorded = async () =>
      (await actionsOf(alice, location.id)).record.find((action) => action.id === second);
    expect(await recorded()).toMatchObject({ seen: { text: LINE }, seen_dropped_at: null });

    const store = memoryStore(db, null);
    const proposed = Date.parse(db.actions[1]?.proposed_at ?? "");
    db.now = new Date(proposed + 29 * DAY).toISOString();
    expect(await store.dropExpiredSeen()).toBe(0);
    db.now = new Date(proposed + 31 * DAY).toISOString();
    expect(await store.dropExpiredSeen()).toBe(2);
    // What the product wrote and who approved it stay. What it replaced is gone, and it says when.
    expect(await recorded()).toMatchObject({
      status: "done",
      seen: null,
      seen_dropped_at: db.now,
      proposed_text:
        "Joe's Pizza and Subs in Raleigh: open every day. Call ahead for large orders.",
      approved_by_email: "bob@example.com",
    });
    expect(await store.dropExpiredSeen()).toBe(0);
  });

  it("takes a proposal still waiting on it with it, and nothing approved is then carried out", async () => {
    // A kind held to fewer days than a proposal waits.
    db.actionKindTerms.set("sample", { allowance: null, keeps_seen_days: 7 });
    const { connection, location } = await matched();
    const approved = db.actions[0]?.id ?? "";
    await approve(alice, approved);
    const store = memoryStore(db, null);
    const waiting = await store.proposeAction({
      location_id: location.id,
      kind: "sample",
      connection_id: connection.id,
      subject: "opening-line:another",
      basis: "first",
      summary: "Set another line",
      seen: { text: "What was there" },
      proposed_text: "Another line",
      written_by: "rule",
    });

    db.now = new Date(Date.parse(db.actions[0]?.proposed_at ?? "") + 8 * DAY).toISOString();
    expect(await store.dropExpiredSeen()).toBe(2);
    expect(db.actions.find((action) => action.id === waiting?.id)).toMatchObject({
      status: "lapsed",
      lapse_reason: "out_of_date",
      seen: null,
    });
    // The yes was to replacing what the member was shown, and that can no longer be checked.
    expect(await carryOutAction(approved, await worker())).toBe("out_of_date");
    expect(line()).toBeNull();
    expect(db.actions[0]).toMatchObject({ status: "lapsed", lapse_reason: "out_of_date" });
  });
});

describe("a task an action does the work of", () => {
  /** A task of the location, and an approved action that does its work. */
  async function withTask() {
    const made = await matched();
    const task = {
      id: crypto.randomUUID(),
      location_id: made.location.id,
      scan_id: null,
      rule: "source:listing.example",
      title: "Check your listing",
      detail: "Detail",
      status: "open" as const,
      acted_at: null,
      acted_by_action: null,
      created_at: "2026-10-01T00:00:00Z",
    };
    db.recommendations.push(task);
    const store = memoryStore(db, null);
    const proposal = {
      location_id: made.location.id,
      kind: "sample" as const,
      connection_id: made.connection.id,
      subject: "opening-line:for-the-task",
      basis: "first",
      summary: "Set the line the task asks for",
      seen: { text: null },
      proposed_text: "The line the task asks for",
      written_by: "rule" as const,
      recommendation_id: task.id,
    };
    const action = await store.proposeAction(proposal);
    return { ...made, task, proposal, store, id: action?.id ?? "" };
  }
  const marked = (id: string) => db.recommendations.find((candidate) => candidate.id === id);

  it("is marked done when the action is carried out, by the action, and not before", async () => {
    const { task, id } = await withTask();
    await approve(alice, id);
    expect(marked(task.id)).toMatchObject({ acted_at: null, acted_by_action: null });
    db.now = "2026-10-20T12:00:00.000Z";
    expect(await carryOutAction(id, await worker())).toBe("done");
    expect(marked(task.id)).toMatchObject({ acted_at: db.now, acted_by_action: id });
  });

  it("keeps that mark: a member cannot take it back, though they can their own", async () => {
    const { task, id } = await withTask();
    // Their own word that the work was done is theirs to take back.
    expect((await call(bob, "PATCH", `/recommendations/${task.id}`, { acted: true })).status).toBe(
      200,
    );
    expect((await call(bob, "PATCH", `/recommendations/${task.id}`, { acted: false })).status).toBe(
      200,
    );

    await approve(alice, id);
    expect(await carryOutAction(id, await worker())).toBe("done");
    for (const acted of [false, true]) {
      const refused = await call(alice, "PATCH", `/recommendations/${task.id}`, { acted });
      expect(refused.status, String(acted)).toBe(409);
      expect(await errorCode(refused)).toBe("limit_reached");
    }
    expect(marked(task.id)?.acted_by_action).toBe(id);
    // Whether it is shown at all is still the member's to say.
    expect(
      (await call(alice, "PATCH", `/recommendations/${task.id}`, { status: "dismissed" })).status,
    ).toBe(200);
  });

  it("is left alone by an action that failed, and by one for another location's task", async () => {
    const { task, id, proposal, store } = await withTask();
    await approve(alice, id);
    for (const connection of db.connections) connection.status = "broken";
    expect(await carryOutAction(id, await worker())).toBe("failed");
    expect(marked(task.id)).toMatchObject({ acted_at: null, acted_by_action: null });

    const other = { ...task, id: crypto.randomUUID(), location_id: crypto.randomUUID() };
    db.recommendations.push(other);
    await expect(
      store.proposeAction({ ...proposal, subject: "opening-line:x", recommendation_id: other.id }),
    ).rejects.toThrow(/belongs to the location/);
  });
});

describe("an action of a kind that is counted", () => {
  const NO_ROOM = "Your plan has no more of these this month.";
  /**
   * The sample kind made to take from an allowance, as a real kind would, and Alice's
   * organization given `most` of them a month. Nothing is proposed until it has them.
   */
  async function counted(most: number | true) {
    db.allowanceKinds.set("pretend_changes", most !== true);
    db.actionKindTerms.set("sample", { allowance: "pretend_changes", keeps_seen_days: 30 });
    const made = await matched();
    expect(db.actions).toEqual([]);
    const organization = db.organizations.find((o) => o.id === made.organization.id);
    Object.assign(organization ?? {}, { max_locations: 1, allowances: { pretend_changes: most } });
    expect(await proposeAfterSync(made.connection.id, await worker())).toBe(1);
    const store = memoryStore(db, null);
    const another = (subject: string) =>
      store.proposeAction({
        location_id: made.location.id,
        kind: "sample",
        connection_id: made.connection.id,
        subject,
        basis: "first",
        summary: "Set another line",
        seen: { text: null },
        proposed_text: LINE,
        written_by: "rule",
      });
    const used = async () =>
      (await store.getAllowanceUse(made.organization.id)).pretend_changes ?? 0;
    return { ...made, store, another, used, id: db.actions[0]?.id ?? "" };
  }

  it("takes one from the month when it is carried out, and not when proposed or approved", async () => {
    const { id, used } = await counted(2);
    expect(await used()).toBe(0);
    await approve(alice, id);
    expect(await used()).toBe(0);
    expect(await carryOutAction(id, await worker())).toBe("done");
    expect(await used()).toBe(1);
    // Delivered again, nothing more is taken.
    expect(await carryOutAction(id, await worker())).toBe("not_approved");
    expect(await used()).toBe(1);
  });

  it("takes one for all its tries together, and gives it back when it fails", async () => {
    const { id, used, store } = await counted(2);
    await approve(alice, id);
    const failing = {
      key: await sealingKey(SECRET),
      store: {
        ...store,
        setSampleLine: async () => {
          throw new Error("The outside service is down.");
        },
      },
    };
    expect(await carryOutAction(id, failing)).toBe("again");
    expect(await used()).toBe(1);
    expect(await carryOutAction(id, failing)).toBe("again");
    expect(await used()).toBe(1);
    expect(await carryOutAction(id, failing)).toBe("failed");
    expect(await used()).toBe(0);
  });

  it("gives it back when the thing had changed and nothing was written", async () => {
    const { id, used, connection } = await counted(2);
    await approve(alice, id);
    db.sampleLines.set(`${connection.id}:sample-listing-2`, "Somebody else's line");
    expect(await carryOutAction(id, await worker())).toBe("out_of_date");
    expect(await used()).toBe(0);
  });

  it("is failed with the reason when the month is used by the time it is carried out", async () => {
    const { id, used, another } = await counted(1);
    const second = (await another("opening-line:second"))?.id ?? "";
    await approve(alice, id);
    await approve(bob, second);
    expect(await carryOutAction(id, await worker())).toBe("done");
    expect(await used()).toBe(1);

    expect(await carryOutAction(second, await worker())).toBe("failed");
    expect(db.actions.find((action) => action.id === second)).toMatchObject({
      status: "failed",
      failure: NO_ROOM,
      attempts: 0,
    });
    expect(await used()).toBe(1);
    // Asking again is refused while there is still no room, with the reason.
    const refused = await retry(alice, second);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(NO_ROOM);
  });

  it("is not proposed, or said yes to, once the month is used", async () => {
    const { id, used, another, location } = await counted(1);
    const waiting = (await another("opening-line:waiting"))?.id ?? "";
    await approve(alice, id);
    expect(await carryOutAction(id, await worker())).toBe("done");
    expect(await used()).toBe(1);

    expect(await another("opening-line:more")).toBeNull();
    const refused = await approve(alice, waiting);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(NO_ROOM);
    expect((await actionsOf(alice, location.id)).waiting).toHaveLength(1);

    // The next month has its own number.
    const now = new Date();
    db.now = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
    expect(await used()).toBe(0);
    expect(await another("opening-line:more")).not.toBeNull();
  });

  it("counts nothing for a kind the plan includes without a number", async () => {
    const { id, store, organization } = await counted(true);
    await approve(alice, id);
    expect(await carryOutAction(id, await worker())).toBe("done");
    expect(await store.getAllowanceUse(organization.id)).toEqual({});
    expect(db.actions[0]?.allowance_month).toBeNull();
  });
});

describe("standing permission", () => {
  const dave = "d0000000-0000-4000-8000-000000000004";
  let sent: { to: string[]; email: Email }[];
  const give = (user: string, organizationId: string, kind = "sample") =>
    call(user, "POST", `/organizations/${organizationId}/standing-permissions`, { kind });
  const end = (user: string, organizationId: string, kind = "sample") =>
    call(user, "DELETE", `/organizations/${organizationId}/standing-permissions/${kind}`);
  const notices = () =>
    sendActionNotices({
      store: memoryStore(db, null),
      send: async (to, email) => {
        sent.push({ to, email });
      },
      appUrl: "https://app.example/",
    });
  const waitingNow = () => db.actions.find((action) => action.status === "proposed")?.id ?? "";
  const status = (id: string) => db.actions.find((action) => action.id === id)?.status;

  /** Bob approves what is waiting, as proposed or changed, and the worker carries it out. */
  async function approvedAndDone(body: unknown = {}) {
    const id = waitingNow();
    await approve(bob, id, body);
    expect(await carryOutAction(id, await worker())).toBe("done");
    return id;
  }
  /** The location's details change, so the sync proposes its opening line again. */
  async function proposedAgain(locationId: string, connectionId: string, name: string) {
    const kept = db.locations.find((candidate) => candidate.id === locationId);
    if (kept) kept.name = name;
    return proposeAfterSync(connectionId, await worker());
  }
  /**
   * Alice's organization on a plan with standing permission, Dave its admin, and three sample
   * actions approved as proposed and carried out. A fourth waits.
   */
  async function earned() {
    const made = await matched();
    const organization = db.organizations.find((o) => o.id === made.organization.id);
    if (organization) organization.allowances = { standing_permission: true };
    db.memberships.push({ organization_id: made.organization.id, user_id: dave, role: "admin" });
    db.emails.set(dave, "dave@example.com");
    for (const name of ["Joe's Pizza Two", "Joe's Pizza Three", "Joe's Pizza Four"]) {
      await approvedAndDone();
      await proposedAgain(made.location.id, made.connection.id, name);
    }
    return made;
  }

  beforeEach(() => {
    sent = [];
  });

  it("is offered after three were approved as proposed and done, and not before", async () => {
    const { organization, location, connection } = await matched();
    const kept = db.organizations.find((o) => o.id === organization.id);
    if (kept) kept.allowances = { standing_permission: true };
    expect(await actionsOf(alice, location.id)).toMatchObject({
      permissions: [],
      permission_included: true,
      may_change_permission: true,
    });
    expect((await actionsOf(bob, location.id)).may_change_permission).toBe(false);

    await approvedAndDone();
    await proposedAgain(location.id, connection.id, "Joe's Pizza Two");
    // Changed before the yes: it does not count.
    await approvedAndDone({ text: "Open late on Fridays." });
    await proposedAgain(location.id, connection.id, "Joe's Pizza Three");
    await approvedAndDone();
    expect((await actionsOf(alice, location.id)).permissions).toEqual([
      { kind: "sample", counted: 2, standing: null },
    ]);
    const early = await give(alice, organization.id);
    expect(early.status).toBe(409);
    expect(await errorCode(early)).toBe("limit_reached");

    await proposedAgain(location.id, connection.id, "Joe's Pizza Four");
    await approvedAndDone();
    expect((await actionsOf(alice, location.id)).permissions).toEqual([
      { kind: "sample", counted: 3, standing: null },
    ]);
  });

  it("is given and ended by an owner or admin, and by nobody else", async () => {
    const { organization, location } = await earned();
    db.operators.add(carol);
    for (const user of [bob, carol]) {
      expect((await give(user, organization.id)).status, user).toBe(404);
    }
    const given = await give(dave, organization.id);
    expect(given.status).toBe(201);
    expect(await given.json()).toMatchObject({
      kind: "sample",
      given_by_email: "dave@example.com",
      ended_at: null,
    });
    expect((await give(alice, organization.id)).status).toBe(409);
    expect((await actionsOf(bob, location.id)).permissions).toEqual([
      expect.objectContaining({
        kind: "sample",
        standing: expect.objectContaining({ given_by_email: "dave@example.com" }),
      }),
    ]);
    for (const user of [bob, carol]) {
      expect((await end(user, organization.id)).status, user).toBe(404);
    }
    const ended = await end(alice, organization.id);
    expect(ended.status).toBe(200);
    expect(await ended.json()).toMatchObject({
      end_reason: "switched_off",
      ended_by_email: "alice@example.com",
    });
    expect((await end(alice, organization.id)).status).toBe(409);
    expect((await give(alice, organization.id, "no_such_kind")).status).toBe(422);
  });

  it("is not given where the plan does not include it, or where no notice could be sent", async () => {
    const { organization } = await earned();
    const kept = db.organizations.find((o) => o.id === organization.id);
    if (kept) kept.allowances = {};
    expect((await give(alice, organization.id)).status).toBe(409);
    if (kept) kept.allowances = { standing_permission: true };
    env = { ...env, PROVIDER_MODE: "live" } as Env;
    const refused = await give(alice, organization.id);
    expect(refused.status).toBe(503);
    expect(await errorCode(refused)).toBe("actions_unavailable");
  });

  it("approves the next one as it is proposed, and it is done and reported without a yes", async () => {
    const { organization, location, connection } = await earned();
    // What was waiting when it was given goes on waiting.
    const before = waitingNow();
    expect((await give(alice, organization.id)).status).toBe(201);
    expect(status(before)).toBe("proposed");
    await decline(bob, before);

    queued = [];
    expect(await proposedAgain(location.id, connection.id, "Joe's Pizza Five")).toBe(1);
    const next = db.actions.at(-1);
    expect(next).toMatchObject({
      status: "approved",
      approved_by_email: null,
      approved_under_by_email: "alice@example.com",
      always_asks: false,
    });
    expect(queued).toEqual([{ action_id: next?.id, step: "carry_out" }]);
    expect(await carryOutAction(next?.id ?? "", await worker())).toBe("done");
    expect(line()).toBe(
      "Joe's Pizza Five in Raleigh: open every day. Call ahead for large orders.",
    );
    // Done under it, it does not count toward another three.
    expect((await actionsOf(alice, location.id)).permissions[0]?.counted).toBe(3);

    expect(await notices()).toBe(1);
    const text = sent[0]?.email.text ?? "";
    expect(text).toContain(
      "without waiting for a yes, under the standing permission alice@example.com gave on",
    );
    expect(text).toContain("alice@example.com gave standing permission on");
    expect(text).toContain("An owner or admin can end a standing permission on the Actions tab");
  });

  it("never approves one that always asks", async () => {
    const { organization, location, connection } = await earned();
    await give(alice, organization.id);
    await decline(bob, waitingNow());
    const made = await memoryStore(db, null).proposeAction({
      location_id: location.id,
      kind: "sample",
      connection_id: connection.id,
      subject: "opening-line:sample-listing-2",
      basis: "a reply to a low-rated review",
      summary: "Reply to a review",
      seen: { text: null },
      proposed_text: "Thank you for telling us.",
      written_by: "model",
      always_asks: true,
    });
    expect(made).toMatchObject({ status: "proposed", always_asks: true, approved_under: null });
  });

  it("puts back to waiting at once what it approved, when it is switched off", async () => {
    const { organization, location, connection } = await earned();
    await give(alice, organization.id);
    await decline(bob, waitingNow());
    await proposedAgain(location.id, connection.id, "Joe's Pizza Five");
    const next = db.actions.at(-1)?.id ?? "";
    expect(status(next)).toBe("approved");

    db.now = new Date(Date.now() + DAY).toISOString();
    await end(dave, organization.id);
    const { waiting } = await actionsOf(bob, location.id);
    expect(waiting.map((action) => action.id)).toEqual([next]);
    expect(waiting[0]).toMatchObject({ approved_at: null, approved_under: null });
    expect(Date.parse(waiting[0]?.lapses_at ?? "") - Date.parse(db.now)).toBe(14 * DAY);
    expect(await carryOutAction(next, await worker())).toBe("not_approved");
    expect(line()).not.toContain("Five");
  });

  it("puts one back to waiting when it is taken to be carried out, if its permission is gone", async () => {
    const { organization, location, connection } = await earned();
    await give(alice, organization.id);
    await decline(bob, waitingNow());
    await proposedAgain(location.id, connection.id, "Joe's Pizza Five");
    const next = db.actions.at(-1)?.id ?? "";
    // The plan stops including it after the action was approved and before it is carried out.
    const kept = db.organizations.find((o) => o.id === organization.id);
    if (kept) kept.allowances = {};
    expect(await carryOutAction(next, await worker())).toBe("waiting");
    expect(status(next)).toBe("proposed");
    expect(line()).not.toContain("Five");
    expect((await actionsOf(alice, location.id)).permissions).toEqual([
      { kind: "sample", counted: 3, standing: null },
    ]);
    expect(await notices()).toBe(1);
    expect(sent[0]?.email.text).toContain("your plan no longer includes standing permission");
  });

  it("ends when a member asks to take back something done under it", async () => {
    const { organization, location, connection } = await earned();
    await give(alice, organization.id);
    await decline(bob, waitingNow());
    await proposedAgain(location.id, connection.id, "Joe's Pizza Five");
    const done = db.actions.at(-1)?.id ?? "";
    await carryOutAction(done, await worker());
    const asked = await call(bob, "POST", `/actions/${done}/take-back`);
    expect(asked.status).toBe(201);
    const back = ActionSchema.parse(await asked.json());
    expect(back.approved_under).toBeNull();
    expect(await carryOutAction(back.id, await worker())).toBe("done");

    expect((await actionsOf(alice, location.id)).permissions[0]?.standing).toBeNull();
    expect(await notices()).toBe(1);
    expect(sent[0]?.email.text).toContain(
      "when bob@example.com asked to take back something done under it",
    );
    // The next one waits for a yes.
    expect(await proposedAgain(location.id, connection.id, "Joe's Pizza Six")).toBe(1);
    expect(db.actions.at(-1)?.status).toBe("proposed");
  });

  it("is told to the owners once when it is given and once when it ends", async () => {
    const { organization } = await earned();
    await notices();
    sent = [];
    await give(dave, organization.id);
    expect(await notices()).toBe(1);
    expect(sent[0]?.to).toEqual(["alice@example.com"]);
    expect(sent[0]?.email.subject).toBe("Standing permission at Raleigh Pizza Group");
    expect(sent[0]?.email.text).toContain("dave@example.com gave standing permission on");
    expect(sent[0]?.email.text).toContain(
      "Nearcited may set the opening line of a sample listing at every location without waiting for a yes.",
    );
    expect(await notices()).toBe(1 - 1);
    await end(alice, organization.id);
    expect(await notices()).toBe(1);
    expect(sent[1]?.email.text).toContain(
      "alice@example.com ended the standing permission to set the opening line of a sample listing on",
    );
    expect(await notices()).toBe(0);
  });

  it("is marked told for a test organization, which is never written to", async () => {
    db.testAccounts.add(alice);
    const { organization } = await earned();
    await give(alice, organization.id);
    expect(await notices()).toBe(0);
    expect(sent).toEqual([]);
    expect(await memoryStore(db, null).listPermissionsToTell()).toEqual([]);
  });
});
