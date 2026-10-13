import {
  DRAFT_KINDS,
  type DraftMessage,
  DraftSchema,
  LocationDetailSchema,
  LocationSchema,
  OperatorSpendSchema,
  OrganizationSchema,
  TrackedQuerySchema,
} from "@nearcited/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { requeueStalledDrafts, writeDraft } from "../src/drafts";
import type { DraftWriter } from "../src/drafts/sample";
import type { Env } from "../src/env";
import type { Store } from "../src/store/types";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const carol = "c0000000-0000-4000-8000-000000000003";
const dave = "d0000000-0000-4000-8000-000000000004";
const MINUTE = 60_000;

const SAID = "Wood-fired pizza and fresh pasta, family-run since 1998.";
const GUIDE = "https://travel.usnews.com/raleigh/best-pizza";

let db: MemoryDb;
let queued: DraftMessage[];
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

/** The same app as a build with the private tuning: it prices a model and can write a note. */
const priced = createApp({
  authenticate: async (request) => {
    const userId = request.headers.get("Authorization")?.replace("Bearer ", "");
    return userId
      ? { user: { id: userId, email: `${userId}@example.com` }, store: memoryStore(db, userId) }
      : null;
  },
  publicStore: () => memoryStore(db, "nobody"),
  deployment: {
    models: {},
    rates: {
      "test-model": {
        input_per_million: 5,
        cached_input_per_million: 0.5,
        output_per_million: 20,
        per_thousand_searches: 10,
      },
    },
    draft_kinds: ["note"],
  },
});
const bearer = (user: string) => ({ headers: { Authorization: `Bearer ${user}` } });

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

const worker = () => memoryStore(db, null);

/**
 * Alice's organization, with Bob in it as a member and two drafts a month, and a location that
 * has said what it does. Its scan read a guide on usnews.com and a listing on yelp.com without
 * naming the business, so it has a task for each: one whose work is a note, one with no wording.
 */
async function withTasks({
  said = SAID as string | null,
  // Drafts a month on its plan, null for none, or "as made" to leave what it was made with.
  drafts = 2 as number | null | "as made",
} = {}) {
  const organization = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  db.memberships.push({ organization_id: organization.id, user_id: bob, role: "member" });
  db.emails.set(alice, "alice@example.com");
  db.emails.set(bob, "bob@example.com");
  const kept = db.organizations.find((candidate) => candidate.id === organization.id);
  // One location covered, so the month's number is the plan's number.
  if (kept && drafts !== "as made") {
    Object.assign(kept, { max_locations: 1, allowances: drafts === null ? {} : { drafts } });
  }

  const location = LocationSchema.parse(
    await (
      await call(alice, "POST", `/organizations/${organization.id}/locations`, {
        name: "Joe's Pizza",
        city: "Raleigh",
        region: "NC",
        website: "joespizza.example",
        what_we_do: said,
      })
    ).json(),
  );
  const query = TrackedQuerySchema.parse(
    await (
      await call(alice, "POST", `/locations/${location.id}/queries`, {
        kind: "ai_prompt",
        text: "best pizza in Raleigh",
      })
    ).json(),
  );

  const scan = await worker().createScan(location.id, "scheduled", null);
  await worker().markScanRunning(scan.id, env.PROVIDER_MODE === "mock" || kept?.is_test === true);
  await worker().completeScan(scan.id, {
    score: 0,
    results: [
      {
        tracked_query_id: query.id,
        surface: "chatgpt",
        mentioned: false,
        position: null,
        competitors: [],
        cited_urls: [GUIDE, "https://www.yelp.com/biz/somewhere"],
        answer_excerpt: null,
        phones: [],
      },
    ],
    recommendations: [
      { rule: "source:travel.usnews.com", title: "Ask to be included", detail: "Detail" },
      { rule: "source:yelp.com", title: "Check your listing", detail: "Detail" },
    ],
  });

  const tasks = (await detailOf(alice, location.id)).tasks;
  const note = tasks.find((task) => task.host === "travel.usnews.com");
  const listing = tasks.find((task) => task.host === "yelp.com");
  if (!note || !listing) throw new Error("the scan gave no tasks");
  return { organization, location, note, listing };
}

