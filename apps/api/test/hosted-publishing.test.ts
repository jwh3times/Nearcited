import {
  type ActionMessage,
  ActionSchema,
  AnswerSubdomainSchema,
  type ConnectionMessage,
  INDEXNOW_KEY,
  LocationActionsSchema,
  LocationDetailSchema,
  LocationSchema,
  OrganizationSchema,
  pageRule,
  TrackedQuerySchema,
} from "@nearcited/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { carryOutAction, connectionToPublishWith, proposeAfterSync } from "../src/actions";
import { createApp } from "../src/app";
import {
  expirePausedConnections,
  expireUnclaimedAnswerSubdomains,
  removeConnection,
  tellPausedAnswerSubdomains,
} from "../src/connections";
import type { Email } from "../src/email/report";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";

const HOST = "answers.joespizza.example";
const COPY =
  "Late night pizza in Raleigh\n\nWe make wood-fired pizza until late.\n\n## Where we are\n\nRaleigh, NC.";

/** Every notice sent to IndexNow, and whether it is answered as accepted. */
let notices: { host: string; key: string; keyLocation: string; urlList: string[] }[];
let indexNowUp: boolean;

const outside: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  // Every name is free when the subdomain is set up.
  if (url.hostname === "cloudflare-dns.com") {
    return new Response(JSON.stringify({ Status: 0, Answer: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.href === "https://api.indexnow.org/indexnow") {
    notices.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: indexNowUp ? 200 : 503 });
  }
  return new Response("Not found", { status: 404 });
};

let db: MemoryDb;
let queued: (ActionMessage | ConnectionMessage)[];
let env: Env;

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

const worker = () => ({
  store: memoryStore(db, null),
  key: null,
  hosting: { cloudflare: { token: "t", zone: "z" }, sampleData: false },
});

/**
 * Joe's Pizza on a plan with hosted pages, a page task for its prompt, that task's copy written,
 * and its answer subdomain set up. `live` says whether the subdomain is served yet.
 */
async function withCopy({ copy = COPY as string | null, live = true } = {}) {
  const organization = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  db.memberships.push({ organization_id: organization.id, user_id: bob, role: "member" });
  db.emails.set(alice, "alice@example.com");
  db.emails.set(bob, "bob@example.com");
  const kept = db.organizations.find((candidate) => candidate.id === organization.id);
  if (kept) {
    Object.assign(kept, { max_locations: 1, allowances: { hosted_pages: true, drafts: 5 } });
  }
  const location = LocationSchema.parse(
    await (
      await call(alice, "POST", `/organizations/${organization.id}/locations`, {
        name: "Joe's Pizza",
        city: "Raleigh",
        region: "NC",
        phone: "919 555 0100",
        website: "https://www.joespizza.example",
      })
    ).json(),
  );
  const query = TrackedQuerySchema.parse(
    await (
      await call(alice, "POST", `/locations/${location.id}/queries`, {
        kind: "ai_prompt",
        text: "late night pizza",
      })
    ).json(),
  );
  const scan = await memoryStore(db, null).createScan(location.id, "scheduled", null);
  await memoryStore(db, null).markScanRunning(scan.id, false);
  await memoryStore(db, null).completeScan(scan.id, {
    score: 0,
    results: [],
    recommendations: [{ rule: pageRule(query.id), title: "Publish a page", detail: "Detail" }],
  });
  const task = db.recommendations.find((r) => r.rule === pageRule(query.id));
  if (!task) throw new Error("no page task");
  if (copy !== null) {
    db.drafts.push({
      id: crypto.randomUUID(),
      location_id: location.id,
      recommendation_id: task.id,
      status: "written",
      asked_by_email: "bob@example.com",
      asked_at: new Date().toISOString(),
      failure: null,
      kind: "page",
      text: copy,
      written_at: new Date().toISOString(),
      sample_data: false,
      attempts: 1,
      writing_since: null,
      allowance_month: null,
      model: "test-model",
    });
  }
  const subdomain = AnswerSubdomainSchema.parse(
    await (
      await call(alice, "POST", `/locations/${location.id}/hosted-pages`, { label: "answers" })
    ).json(),
  );
  if (live) {
    const row = db.answerSubdomains.find((made) => made.connection_id === subdomain.connection_id);
    if (row)
      Object.assign(row, {
        record: "ours",
        registered_at: "2026-10-16T00:00:00Z",
        live_at: "2026-10-16T00:00:00Z",
      });
  }
  queued = [];
  return { location, connection: subdomain.connection_id, task };
}

