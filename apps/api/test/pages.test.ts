import {
  type DraftMessage,
  DraftSchema,
  LocationDetailSchema,
  LocationSchema,
  OrganizationSchema,
  PromptPageSchema,
  pageRule,
  type Surface,
  TrackedQuerySchema,
} from "@nearcited/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { writeDraft } from "../src/drafts";
import type { DraftWriter } from "../src/drafts/sample";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const carol = "c0000000-0000-4000-8000-000000000003";
const dave = "d0000000-0000-4000-8000-000000000004";

const SAID = "Wood-fired pizza and fresh pasta, family-run since 1998.";
const PROMPT = "late night pizza delivery";
const PAGE = "https://joespizza.example/late-night-pizza-delivery-raleigh";
const ASSISTANTS: Surface[] = ["chatgpt", "gemini", "perplexity", "claude"];

let db: MemoryDb;
let queued: DraftMessage[];
let env: Env;

const authenticate = async (request: Request) => {
  const userId = request.headers.get("Authorization")?.replace("Bearer ", "");
  return userId
    ? { user: { id: userId, email: `${userId}@example.com` }, store: memoryStore(db, userId) }
    : null;
};
const app = createApp({ authenticate, publicStore: () => memoryStore(db, "nobody") });
/** A build whose private tuning has instructions for notes and not for pages. */
const notesOnly = createApp({
  authenticate,
  publicStore: () => memoryStore(db, "nobody"),
  deployment: { models: {}, rates: {}, draft_kinds: ["note"] },
});