const detailOf = async (user: string, locationId: string) =>
  LocationDetailSchema.parse(await (await call(user, "GET", `/locations/${locationId}`)).json());
const draftOf = async (locationId: string, taskId: string) =>
  (await detailOf(alice, locationId)).tasks.find((task) => task.id === taskId)?.draft ?? null;
const ask = (user: string | null, locationId: string, taskId: string) =>
  call(user, "POST", `/locations/${locationId}/tasks/${taskId}/draft`);
const asked = async (user: string, locationId: string, taskId: string) => {
  const response = await ask(user, locationId, taskId);
  expect(response.status).toBe(202);
  return DraftSchema.parse(await response.json());
};
const used = (organizationId: string) => worker().getAllowanceUse(organizationId);

/** A writer that hands back each of `texts` in turn, and the last one from then on. */
const writing = (...texts: string[]): DraftWriter & { write: ReturnType<typeof vi.fn> } => {
  let next = 0;
  return {
    model: "test-model",
    kinds: DRAFT_KINDS,
    write: vi.fn(async () => texts[Math.min(next++, texts.length - 1)] ?? ""),
  };
};

const CALL = {
  model: "test-model-2026-10-01",
  input_tokens: 400,
  cached_input_tokens: 0,
  output_tokens: 150,
  searches: 0,
};

/** A writer that is charged for every call, as a model is, and hands back each text in turn. */
const charged = (...texts: (string | Error)[]): DraftWriter => {
  let next = 0;
  return {
    model: "test-model",
    kinds: DRAFT_KINDS,
    write: async (_request, onUsage) => {
      const text = texts[Math.min(next++, texts.length - 1)] ?? "";
      onUsage?.(CALL);
      if (text instanceof Error) throw text;
      return text;
    },
  };
};

beforeEach(() => {
  db = createMemoryDb();
  queued = [];
  queueFails = false;
  env = {
    PROVIDER_MODE: "mock",
    SCAN_QUEUE: {
      send: async (message: DraftMessage) => {
        if (queueFails) throw new Error("The queue is down.");
        queued.push(message);
      },
      sendBatch: async (messages: { body: DraftMessage }[]) => {
        queued.push(...messages.map((message) => message.body));
      },
    },
  } as unknown as Env;
});