const waitingOf = async (locationId: string) =>
  LocationActionsSchema.parse(
    await (await call(bob, "GET", `/locations/${locationId}/actions`)).json(),
  ).waiting;
const pageTaskOf = async (locationId: string) =>
  LocationDetailSchema.parse(await (await call(bob, "GET", `/locations/${locationId}`)).json())
    .page_tasks[0];

beforeEach(() => {
  db = createMemoryDb();
  queued = [];
  notices = [];
  indexNowUp = true;
  env = {
    PROVIDER_MODE: "live",
    CONNECTIONS_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
    CLOUDFLARE_HOSTNAMES_TOKEN: "t",
    CLOUDFLARE_ZONE_ID: "z",
    RESEND_API_KEY: "re_test",
    SCAN_QUEUE: {
      send: async (message: ActionMessage | ConnectionMessage) => {
        queued.push(message);
      },
      sendBatch: async (messages: { body: ActionMessage | ConnectionMessage }[]) => {
        queued.push(...messages.map((message) => message.body));
      },
    },
  } as unknown as Env;
  vi.stubGlobal("fetch", outside);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("proposing to publish a page on the answer subdomain", () => {
  it("offers the task's copy once the subdomain is live, once", async () => {
    const { connection, location } = await withCopy();
    expect(await proposeAfterSync(connection, worker())).toBe(1);
    const [proposal] = await waitingOf(location.id);
    expect(proposal).toMatchObject({
      kind: "hosted_page",
      summary: `Publish the page “Late night pizza in Raleigh” at ${HOST}`,
      seen: { text: null },
      proposed_text: COPY,
      written_by: "model",
    });
    expect(await proposeAfterSync(connection, worker())).toBe(0);
  });

  it("offers nothing before the subdomain is live, or without the copy", async () => {
    const notLive = await withCopy({ live: false });
    expect(await proposeAfterSync(notLive.connection, worker())).toBe(0);
    db = createMemoryDb();
    const noCopy = await withCopy({ copy: null });
    expect(await proposeAfterSync(noCopy.connection, worker())).toBe(0);
  });

  it("offers nothing once the website has moved to another domain", async () => {
    const { connection, location } = await withCopy();
    const kept = db.locations.find((candidate) => candidate.id === location.id);
    if (kept) kept.website = "https://joesnewplace.example";
    expect(await proposeAfterSync(connection, worker())).toBe(0);
  });

  it("offers nothing where a page is served at its address already", async () => {
    const { connection, location } = await withCopy();
    db.hostedPages.push({
      id: crypto.randomUUID(),
      connection_id: connection,
      location_id: location.id,
      recommendation_id: null,
      action_id: null,
      slug: "late-night-pizza-in-raleigh",
      title: "Late night pizza in Raleigh",
      copy: "Late night pizza in Raleigh\n\nAnother page.",
      published_at: "2026-10-16T00:00:00Z",
      taken_back_at: null,
    });
    expect(await proposeAfterSync(connection, worker())).toBe(0);
  });

  it("offers nothing where a member has said where the task's page is", async () => {
    const { connection, location, task } = await withCopy();
    await call(bob, "PUT", `/locations/${location.id}/tasks/${task.id}/page`, {
      url: "https://www.joespizza.example/our-own-page",
    });
    expect(await proposeAfterSync(connection, worker())).toBe(0);
  });

  it("is asked for once the copy is written, by checking the subdomain again", async () => {
    const { connection } = await withCopy();
    const [draft] = db.drafts;
    expect(await connectionToPublishWith(memoryStore(db, null), draft?.id ?? "")).toBe(connection);
  });
});

describe("publishing a page on the answer subdomain", () => {
  async function approved(text?: string) {
    const scene = await withCopy();
    await proposeAfterSync(scene.connection, worker());
    const [proposal] = await waitingOf(scene.location.id);
    const response = await call(
      bob,
      "POST",
      `/actions/${proposal?.id}/approve`,
      text ? { text } : {},
    );
    expect(response.status).toBe(200);
    return { ...scene, proposal };
  }

  it("serves the copy as changed at the address its title makes, does the task, and tells IndexNow", async () => {
    const changed = `${COPY}\n\nOpen until 2am.`;
    const { location, task, proposal } = await approved(changed);
    expect(await carryOutAction(proposal?.id ?? "", worker())).toBe("done");

    expect(db.hostedPages).toHaveLength(1);
    expect(db.hostedPages[0]).toMatchObject({
      slug: "late-night-pizza-in-raleigh",
      title: "Late night pizza in Raleigh",
      copy: changed,
      action_id: proposal?.id,
      recommendation_id: task.id,
      taken_back_at: null,
    });
    const address = `https://${HOST}/late-night-pizza-in-raleigh`;
    expect((await pageTaskOf(location.id))?.page).toMatchObject({
      url: address,
      action_id: proposal?.id,
      set_by_email: null,
    });
    expect(db.recommendations.find((r) => r.id === task.id)).toMatchObject({
      acted_by_action: proposal?.id,
    });
    expect(notices).toEqual([
      {
        host: HOST,
        key: INDEXNOW_KEY,
        keyLocation: `https://${HOST}/${INDEXNOW_KEY}.txt`,
        urlList: [address],
      },
    ]);

    // A second delivery finds it served and writes nothing more.
    const action = db.actions.find((candidate) => candidate.id === proposal?.id);
    if (action) action.status = "approved";
    expect(await carryOutAction(proposal?.id ?? "", worker())).toBe("done");
    expect(db.hostedPages).toHaveLength(1);
  });

  it("writes nothing once the website has moved to another domain since it was approved", async () => {
    const { location, proposal } = await approved();
    const kept = db.locations.find((candidate) => candidate.id === location.id);
    if (kept) kept.website = "https://joesnewplace.example";
    expect(await carryOutAction(proposal?.id ?? "", worker())).toBe("out_of_date");
    expect(db.hostedPages).toEqual([]);
  });

  it("is approved and taken back by members of the organization alone", async () => {
    const stranger = "c0000000-0000-4000-8000-000000000003";
    const { proposal } = await approved();
    const action = db.actions.find((candidate) => candidate.id === proposal?.id);
    if (action) action.status = "proposed";
    expect((await call(stranger, "POST", `/actions/${proposal?.id}/approve`, {})).status).toBe(404);
    if (action) action.status = "approved";
    await carryOutAction(proposal?.id ?? "", worker());
    expect((await call(stranger, "POST", `/actions/${proposal?.id}/take-back`)).status).toBe(404);
    expect(db.hostedPages[0]?.taken_back_at).toBeNull();
  });

  it("publishes all the same when IndexNow does not answer", async () => {
    indexNowUp = false;
    const { proposal } = await approved();
    expect(await carryOutAction(proposal?.id ?? "", worker())).toBe("done");
    expect(db.hostedPages).toHaveLength(1);
  });

  it("writes nothing where another page is at that address now", async () => {
    const { connection, location, proposal } = await approved();
    db.hostedPages.push({
      id: crypto.randomUUID(),
      connection_id: connection,
      location_id: location.id,
      recommendation_id: null,
      action_id: null,
      slug: "late-night-pizza-in-raleigh",
      title: "Late night pizza in Raleigh",
      copy: "Late night pizza in Raleigh\n\nSomething else.",
      published_at: "2026-10-16T00:00:00Z",
      taken_back_at: null,
    });
    expect(await carryOutAction(proposal?.id ?? "", worker())).toBe("out_of_date");
    expect(db.hostedPages).toHaveLength(1);
  });
});

describe("taking a hosted page back", () => {
  it("marks it gone, forgets where it was, undoes the task's mark, and tells IndexNow", async () => {
    const scene = await withCopy();
    await proposeAfterSync(scene.connection, worker());
    const [first] = await waitingOf(scene.location.id);
    await call(bob, "POST", `/actions/${first?.id}/approve`, {});
    await carryOutAction(first?.id ?? "", worker());
    notices = [];

    const back = ActionSchema.parse(
      await (await call(bob, "POST", `/actions/${first?.id}/take-back`)).json(),
    );
    expect(back).toMatchObject({ kind: "hosted_page", proposed_text: null, seen: { text: COPY } });
    expect(await carryOutAction(back.id, worker())).toBe("done");
    expect(db.hostedPages[0]?.taken_back_at).not.toBeNull();
    expect(db.recommendations.find((r) => r.id === scene.task.id)).toMatchObject({
      acted_at: null,
      acted_by_action: null,
    });
    expect((await pageTaskOf(scene.location.id))?.page).toBeNull();
    expect(notices.map((notice) => notice.urlList)).toEqual([
      [`https://${HOST}/late-night-pizza-in-raleigh`],
    ]);
    // Delivered again, there is nothing left to take.
    const action = db.actions.find((candidate) => candidate.id === back.id);
    if (action) action.status = "approved";
    expect(await carryOutAction(back.id, worker())).toBe("done");
  });
});

describe("who fetched a hosted page", () => {
  it("shows each fetcher's reads of the task's page over the last thirty days, most first", async () => {
    const scene = await withCopy();
    await proposeAfterSync(scene.connection, worker());
    const [proposal] = await waitingOf(scene.location.id);
    await call(bob, "POST", `/actions/${proposal?.id}/approve`, {});
    await carryOutAction(proposal?.id ?? "", worker());
    const [page] = db.hostedPages;
    const day = (daysAgo: number) =>
      new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    db.pageFetches.push(
      {
        hosted_page_id: page?.id ?? "",
        location_id: scene.location.id,
        day: day(1),
        fetcher: "claudebot",
        count: 3,
      },
      {
        hosted_page_id: page?.id ?? "",
        location_id: scene.location.id,
        day: day(5),
        fetcher: "claudebot",
        count: 2,
      },
      {
        hosted_page_id: page?.id ?? "",
        location_id: scene.location.id,
        day: day(2),
        fetcher: "googlebot",
        count: 7,
      },
      // Too long ago to count.
      {
        hosted_page_id: page?.id ?? "",
        location_id: scene.location.id,
        day: day(40),
        fetcher: "gptbot",
        count: 9,
      },
    );
    expect((await pageTaskOf(scene.location.id))?.fetches).toEqual([
      { fetcher: "googlebot", count: 7, last_on: day(2) },
      { fetcher: "claudebot", count: 5, last_on: day(1) },
    ]);
  });
});

describe("winding down when the plan stops including hosted pages", () => {
  let sent: { to: string[]; email: Email }[];
  const telling = () => ({
    ...worker(),
    send: async (to: string[], email: Email) => {
      sent.push({ to, email });
    },
    appUrl: "https://nearcited.com",
  });
  beforeEach(() => {
    sent = [];
  });
  const pause = (connectionId: string, at: string) => {
    const kept = db.connections.find((connection) => connection.id === connectionId);
    if (kept) Object.assign(kept, { status: "paused", paused_at: at });
  };

  it("tells the owners once, with the day pages stop and the day the subdomain goes", async () => {
    const { connection, location } = await withCopy();
    pause(connection, "2026-09-01T09:00:00Z");
    expect(await tellPausedAnswerSubdomains(telling())).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(["alice@example.com"]);
    expect(sent[0]?.email.text).toContain(HOST);
    expect(sent[0]?.email.text).toContain("stay up until October 1, 2026");
    expect(sent[0]?.email.text).toContain("until December 30, 2026, when");
    expect(await tellPausedAnswerSubdomains(telling())).toBe(0);
    // Paused again after the plan came back, they are told again.
    const kept = db.connections.find((candidate) => candidate.id === connection);
    if (kept) Object.assign(kept, { status: "working", paused_at: null });
    const again = new Date(Date.now() + 60_000).toISOString();
    pause(connection, again);
    expect(await tellPausedAnswerSubdomains(telling())).toBe(1);
    // The card says so too.
    const card = await call(alice, "GET", `/locations/${location.id}/hosted-pages`);
    expect(
      ((await card.json()) as { subdomain: { status: string; paused_at: string } }).subdomain,
    ).toMatchObject({
      status: "paused",
      paused_at: again,
    });
  });

  it("lets go of one paused before it ever went live, as any that never started working, and tells nobody of pages", async () => {
    const { connection } = await withCopy({ live: false });
    const kept = db.connections.find((candidate) => candidate.id === connection);
    if (kept) kept.connected_at = new Date(Date.now() - 31 * 86_400_000).toISOString();
    pause(connection, new Date(Date.now() - 86_400_000).toISOString());
    expect(await tellPausedAnswerSubdomains(telling())).toBe(0);
    expect(await expireUnclaimedAnswerSubdomains(memoryStore(db, null), env.SCAN_QUEUE)).toBe(1);
  });

  it("still takes a page back while the paused subdomain serves it, and publishes nothing new", async () => {
    const scene = await withCopy();
    await proposeAfterSync(scene.connection, worker());
    const [first] = await waitingOf(scene.location.id);
    await call(bob, "POST", `/actions/${first?.id}/approve`, {});
    await carryOutAction(first?.id ?? "", worker());
    pause(scene.connection, new Date().toISOString());
    expect(await proposeAfterSync(scene.connection, worker())).toBe(0);
    // A publish approved before the pause does not go up.
    const waiting = db.actions.find((candidate) => candidate.id === first?.id);
    if (waiting) Object.assign(waiting, { status: "approved", attempts: 0 });
    db.hostedPages = [];
    expect(await carryOutAction(first?.id ?? "", worker())).toBe("failed");
    expect(db.hostedPages).toEqual([]);
    if (waiting) waiting.status = "done";
    await carryOutAction(first?.id ?? "", worker());
    db.hostedPages.push({
      id: crypto.randomUUID(),
      connection_id: scene.connection,
      location_id: scene.location.id,
      recommendation_id: scene.task.id,
      action_id: first?.id ?? null,
      slug: "late-night-pizza-in-raleigh",
      title: "Late night pizza in Raleigh",
      copy: COPY,
      published_at: "2026-10-16T00:00:00Z",
      taken_back_at: null,
    });
    const back = ActionSchema.parse(
      await (await call(bob, "POST", `/actions/${first?.id}/take-back`)).json(),
    );
    expect(await carryOutAction(back.id, worker())).toBe("done");
    expect(db.hostedPages[0]?.taken_back_at).not.toBeNull();
  });

  it("removes the subdomain only once the pages have sent visitors on for ninety days", async () => {
    const { connection } = await withCopy();
    const queue = env.SCAN_QUEUE;
    pause(connection, new Date(Date.now() - 31 * 86_400_000).toISOString());
    expect(await expirePausedConnections(memoryStore(db, null), queue)).toBe(0);
    pause(connection, new Date(Date.now() - 121 * 86_400_000).toISOString());
    expect(await expirePausedConnections(memoryStore(db, null), queue)).toBe(1);
    expect(await removeConnection(connection, telling())).toBe("removed");
    expect(sent[0]?.email.text).toContain("no longer includes hosted pages");
  });
});