function call(user: string | null, method: string, path: string, body?: unknown, on = app) {
  return on.request(
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

const worker = () => memoryStore(db, null);
const detailOf = async (user: string, locationId: string, on = app) =>
  LocationDetailSchema.parse(
    await (await call(user, "GET", `/locations/${locationId}`, undefined, on)).json(),
  );

/**
 * Alice's organization with Bob in it, two drafts a month, and a location whose scan asked its
 * prompt of four assistants. None of them named the business, so it has a page task.
 */
async function withPage({ named = false } = {}) {
  const organization = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  db.memberships.push({ organization_id: organization.id, user_id: bob, role: "member" });
  db.emails.set(alice, "alice@example.com");
  const kept = db.organizations.find((candidate) => candidate.id === organization.id);
  if (kept) Object.assign(kept, { max_locations: 1, allowances: { drafts: 2 } });

  const location = LocationSchema.parse(
    await (
      await call(alice, "POST", `/organizations/${organization.id}/locations`, {
        name: "Joe's Pizza",
        city: "Raleigh",
        region: "NC",
        phone: "+1 919 555 0100",
        website: "joespizza.example",
        what_we_do: SAID,
      })
    ).json(),
  );
  const query = TrackedQuerySchema.parse(
    await (
      await call(alice, "POST", `/locations/${location.id}/queries`, {
        kind: "ai_prompt",
        text: PROMPT,
      })
    ).json(),
  );

  const scan = await worker().createScan(location.id, "scheduled", null);
  await worker().markScanRunning(scan.id, true);
  await worker().completeScan(scan.id, {
    score: 0,
    results: ASSISTANTS.map((surface, index) => ({
      tracked_query_id: query.id,
      surface,
      mentioned: named && index === 0,
      position: null,
      competitors: [],
      cited_urls: index === 1 ? [PAGE] : [],
      answer_excerpt: null,
      phones: [],
    })),
    recommendations: named
      ? []
      : [{ rule: pageRule(query.id), title: "Publish a page", detail: "Detail" }],
  });
  return { organization, location, query };
}

const pageTasksOf = async (user: string, locationId: string, on = app) =>
  (await detailOf(user, locationId, on)).page_tasks;

const setPage = (user: string | null, locationId: string, taskId: string, url = PAGE) =>
  call(user, "PUT", `/locations/${locationId}/tasks/${taskId}/page`, { url });
const removePage = (user: string | null, locationId: string, taskId: string) =>
  call(user, "DELETE", `/locations/${locationId}/tasks/${taskId}/page`);

beforeEach(() => {
  db = createMemoryDb();
  queued = [];
  env = {
    PROVIDER_MODE: "mock",
    SCAN_QUEUE: {
      send: async (message: DraftMessage) => {
        queued.push(message);
      },
      sendBatch: async (messages: { body: DraftMessage }[]) => {
        queued.push(...messages.map((message) => message.body));
      },
    },
  } as unknown as Env;
});

describe("a page task", () => {
  it("is on the location for a prompt no answer named the business for, with the counts", async () => {
    const { location, query } = await withPage();
    const [task, ...others] = await pageTasksOf(bob, location.id);
    expect(others).toEqual([]);
    expect(task).toMatchObject({
      tracked_query_id: query.id,
      prompt: PROMPT,
      title: `Publish a page that answers “${PROMPT}”`,
      summary:
        "None of the 4 assistant answers to this prompt in the latest scans named Joe's Pizza.",
      open: true,
      acted_at: null,
      before: null,
      since: null,
      draft_kind: "page",
      draft: null,
      page: null,
    });
    // It is not listed again among the other recommendations: the Website tab shows it.
    expect((await detailOf(bob, location.id)).tasks).toEqual([]);
  });

  it("offers no copy where this build cannot write a page on real data", async () => {
    const { location } = await withPage();
    env = { ...env, PROVIDER_MODE: "live", ANTHROPIC_API_KEY: "key" } as Env;
    db.scans.forEach((scan) => {
      scan.sample_data = false;
    });
    const [task] = await pageTasksOf(alice, location.id, notesOnly);
    expect(task?.draft_kind).toBeNull();
    const refused = await call(
      alice,
      "POST",
      `/locations/${location.id}/tasks/${task?.id}/draft`,
      undefined,
      notesOnly,
    );
    expect(refused.status).toBe(503);
  });

  it("counts, once it is marked, the answers to its prompt before and since, and those citing the page", async () => {
    const { location } = await withPage();
    const [task] = await pageTasksOf(alice, location.id);
    if (!task) throw new Error("no page task");
    expect(
      (await call(alice, "PATCH", `/recommendations/${task.id}`, { acted: true })).status,
    ).toBe(200);
    expect((await setPage(alice, location.id, task.id)).status).toBe(200);

    const [marked] = await pageTasksOf(alice, location.id);
    // The one scan was made before the mark, so every answer is before it.
    expect(marked?.before).toEqual({ answers: 4, named: 0, cited: 1 });
    expect(marked?.since).toEqual({ answers: 0, named: 0, cited: 0 });
    expect(marked?.page).toEqual({
      recommendation_id: task.id,
      url: PAGE,
      set_by_email: "alice@example.com",
      set_at: expect.any(String),
    });
  });
});

describe("the copy for a page", () => {
  it("is asked for as any draft is, and written from the location and the prompt", async () => {
    const { organization, location } = await withPage();
    const [task] = await pageTasksOf(alice, location.id);
    if (!task) throw new Error("no page task");

    const response = await call(bob, "POST", `/locations/${location.id}/tasks/${task.id}/draft`);
    expect(response.status).toBe(202);
    const draft = DraftSchema.parse(await response.json());
    expect(queued).toEqual([{ draft_id: draft.id, step: "write" }]);

    const writer: DraftWriter & { write: ReturnType<typeof vi.fn> } = {
      model: "test-model",
      kinds: ["page"],
      write: vi.fn(async () => "Late night pizza in Raleigh\n\nWe make wood-fired pizza."),
    };
    db.scans.forEach((scan) => {
      scan.sample_data = false;
    });
    expect(await writeDraft(draft.id, { store: worker(), sampleData: false, writer })).toBe(
      "written",
    );
    expect(writer.write).toHaveBeenCalledWith(
      {
        kind: "page",
        given: {
          name: "Joe's Pizza",
          city: "Raleigh",
          region: "NC",
          category: null,
          website: "https://joespizza.example",
          what_we_do: SAID,
          host: "joespizza.example",
          url: null,
          prompt: PROMPT,
        },
      },
      expect.any(Function),
    );
    expect(await worker().getAllowanceUse(organization.id)).toEqual({ drafts: 1 });
    const [written] = await pageTasksOf(alice, location.id);
    expect(written?.draft).toMatchObject({
      kind: "page",
      text: "Late night pizza in Raleigh\n\nWe make wood-fired pizza.",
    });
  });

  it("is sample text on sample data, which states nothing nobody gave", async () => {
    const { location } = await withPage();
    const [task] = await pageTasksOf(alice, location.id);
    const draft = DraftSchema.parse(
      await (await call(alice, "POST", `/locations/${location.id}/tasks/${task?.id}/draft`)).json(),
    );
    expect(await writeDraft(draft.id, { store: worker(), sampleData: true })).toBe("written");
    const [written] = await pageTasksOf(alice, location.id);
    expect(written?.draft).toMatchObject({ kind: "page", sample_data: true });
    expect(written?.draft?.text?.split("\n")[0]).toContain(PROMPT);
  });

  it("is refused once an answer to the prompt names the business, as the task is gone", async () => {
    const { location } = await withPage({ named: true });
    expect(await pageTasksOf(alice, location.id)).toEqual([]);
  });
});

describe("where a page is", () => {
  it("is given by a member, replaced, and taken away", async () => {
    const { location } = await withPage();
    const [task] = await pageTasksOf(alice, location.id);
    if (!task) throw new Error("no page task");

    const set = await setPage(bob, location.id, task.id, "joespizza.example/late-night#top");
    expect(set.status).toBe(200);
    expect(PromptPageSchema.parse(await set.json()).url).toBe(
      "https://joespizza.example/late-night",
    );
    expect((await setPage(alice, location.id, task.id)).status).toBe(200);
    expect(db.promptPages.map((page) => page.url)).toEqual([PAGE]);

    expect((await removePage(alice, location.id, task.id)).status).toBe(204);
    expect((await removePage(alice, location.id, task.id)).status).toBe(404);
    expect(db.promptPages).toEqual([]);
  });

  it("is a page of the location's own website, and not its home page", async () => {
    const { location } = await withPage();
    const [task] = await pageTasksOf(alice, location.id);
    if (!task) throw new Error("no page task");
    for (const url of [
      "https://elsewhere.example/late-night",
      "https://joespizza.example/",
      "javascript:alert(1)",
    ]) {
      expect((await setPage(alice, location.id, task.id, url)).status, url).toBe(422);
    }
    expect(db.promptPages).toEqual([]);
  });

  it("is only for a page task", async () => {
    const { location } = await withPage();
    const source = db.recommendations.find(
      (recommendation) => recommendation.location_id === location.id,
    );
    if (!source) throw new Error("no recommendation");
    const other = {
      ...source,
      id: "e0000000-0000-4000-8000-000000000005",
      rule: "source:yelp.com",
    };
    db.recommendations.push(other);
    expect((await setPage(alice, location.id, other.id)).status).toBe(404);
    // Nor, by the function itself, for a member asking through the store.
    expect(await memoryStore(db, alice).setPromptPage(other.id, PAGE)).toBeNull();
    const nowhere = "00000000-0000-4000-8000-000000000000";
    expect((await setPage(alice, location.id, nowhere)).status).toBe(404);
  });

  it("answers nobody outside the organization, and not the operator", async () => {
    const { location } = await withPage();
    const [task] = await pageTasksOf(alice, location.id);
    if (!task) throw new Error("no page task");
    await setPage(alice, location.id, task.id);

    expect((await setPage(carol, location.id, task.id, `${PAGE}-2`)).status).toBe(404);
    expect((await removePage(carol, location.id, task.id)).status).toBe(404);
    expect((await setPage(null, location.id, task.id)).status).toBe(401);

    db.operators.add(dave);
    expect((await pageTasksOf(dave, location.id))[0]?.page?.url).toBe(PAGE);
    expect((await setPage(dave, location.id, task.id, `${PAGE}-2`)).status).toBe(404);
    expect((await removePage(dave, location.id, task.id)).status).toBe(404);
    expect(db.promptPages.map((page) => page.url)).toEqual([PAGE]);
  });
});