describe("asking for a draft", () => {
  it("records the ask and queues the worker, and writes nothing itself", async () => {
    const { organization, location, note } = await withTasks();
    expect(note.draft_kind).toBe("note");
    expect(note.draft).toBeNull();

    const draft = await asked(bob, location.id, note.id);
    expect(draft).toMatchObject({
      recommendation_id: note.id,
      status: "asked",
      asked_by_email: "bob@example.com",
      text: null,
      kind: null,
      failure: null,
    });
    expect(queued).toEqual([{ draft_id: draft.id, step: "write" }]);
    // Nothing is counted until the worker writes it.
    expect(await used(organization.id)).toEqual({});
    expect(await draftOf(location.id, note.id)).toMatchObject({ id: draft.id, status: "asked" });
  });

  it("is one ask however often it is pressed while the draft is being written", async () => {
    const { location, note } = await withTasks();
    const first = await asked(alice, location.id, note.id);
    const second = await asked(bob, location.id, note.id);
    expect(second.id).toBe(first.id);
    expect(second.asked_by_email).toBe("alice@example.com");
    expect(db.drafts).toHaveLength(1);
  });

  it("still stands when the queue is down: the schedule sends it", async () => {
    const { location, note } = await withTasks();
    queueFails = true;
    const draft = await asked(alice, location.id, note.id);
    expect(queued).toEqual([]);

    db.now = new Date(Date.parse(draft.asked_at) + 16 * MINUTE).toISOString();
    expect(await requeueStalledDrafts(worker(), env.SCAN_QUEUE, Date.parse(db.now))).toBe(1);
    expect(queued).toEqual([{ draft_id: draft.id, step: "write" }]);
  });

  it("answers only a member of the location's organization", async () => {
    const { location, note, listing } = await withTasks();
    db.operators.add(carol);

    expect((await ask(null, location.id, note.id)).status).toBe(401);
    expect((await ask(dave, location.id, note.id)).status).toBe(404);
    // The operator reads the task and cannot ask for its draft, and is told no more of a task
    // that would be refused than a stranger is.
    expect((await detailOf(carol, location.id)).tasks).toHaveLength(2);
    expect((await ask(carol, location.id, note.id)).status).toBe(404);
    expect((await ask(carol, location.id, listing.id)).status).toBe(404);
    expect((await ask(dave, location.id, listing.id)).status).toBe(404);
    expect(db.drafts).toEqual([]);
    expect(queued).toEqual([]);
  });

  it("refuses a task with no wording to write, and one that is not this location's", async () => {
    const { location, listing } = await withTasks();
    expect(listing.draft_kind).toBeNull();
    const none = await ask(alice, location.id, listing.id);
    expect(none.status).toBe(409);
    expect(await errorCode(none)).toBe("no_draft");
    expect((await ask(alice, location.id, crypto.randomUUID())).status).toBe(404);
    expect(db.drafts).toEqual([]);
  });

  it("refuses until the location has said what the business does", async () => {
    const { location, note } = await withTasks({ said: null });
    const refused = await ask(alice, location.id, note.id);
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("what_we_do_missing");

    await call(alice, "PATCH", `/locations/${location.id}`, {
      name: location.name,
      city: location.city,
      what_we_do: SAID,
    });
    await asked(alice, location.id, note.id);
  });

  it("refuses on a plan that includes none", async () => {
    const { location, note } = await withTasks({ drafts: null });
    const none = await ask(alice, location.id, note.id);
    expect(none.status).toBe(409);
    expect(await errorCode(none)).toBe("limit_reached");
    expect((await detailOf(alice, location.id)).drafts.allowed).toBeNull();
    expect(db.drafts).toEqual([]);
  });

  it("refuses real data where nothing here can write a real draft", async () => {
    env.PROVIDER_MODE = "live";
    const { location, note } = await withTasks();
    const refused = await ask(alice, location.id, note.id);
    expect(refused.status).toBe(503);
    expect(await errorCode(refused)).toBe("drafts_unavailable");
    expect(db.drafts).toEqual([]);
  });
});

describe("writing a draft", () => {
  it("writes sample text from what was given, keeps it and counts it", async () => {
    const { organization, location, note } = await withTasks();
    const draft = await asked(alice, location.id, note.id);

    expect(await writeDraft(draft.id, { store: worker(), sampleData: true })).toBe("written");
    const written = await draftOf(location.id, note.id);
    expect(written).toMatchObject({ status: "written", kind: "note", sample_data: true });
    expect(written?.text).toContain("Joe's Pizza in Raleigh, NC");
    expect(written?.text).toContain(SAID);
    expect(written?.text).toContain(GUIDE);
    expect(written?.text).toContain("https://joespizza.example");
    expect(written?.written_at).not.toBeNull();
    // Sample text is nobody's writing, so no model is named for it.
    expect(db.drafts[0]?.model).toBeNull();

    expect(await used(organization.id)).toEqual({ drafts: 1 });
    expect((await detailOf(alice, location.id)).drafts).toMatchObject({ allowed: 2, used: 1 });
  });

  it("is written once: reading it again, or a second message, writes nothing", async () => {
    const { organization, location, note } = await withTasks();
    const draft = await asked(alice, location.id, note.id);
    const writer = writing("Hello from Joe's Pizza.");
    const deps = { store: worker(), sampleData: false, writer };
    // On real data in these tests, so the writer is the one called.
    db.scans.forEach((scan) => {
      scan.sample_data = false;
    });

    expect(await writeDraft(draft.id, deps)).toBe("written");
    expect(await writeDraft(draft.id, deps)).toBe("busy");
    await detailOf(alice, location.id);
    await detailOf(bob, location.id);
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(await used(organization.id)).toEqual({ drafts: 1 });
    expect(await draftOf(location.id, note.id)).toMatchObject({
      text: "Hello from Joe's Pizza.",
      sample_data: false,
    });
    expect(db.drafts[0]?.model).toBe("test-model");
  });

  it("gives the writer what the location holds and the page, and nothing else", async () => {
    const { location, note } = await withTasks();
    const draft = await asked(alice, location.id, note.id);
    const writer = writing("Hello.");
    db.scans.forEach((scan) => {
      scan.sample_data = false;
    });

    await writeDraft(draft.id, { store: worker(), sampleData: false, writer });
    expect(writer.write).toHaveBeenCalledWith(
      {
        kind: "note",
        given: {
          name: "Joe's Pizza",
          city: "Raleigh",
          region: "NC",
          category: null,
          website: "https://joespizza.example",
          what_we_do: SAID,
          host: "travel.usnews.com",
          url: GUIDE,
        },
      },
      expect.any(Function),
    );
  });

  it("writes it again when asked, in place of the first, and counts one more", async () => {
    const { organization, location, note } = await withTasks();
    const deps = { store: worker(), sampleData: true };
    const first = await asked(alice, location.id, note.id);
    await writeDraft(first.id, deps);
    const before = await draftOf(location.id, note.id);

    const again = await asked(bob, location.id, note.id);
    expect(again.id).toBe(first.id);
    // The one that was written stays to be read while the next is on its way.
    expect(again).toMatchObject({ status: "asked", text: before?.text });
    expect(await writeDraft(again.id, deps)).toBe("written");
    expect(await used(organization.id)).toEqual({ drafts: 2 });
    expect(db.drafts).toHaveLength(1);

    // The month is used, and what was written is still there.
    const refused = await ask(alice, location.id, note.id);
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("limit_reached");
    expect(await draftOf(location.id, note.id)).toMatchObject({ status: "written" });
  });

  it("writes sample text for a test organization in a live deployment, with no model", async () => {
    env.PROVIDER_MODE = "live";
    db.testAccounts.add(alice);
    // A test organization is given every kind of allowance when it is made.
    const { location, note } = await withTasks({ drafts: "as made" });
    const draft = await asked(alice, location.id, note.id);
    const writer = writing("A model wrote this.");

    expect(await writeDraft(draft.id, { store: worker(), sampleData: false, writer })).toBe(
      "written",
    );
    expect(writer.write).not.toHaveBeenCalled();
    expect(await draftOf(location.id, note.id)).toMatchObject({ sample_data: true });
  });
});

