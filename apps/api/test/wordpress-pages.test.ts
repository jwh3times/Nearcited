import {
  type ActionMessage,
  ActionSchema,
  type ConnectionMessage,
  ConnectionSchema,
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
import { syncConnection } from "../src/connections";
import { sealingKey } from "../src/connections/seal";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";

const SITE = "https://joespizza.example";
const PASSWORD = "abcd EFGH 1234 ijkl MNOP 5678";
const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(11)));
const COPY =
  "Late night pizza in Raleigh\n\nWe make wood-fired pizza until late.\n\n## Where we are\n\nRaleigh, NC.";

/** A page of the made-up site. */
interface Page {
  id: number;
  slug: string;
  title: string;
  content: string;
  status: "publish" | "trash";
}

/** A made-up WordPress whose home page is its latest posts, answering as WordPress 6.9 did. */
let pages: Page[];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const wordpress: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const signedIn =
    new Headers(init?.headers).get("Authorization") === `Basic ${btoa(`owner:${PASSWORD}`)}`;
  if (url.origin !== SITE) return new Response("elsewhere", { status: 404 });
  if (url.pathname === "/") {
    return new Response("<html></html>", {
      headers: {
        "Content-Type": "text/html",
        Link: `<${SITE}/wp-json/>; rel="https://api.w.org/"`,
      },
    });
  }
  if (url.pathname === "/wp-json/") {
    return json({
      name: "Joe's Pizza",
      url: SITE,
      home: SITE,
      show_on_front: "posts",
      page_on_front: 0,
      authentication: {
        "application-passwords": {
          endpoints: { authorization: `${SITE}/wp-admin/authorize-application.php` },
        },
      },
    });
  }
  if (!signedIn) return json({ code: "rest_not_logged_in" }, 401);
  if (url.pathname.startsWith("/wp-json/wp/v2/users/me")) {
    if (url.pathname.endsWith("/introspect")) return json({ uuid: "u-1" });
    return json({ id: 1, capabilities: { publish_pages: true, unfiltered_html: true } });
  }
  const shown = (page: Page) => ({
    id: page.id,
    link: `${SITE}/${page.slug}/`,
    content: { raw: page.content },
  });
  if (url.pathname === "/wp-json/wp/v2/pages" && method === "GET") {
    const slug = url.searchParams.get("slug");
    const statuses = (url.searchParams.get("status") ?? "publish").split(",");
    return json(
      pages.filter((page) => page.slug === slug && statuses.includes(page.status)).map(shown),
    );
  }
  if (url.pathname === "/wp-json/wp/v2/pages" && method === "POST") {
    const body = JSON.parse(String(init?.body)) as Omit<Page, "id">;
    const page = { ...body, id: pages.length + 10, status: "publish" as const };
    pages.push(page);
    return json(shown(page), 201);
  }
  const one = /^\/wp-json\/wp\/v2\/pages\/(\d+)$/.exec(url.pathname);
  if (one && method === "DELETE") {
    const page = pages.find((candidate) => candidate.id === Number(one[1]));
    if (!page) return json({ code: "rest_post_invalid_id" }, 404);
    page.status = "trash";
    return json({ id: page.id, status: "trash" });
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

const worker = async () => ({
  store: memoryStore(db, null),
  key: await sealingKey(SECRET),
  outside: { fetch: wordpress },
});

/**
 * Joe's Pizza on a plan that includes WordPress, with its site connected, a page task for its
 * prompt, and that task's copy written.
 */
async function withCopy(copy: string | null = COPY) {
  const organization = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  db.memberships.push({ organization_id: organization.id, user_id: bob, role: "member" });
  db.emails.set(alice, "alice@example.com");
  db.emails.set(bob, "bob@example.com");
  const kept = db.organizations.find((candidate) => candidate.id === organization.id);
  if (kept) Object.assign(kept, { max_locations: 1, allowances: { wordpress: true, drafts: 5 } });
  const location = LocationSchema.parse(
    await (
      await call(alice, "POST", `/organizations/${organization.id}/locations`, {
        name: "Joe's Pizza",
        city: "Raleigh",
        region: "NC",
        phone: "919 555 0100",
        website: "joespizza.example",
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
  const connection = ConnectionSchema.parse(
    await (
      await call(alice, "POST", `/locations/${location.id}/wordpress`, {
        site_url: SITE,
        user_login: "owner",
        password: PASSWORD,
      })
    ).json(),
  );
  await syncConnection(connection.id, await worker());
  queued = [];
  return { location, connection, task };
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
  pages = [];
  env = {
    PROVIDER_MODE: "live",
    CONNECTIONS_KEY: SECRET,
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
  vi.stubGlobal("fetch", wordpress);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("proposing to publish a page's copy", () => {
  it("offers the task's copy, written by a model, once it is written", async () => {
    const { connection, location } = await withCopy();
    expect(await proposeAfterSync(connection.id, await worker())).toBe(1);
    const [proposal] = await waitingOf(location.id);
    expect(proposal).toMatchObject({
      kind: "wordpress_page",
      summary: "Publish the page “Late night pizza in Raleigh” on your site",
      seen: { text: null },
      proposed_text: COPY,
      written_by: "model",
    });
    expect(await proposeAfterSync(connection.id, await worker())).toBe(0);
  });

  it("offers nothing where the copy is not written, or a page is already at its address", async () => {
    const unwritten = await withCopy(null);
    expect(await proposeAfterSync(unwritten.connection.id, await worker())).toBe(0);

    db = createMemoryDb();
    pages = [
      {
        id: 3,
        slug: "late-night-pizza-in-raleigh",
        title: "Ours",
        content: "<p>The owner's own page.</p>",
        status: "publish",
      },
    ];
    const taken = await withCopy();
    expect(await proposeAfterSync(taken.connection.id, await worker())).toBe(0);
    // A page in the trash is not at the address.
    const [owners] = pages;
    if (owners) owners.status = "trash";
    expect(await proposeAfterSync(taken.connection.id, await worker())).toBe(1);
  });

  it("offers nothing where a member has said where the task's page is", async () => {
    const { connection, location, task } = await withCopy();
    expect(
      (
        await call(bob, "PUT", `/locations/${location.id}/tasks/${task.id}/page`, {
          url: `${SITE}/our-own-page`,
        })
      ).status,
    ).toBe(200);
    expect(await proposeAfterSync(connection.id, await worker())).toBe(0);
  });

  it("is asked for once the copy is written, by reading the site again", async () => {
    const { connection } = await withCopy();
    const [draft] = db.drafts;
    expect(await connectionToPublishWith(memoryStore(db, null), draft?.id ?? "")).toBe(
      connection.id,
    );
    if (draft) draft.kind = "note";
    expect(await connectionToPublishWith(memoryStore(db, null), draft?.id ?? "")).toBeNull();
  });
});

describe("publishing a page", () => {
  it("publishes the copy as changed, as text, with the details on file at the end", async () => {
    const { connection, location, task } = await withCopy();
    await proposeAfterSync(connection.id, await worker());
    const [proposal] = await waitingOf(location.id);
    const changed = `${COPY}\n\nAsk for <b>the</b> "Midnight" & more.`;
    expect(
      (await call(bob, "POST", `/actions/${proposal?.id}/approve`, { text: changed })).status,
    ).toBe(200);
    expect(await carryOutAction(proposal?.id ?? "", await worker())).toBe("done");

    expect(pages).toHaveLength(1);
    const [page] = pages;
    expect(page).toMatchObject({
      title: "Late night pizza in Raleigh",
      slug: "late-night-pizza-in-raleigh",
    });
    expect(page?.content).toContain('<h2 class="wp-block-heading">Where we are</h2>');
    expect(page?.content).toContain(
      "<p>Ask for &lt;b&gt;the&lt;/b&gt; &quot;Midnight&quot; &amp; more.</p>",
    );
    expect(page?.content).not.toContain("<b>");
    expect(page?.content).toContain("<p>Joe's Pizza, Raleigh, NC. Call (919) 555-0100.</p>");
    expect(page?.content).not.toContain("Late night pizza in Raleigh");

    // The task is done by it, and where the page is is kept, as published by Nearcited.
    expect(db.recommendations.find((r) => r.id === task.id)).toMatchObject({
      acted_by_action: proposal?.id,
    });
    expect((await pageTaskOf(location.id))?.page).toMatchObject({
      url: `${SITE}/late-night-pizza-in-raleigh/`,
      action_id: proposal?.id,
      set_by_email: null,
    });
    // A second delivery finds it published and writes nothing more.
    const action = db.actions.find((candidate) => candidate.id === proposal?.id);
    if (action) action.status = "approved";
    expect(await carryOutAction(proposal?.id ?? "", await worker())).toBe("done");
    expect(pages).toHaveLength(1);
  });

  it("writes nothing where a page has appeared at its address since", async () => {
    const { connection, location } = await withCopy();
    await proposeAfterSync(connection.id, await worker());
    const [proposal] = await waitingOf(location.id);
    await call(bob, "POST", `/actions/${proposal?.id}/approve`, {});
    pages.push({
      id: 4,
      slug: "late-night-pizza-in-raleigh",
      title: "Theirs",
      content: "<p>Written by the owner.</p>",
      status: "publish",
    });
    expect(await carryOutAction(proposal?.id ?? "", await worker())).toBe("out_of_date");
    expect(pages).toHaveLength(1);
  });
});

describe("taking a published page back", () => {
  async function published() {
    const scene = await withCopy();
    await proposeAfterSync(scene.connection.id, await worker());
    const [proposal] = await waitingOf(scene.location.id);
    await call(bob, "POST", `/actions/${proposal?.id}/approve`, {});
    await carryOutAction(proposal?.id ?? "", await worker());
    return { ...scene, published: proposal };
  }

  it("moves the page to the trash, forgets where it was, and undoes the task's mark", async () => {
    const { location, task, published: first } = await published();
    const back = ActionSchema.parse(
      await (await call(bob, "POST", `/actions/${first?.id}/take-back`)).json(),
    );
    expect(back).toMatchObject({ proposed_text: null, seen: { text: COPY } });
    expect(await carryOutAction(back.id, await worker())).toBe("done");
    expect(pages[0]?.status).toBe("trash");
    expect(db.recommendations.find((r) => r.id === task.id)).toMatchObject({
      acted_at: null,
      acted_by_action: null,
    });
    expect((await pageTaskOf(location.id))?.page).toBeNull();
  });

  it("writes nothing where the owner has rewritten the page since", async () => {
    const { published: first } = await published();
    const [page] = pages;
    if (page)
      page.content =
        "<!-- wp:paragraph -->\n<p>Rewritten by the owner.</p>\n<!-- /wp:paragraph -->";
    const back = ActionSchema.parse(
      await (await call(bob, "POST", `/actions/${first?.id}/take-back`)).json(),
    );
    expect(await carryOutAction(back.id, await worker())).toBe("out_of_date");
    expect(pages[0]?.status).toBe("publish");
  });
});