describe("a draft that states what nobody gave", () => {
  const MADE_UP = "Call Joe's Pizza on 919-555-0100 or see joespizza.example/menu.";
  const CLEAN = "Joe's Pizza has made wood-fired pizza since 1998.";

  /** A task with a draft asked for, on real data, so the writer given is the one that writes. */
  async function askedOnRealData() {
    const made = await withTasks();
    db.scans.forEach((scan) => {
      scan.sample_data = false;
    });
    return { ...made, draft: await asked(alice, made.location.id, made.note.id) };
  }

  it("is thrown away and written once more", async () => {
    const { organization, location, note, draft } = await askedOnRealData();
    const writer = writing(MADE_UP, CLEAN);

    expect(await writeDraft(draft.id, { store: worker(), sampleData: false, writer })).toBe(
      "written",
    );
    expect(writer.write).toHaveBeenCalledTimes(2);
    expect((await draftOf(location.id, note.id))?.text).toBe(CLEAN);
    // Two writes, one draft.
    expect(await used(organization.id)).toEqual({ drafts: 1 });
  });

  it("is not kept when the second states something too, and is not counted", async () => {
    const { organization, location, note, draft } = await askedOnRealData();
    const writer = writing(MADE_UP);

    expect(await writeDraft(draft.id, { store: worker(), sampleData: false, writer })).toBe(
      "failed",
    );
    expect(writer.write).toHaveBeenCalledTimes(2);
    const kept = await draftOf(location.id, note.id);
    expect(kept).toMatchObject({ status: "failed", text: null });
    expect(kept?.failure).toMatch(/nobody gave/);
    expect(await used(organization.id)).toEqual({ drafts: 0 });
  });

  it("leaves the draft from before where it was", async () => {
    const { organization, location, note, draft } = await askedOnRealData();
    await writeDraft(draft.id, { store: worker(), sampleData: false, writer: writing(CLEAN) });
    const again = await asked(alice, location.id, note.id);

    await writeDraft(again.id, { store: worker(), sampleData: false, writer: writing(MADE_UP) });
    expect(await draftOf(location.id, note.id)).toMatchObject({ status: "failed", text: CLEAN });
    // The first is still counted. The second gave back what it took.
    expect(await used(organization.id)).toEqual({ drafts: 1 });
  });

  it("is not kept when it is empty", async () => {
    const { organization, draft } = await askedOnRealData();
    const outcome = await writeDraft(draft.id, {
      store: worker(),
      sampleData: false,
      writer: writing("  \n "),
    });
    expect(outcome).toBe("failed");
    expect(await used(organization.id)).toEqual({ drafts: 0 });
  });
});

describe("a draft that could not be written", () => {
  it("says so and is not counted, when the writer fails", async () => {
    const { organization, location, note } = await withTasks();
    db.scans.forEach((scan) => {
      scan.sample_data = false;
    });
    const draft = await asked(alice, location.id, note.id);
    const writer: DraftWriter = {
      model: "test-model",
      kinds: DRAFT_KINDS,
      write: async () => {
        throw new Error("The model is down.");
      },
    };

    expect(await writeDraft(draft.id, { store: worker(), sampleData: false, writer })).toBe(
      "failed",
    );
    const kept = await draftOf(location.id, note.id);
    expect(kept).toMatchObject({ status: "failed", text: null });
    // The reader is told it failed, not what the model said about it.
    expect(kept?.failure).not.toMatch(/down/);
    expect(await used(organization.id)).toEqual({ drafts: 0 });
    // It can be asked for again.
    await asked(alice, location.id, note.id);
  });

  it("is failed where nothing here can write a real draft", async () => {
    const { organization, location, note } = await withTasks();
    const draft = await asked(alice, location.id, note.id);

    expect(await writeDraft(draft.id, { store: worker(), sampleData: false })).toBe("failed");
    expect((await draftOf(location.id, note.id))?.failure).toBe(
      "Drafts cannot be written here yet.",
    );
    expect(await used(organization.id)).toEqual({ drafts: 0 });
  });

  it("is failed when the month ran out between the ask and the writing", async () => {
    const { organization, location, note } = await withTasks({ drafts: 1 });
    const draft = await asked(alice, location.id, note.id);
    // Something else took the month's last one in the meantime.
    await worker().claimAllowance(organization.id, "drafts");

    expect(await writeDraft(draft.id, { store: worker(), sampleData: true })).toBe("busy");
    expect(await draftOf(location.id, note.id)).toMatchObject({
      status: "failed",
      failure: "Your plan has no more drafts this month.",
    });
    expect(await used(organization.id)).toEqual({ drafts: 1 });
  });

  it("is failed when the task changed under it: what the business does was taken away", async () => {
    const { organization, location, note } = await withTasks();
    const draft = await asked(alice, location.id, note.id);
    await call(alice, "PATCH", `/locations/${location.id}`, {
      name: location.name,
      city: location.city,
      what_we_do: "",
    });

    expect(await writeDraft(draft.id, { store: worker(), sampleData: true })).toBe("failed");
    expect((await draftOf(location.id, note.id))?.failure).toMatch(/what the business does/);
    expect(await used(organization.id)).toEqual({ drafts: 0 });
  });

  it("is failed when the task is no longer one to write for", async () => {
    const { organization, location, note } = await withTasks();
    const draft = await asked(alice, location.id, note.id);
    await call(alice, "PATCH", `/recommendations/${note.id}`, { status: "dismissed" });

    expect(await writeDraft(draft.id, { store: worker(), sampleData: true })).toBe("failed");
    expect(db.drafts[0]).toMatchObject({
      status: "failed",
      failure: "This task has no draft to write.",
    });
    expect(await used(organization.id)).toEqual({ drafts: 0 });
  });

  it("is tried again when something else gets in the way, three times in all, holding one of the month", async () => {
    const { organization, location, note } = await withTasks();
    const draft = await asked(alice, location.id, note.id);
    const broken: Store = {
      ...worker(),
      getLocation: async () => {
        throw new Error("The database is down.");
      },
    };
    const deps = { store: broken, sampleData: true };

    expect(await writeDraft(draft.id, deps)).toBe("again");
    // It holds its one from the month, and does not take a second on the next try.
    expect(await used(organization.id)).toEqual({ drafts: 1 });
    expect(await writeDraft(draft.id, deps)).toBe("again");
    expect(await used(organization.id)).toEqual({ drafts: 1 });
    expect(await draftOf(location.id, note.id)).toMatchObject({ status: "asked" });

    expect(await writeDraft(draft.id, deps)).toBe("failed");
    expect(await draftOf(location.id, note.id)).toMatchObject({ status: "failed" });
    expect(await used(organization.id)).toEqual({ drafts: 0 });
  });

  it("has nothing to do for a draft nobody is asking for", async () => {
    await withTasks();
    expect(await writeDraft(crypto.randomUUID(), { store: worker(), sampleData: true })).toBe(
      "busy",
    );
  });
});

describe("what a draft used", () => {
  const MADE_UP = "Call Joe's Pizza on 919-555-0100.";
  const CLEAN = "Joe's Pizza has made wood-fired pizza since 1998.";

  async function askedOnRealData() {
    const made = await withTasks();
    db.scans.forEach((scan) => {
      scan.sample_data = false;
    });
    return { ...made, draft: await asked(alice, made.location.id, made.note.id) };
  }
  const row = (organizationId: string, draftId: string) => ({
    organization_id: organizationId,
    draft_id: draftId,
    surface: null,
    calls: 1,
    ...CALL,
    created_at: expect.any(String),
  });

  it("is recorded for its organization, as the model that answered reported it", async () => {
    const { organization, draft } = await askedOnRealData();
    await writeDraft(draft.id, { store: worker(), sampleData: false, writer: charged(CLEAN) });
    expect(db.usage).toEqual([row(organization.id, draft.id)]);
  });

  it("is recorded for a draft that was thrown away, since it was still paid for", async () => {
    const { organization, draft } = await askedOnRealData();
    const writer = charged(MADE_UP);
    expect(await writeDraft(draft.id, { store: worker(), sampleData: false, writer })).toBe(
      "failed",
    );
    // Two writes, neither kept, both charged. The month was given back; the money was not.
    expect(db.usage).toEqual([row(organization.id, draft.id), row(organization.id, draft.id)]);
    expect(await used(organization.id)).toEqual({ drafts: 0 });
  });

  it("is recorded for a call that was charged and then failed", async () => {
    const { organization, draft } = await askedOnRealData();
    const writer = charged(new Error("Claude did not finish the draft."));
    expect(await writeDraft(draft.id, { store: worker(), sampleData: false, writer })).toBe(
      "failed",
    );
    expect(db.usage).toEqual([row(organization.id, draft.id)]);
  });

  it("is nothing for sample text", async () => {
    const { location, note } = await withTasks();
    const draft = await asked(alice, location.id, note.id);
    await writeDraft(draft.id, { store: worker(), sampleData: true, writer: charged(CLEAN) });
    expect(db.usage).toEqual([]);
  });

  it("does not stop the draft being kept when the record cannot be", async () => {
    const { location, note, draft } = await askedOnRealData();
    const store: Store = {
      ...worker(),
      recordUsage: async () => {
        throw new Error("The database is down.");
      },
    };
    expect(await writeDraft(draft.id, { store, sampleData: false, writer: charged(CLEAN) })).toBe(
      "written",
    );
    expect(await draftOf(location.id, note.id)).toMatchObject({ status: "written", text: CLEAN });
  });

  it("shows in the operator's spend, in its organization's month", async () => {
    const { organization, draft } = await askedOnRealData();
    await writeDraft(draft.id, { store: worker(), sampleData: false, writer: charged(CLEAN) });
    db.operators.add(carol);

    const spend = OperatorSpendSchema.parse(
      await (await priced.request("/api/operator/spend", bearer(carol), env)).json(),
    );
    // 400 input tokens at $5 a million and 150 output at $20: $0.002 and $0.003.
    expect(spend.months[0]?.organizations).toEqual([
      {
        organization_id: organization.id,
        name: "Raleigh Pizza Group",
        is_yours: false,
        cost: 0.005,
      },
    ]);
    expect(spend.months[0]?.unpriced).toEqual([]);
  });
});

describe("a real draft", () => {
  /** A build with the private tuning: it has instructions for a note. */
  const live = () => {
    env.PROVIDER_MODE = "live";
    return (user: string, locationId: string, taskId: string) =>
      priced.request(
        `/api/locations/${locationId}/tasks/${taskId}/draft`,
        { ...bearer(user), method: "POST" },
        env,
      );
  };

  it("can be asked for where the build has instructions for its kind and a key to ask with", async () => {
    const askLive = live();
    env.ANTHROPIC_API_KEY = "test-key";
    const { location, note } = await withTasks();
    const response = await askLive(alice, location.id, note.id);
    expect(response.status).toBe(202);
    expect(queued).toHaveLength(1);
  });

  it("is refused where there is no key, or no instructions for its kind", async () => {
    const askLive = live();
    const { location, note } = await withTasks();
    const noKey = await askLive(alice, location.id, note.id);
    expect(noKey.status).toBe(503);
    expect(await errorCode(noKey)).toBe("drafts_unavailable");

    // A key, and a build without the private tuning: the placeholder is never written with.
    env.ANTHROPIC_API_KEY = "test-key";
    const noWording = await ask(alice, location.id, note.id);
    expect(noWording.status).toBe(503);
    expect(db.drafts).toEqual([]);
  });

  it("is failed by the worker where its writer has no instructions for the kind", async () => {
    const { organization, location, note } = await withTasks();
    db.scans.forEach((scan) => {
      scan.sample_data = false;
    });
    const draft = await asked(alice, location.id, note.id);
    const writer: DraftWriter = { ...charged("Hello."), kinds: [] };

    expect(await writeDraft(draft.id, { store: worker(), sampleData: false, writer })).toBe(
      "failed",
    );
    expect((await draftOf(location.id, note.id))?.failure).toBe(
      "Drafts cannot be written here yet.",
    );
    expect(db.usage).toEqual([]);
    expect(await used(organization.id)).toEqual({ drafts: 0 });
  });

  it("is never asked of a model on sample data, whatever writer is to hand", async () => {
    const { location, note } = await withTasks();
    const draft = await asked(alice, location.id, note.id);
    const writer = writing("A model wrote this.");
    await writeDraft(draft.id, { store: worker(), sampleData: true, writer });
    expect(writer.write).not.toHaveBeenCalled();
    expect(await draftOf(location.id, note.id)).toMatchObject({ sample_data: true });
  });
});

describe("a draft nobody is writing", () => {
  it("is queued again once it has waited fifteen minutes, and not before", async () => {
    const { location, note } = await withTasks();
    const draft = await asked(alice, location.id, note.id);
    queued = [];
    const at = Date.parse(draft.asked_at);

    expect(await requeueStalledDrafts(worker(), env.SCAN_QUEUE, at + 14 * MINUTE)).toBe(0);
    expect(await requeueStalledDrafts(worker(), env.SCAN_QUEUE, at + 16 * MINUTE)).toBe(1);
    expect(queued).toEqual([{ draft_id: draft.id, step: "write" }]);
  });

  it("is left alone while a worker is on it, and taken up again if that worker died", async () => {
    const { location, note } = await withTasks();
    const draft = await asked(alice, location.id, note.id);
    queued = [];
    const at = Date.parse(draft.asked_at);

    // A worker takes it twenty minutes later and is never heard from again.
    db.now = new Date(at + 20 * MINUTE).toISOString();
    expect(await worker().claimDraft(draft.id)).toBe(1);
    expect(await requeueStalledDrafts(worker(), env.SCAN_QUEUE, at + 25 * MINUTE)).toBe(0);
    // A second worker does not take what the first still holds.
    db.now = new Date(at + 25 * MINUTE).toISOString();
    expect(await worker().claimDraft(draft.id)).toBe(0);

    expect(await requeueStalledDrafts(worker(), env.SCAN_QUEUE, at + 36 * MINUTE)).toBe(1);
    db.now = new Date(at + 36 * MINUTE).toISOString();
    expect(await worker().claimDraft(draft.id)).toBe(2);
  });

  it("is not one that was written or failed", async () => {
    const { location, note } = await withTasks();
    const draft = await asked(alice, location.id, note.id);
    await writeDraft(draft.id, { store: worker(), sampleData: true });
    queued = [];

    const later = Date.parse(draft.asked_at) + 60 * MINUTE;
    expect(await requeueStalledDrafts(worker(), env.SCAN_QUEUE, later)).toBe(0);
    expect(queued).toEqual([]);
  });
});
