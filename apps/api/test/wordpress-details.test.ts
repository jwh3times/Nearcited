import {
  type ActionMessage,
  ActionSchema,
  buildBusinessBlock,
  type ConnectionMessage,
  ConnectionSchema,
  DETAILS_RULE,
  detailsOnPage,
  LocationActionsSchema,
  LocationSchema,
  OrganizationSchema,
  withDetails,
} from "@nearcited/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { carryOutAction, proposeAfterSync } from "../src/actions";
import { createApp } from "../src/app";
import { syncConnection } from "../src/connections";
import { sealingKey } from "../src/connections/seal";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const carol = "c0000000-0000-4000-8000-000000000003";
const dave = "d0000000-0000-4000-8000-000000000004";

const SITE = "https://joespizza.example";
const PASSWORD = "abcd EFGH 1234 ijkl MNOP 5678";
const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const FRONT = 7;
const WRITTEN = "<!-- wp:paragraph -->\n<p>Welcome to Joe's.</p>\n<!-- /wp:paragraph -->";

/** A made-up WordPress with a home page of its own, answering as WordPress 6.9 did. */
interface Site {
  showOnFront: "page" | "posts";
  /** What the home page holds, as its editor wrote it. */
  raw: string;
  capabilities: Record<string, boolean>;
  /** Every page saved, in order. */
  saved: string[];
}
let site: Site;

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
      show_on_front: site.showOnFront,
      page_on_front: site.showOnFront === "page" ? FRONT : 0,
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
    return json({ id: 1, capabilities: site.capabilities });
  }
  if (url.pathname === `/wp-json/wp/v2/pages/${FRONT}`) {
    if (method === "POST") {
      site.raw = (JSON.parse(String(init?.body)) as { content: string }).content;
      site.saved.push(site.raw);
      return json({ id: FRONT });
    }
    return json({ id: FRONT, link: `${SITE}/`, status: "publish", content: { raw: site.raw } });
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
 * Alice's organization on a plan that includes WordPress, Bob a member and Dave an admin, and
 * Joe's Pizza with its site connected and matched. The on-page check found no business details
 * on the home page, so that task is open.
 */
async function connected({ task = true } = {}) {
  const organization = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  db.memberships.push({ organization_id: organization.id, user_id: bob, role: "member" });
  db.emails.set(alice, "alice@example.com");
  db.emails.set(bob, "bob@example.com");
  const kept = db.organizations.find((candidate) => candidate.id === organization.id);
  if (kept) Object.assign(kept, { max_locations: 2, allowances: { wordpress: true } });
  const location = LocationSchema.parse(
    await (
      await call(alice, "POST", `/organizations/${organization.id}/locations`, {
        name: "Joe's Pizza",
        city: "Raleigh",
        region: "NC",
        address_line: "12 Main St",
        postal_code: "27601",
        phone: "919 555 0100",
        website: "joespizza.example",
      })
    ).json(),
  );
  const scan = await memoryStore(db, null).createScan(location.id, "scheduled", null);
  await memoryStore(db, null).markScanRunning(scan.id, false);
  await memoryStore(db, null).completeScan(scan.id, {
    score: 0,
    results: [],
    recommendations: task
      ? [{ rule: DETAILS_RULE, title: "Add your business details", detail: "Detail" }]
      : [],
  });
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
  return { organization, location, connection };
}

const actionsOf = async (user: string, locationId: string) =>
  LocationActionsSchema.parse(
    await (await call(user, "GET", `/locations/${locationId}/actions`)).json(),
  );
const detailsTask = (locationId: string) =>
  db.recommendations.find((r) => r.location_id === locationId && r.rule === DETAILS_RULE);

beforeEach(() => {
  db = createMemoryDb();
  queued = [];
  site = {
    showOnFront: "page",
    raw: WRITTEN,
    capabilities: { publish_pages: true, unfiltered_html: true },
    saved: [],
  };
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

describe("proposing the business details for a WordPress home page", () => {
  it("offers the block composed from the location's details, where the check found none", async () => {
    const { connection, location } = await connected();
    expect(await proposeAfterSync(connection.id, await worker())).toBe(1);
    const [proposal] = (await actionsOf(bob, location.id)).waiting;
    expect(proposal).toMatchObject({
      kind: "wordpress_details",
      summary: "Add your business details to your home page",
      seen: { text: null },
      proposed_text: buildBusinessBlock(location).html,
      written_by: "rule",
    });
    // Once is enough: the same is not proposed while it waits.
    expect(await proposeAfterSync(connection.id, await worker())).toBe(0);
    expect(site.saved).toEqual([]);
  });

  it("offers nothing where the home page is the latest posts, the account cannot add a script, or nothing was found lacking", async () => {
    const { connection } = await connected();
    site.showOnFront = "posts";
    expect(await proposeAfterSync(connection.id, await worker())).toBe(0);
    site.showOnFront = "page";
    site.capabilities = { publish_pages: true, unfiltered_html: false };
    expect(await proposeAfterSync(connection.id, await worker())).toBe(0);

    db = createMemoryDb();
    site.capabilities = { publish_pages: true, unfiltered_html: true };
    const untasked = await connected({ task: false });
    expect(await proposeAfterSync(untasked.connection.id, await worker())).toBe(0);
  });

  it("offers to update its own block once the details on file have changed", async () => {
    const { connection, location } = await connected({ task: false });
    const before = buildBusinessBlock(location).html;
    site.raw = withDetails(WRITTEN, before);
    expect(await proposeAfterSync(connection.id, await worker())).toBe(0);

    const stored = db.locations.find((candidate) => candidate.id === location.id);
    if (stored) stored.phone = "+19195550199";
    expect(await proposeAfterSync(connection.id, await worker())).toBe(1);
    const [update] = (await actionsOf(alice, location.id)).waiting;
    expect(update).toMatchObject({
      summary: "Update the business details on your home page",
      seen: { text: before },
    });
    expect(update?.proposed_text).toContain("+19195550199");
  });
});

describe("carrying out the business details", () => {
  it("adds the block at the end of the home page, keeps what was written, and does the task", async () => {
    const { connection, location } = await connected();
    await proposeAfterSync(connection.id, await worker());
    const [proposal] = (await actionsOf(bob, location.id)).waiting;
    if (!proposal) throw new Error("nothing proposed");

    expect((await call(bob, "POST", `/actions/${proposal.id}/approve`, {})).status).toBe(200);
    expect(queued).toEqual([{ action_id: proposal.id, step: "carry_out" }]);
    expect(await carryOutAction(proposal.id, await worker())).toBe("done");

    expect(site.raw.startsWith(WRITTEN)).toBe(true);
    expect(detailsOnPage(site.raw)).toBe(buildBusinessBlock(location).html);
    expect(detailsTask(location.id)).toMatchObject({ acted_by_action: proposal.id });
    const detail = (await (await call(bob, "GET", `/locations/${location.id}`)).json()) as {
      details_fix: { acted_by_action: string | null } | null;
    };
    expect(detail.details_fix?.acted_by_action).toBe(proposal.id);
    // Done is done: nothing more to propose, and a second delivery writes nothing.
    expect(await proposeAfterSync(connection.id, await worker())).toBe(0);
    expect(site.saved).toHaveLength(1);
  });

  it("is approved as proposed or not at all: the block is not edited first", async () => {
    const { connection, location } = await connected();
    await proposeAfterSync(connection.id, await worker());
    const [proposal] = (await actionsOf(bob, location.id)).waiting;
    const edited = await call(bob, "POST", `/actions/${proposal?.id}/approve`, {
      text: "<script>alert(1)</script>",
    });
    expect(edited.status).toBe(422);
    expect(((await edited.json()) as { error: { code: string } }).error.code).toBe("not_editable");
    expect((await actionsOf(bob, location.id)).waiting).toHaveLength(1);

    // Nor does the worker put on a site what was changed some other way.
    const action = db.actions.find((candidate) => candidate.id === proposal?.id);
    if (action) Object.assign(action, { status: "approved", approved_text: "<p>changed</p>" });
    expect(await carryOutAction(proposal?.id ?? "", await worker())).toBe("failed");
    expect(site.saved).toEqual([]);
  });

  it("writes nothing where its block was changed since the proposal", async () => {
    const { connection, location } = await connected({ task: false });
    site.raw = withDetails(WRITTEN, buildBusinessBlock(location).html);
    const stored = db.locations.find((candidate) => candidate.id === location.id);
    if (stored) stored.phone = "+19195550199";
    await proposeAfterSync(connection.id, await worker());
    const [update] = (await actionsOf(alice, location.id)).waiting;
    await call(alice, "POST", `/actions/${update?.id}/approve`, {});

    site.raw = withDetails(site.raw, '<script type="application/ld+json">{}</script>');
    expect(await carryOutAction(update?.id ?? "", await worker())).toBe("out_of_date");
    expect(site.saved).toEqual([]);
  });
});

describe("taking an action back", () => {
  async function done() {
    const scene = await connected();
    await proposeAfterSync(scene.connection.id, await worker());
    const [proposal] = (await actionsOf(bob, scene.location.id)).waiting;
    if (!proposal) throw new Error("nothing proposed");
    await call(bob, "POST", `/actions/${proposal.id}/approve`, {});
    await carryOutAction(proposal.id, await worker());
    queued = [];
    return { ...scene, added: proposal };
  }

  it("is asked for by any member, and takes away only what the action put there", async () => {
    const { location, added } = await done();
    const response = await call(bob, "POST", `/actions/${added.id}/take-back`);
    expect(response.status).toBe(201);
    const back = ActionSchema.parse(await response.json());
    expect(back).toMatchObject({
      kind: "wordpress_details",
      status: "approved",
      takes_back: added.id,
      approved_by_email: "bob@example.com",
      seen: { text: buildBusinessBlock(location).html },
      proposed_text: null,
      summary: "Take back: Add your business details to your home page",
    });
    expect(queued).toEqual([{ action_id: back.id, step: "carry_out" }]);

    // The owner wrote more meanwhile, which stays.
    site.raw = `${site.raw}\n\n<!-- wp:paragraph -->\n<p>Open late.</p>\n<!-- /wp:paragraph -->`;
    expect(await carryOutAction(back.id, await worker())).toBe("done");
    expect(detailsOnPage(site.raw)).toBeNull();
    expect(site.raw).toContain("<p>Welcome to Joe's.</p>");
    expect(site.raw).toContain("<p>Open late.</p>");
    // The task the action did is no longer done by it.
    expect(detailsTask(location.id)).toMatchObject({ acted_at: null, acted_by_action: null });
    // Taken back is a no: the same block is not offered again until the details change.
    const { connection } = { connection: db.connections[0] };
    expect(await proposeAfterSync(connection?.id ?? "", await worker())).toBe(0);
    const stored = db.locations.find((candidate) => candidate.id === location.id);
    if (stored) stored.phone = "+19195550199";
    expect(await proposeAfterSync(connection?.id ?? "", await worker())).toBe(1);
  });

  it("writes nothing where what the action put there was changed since", async () => {
    const { added } = await done();
    const back = ActionSchema.parse(
      await (await call(bob, "POST", `/actions/${added.id}/take-back`)).json(),
    );
    site.raw = withDetails(site.raw, '<script type="application/ld+json">{}</script>');
    const before = site.saved.length;
    expect(await carryOutAction(back.id, await worker())).toBe("out_of_date");
    expect(site.saved).toHaveLength(before);
  });

  it("is refused for what was not done, twice at once, or once something since has changed it", async () => {
    const { location, connection, added } = await done();
    // A proposal not yet answered.
    const stored = db.locations.find((candidate) => candidate.id === location.id);
    if (stored) stored.phone = "+19195550199";
    await proposeAfterSync(connection.id, await worker());
    const [waiting] = (await actionsOf(alice, location.id)).waiting;
    expect((await call(bob, "POST", `/actions/${waiting?.id}/take-back`)).status).toBe(409);
    // Something waiting for the same thing.
    expect((await call(bob, "POST", `/actions/${added.id}/take-back`)).status).toBe(409);

    // Done since: the update. The first can no longer be taken back on its own.
    await call(alice, "POST", `/actions/${waiting?.id}/approve`, {});
    expect(await carryOutAction(waiting?.id ?? "", await worker())).toBe("done");
    expect((await call(bob, "POST", `/actions/${added.id}/take-back`)).status).toBe(409);
    expect((await call(bob, "POST", `/actions/${waiting?.id}/take-back`)).status).toBe(201);
  });

  it("answers nobody outside the organization, and not the operator", async () => {
    const { added } = await done();
    db.operators.add(dave);
    for (const user of [carol, dave]) {
      expect((await call(user, "POST", `/actions/${added.id}/take-back`)).status, user).toBe(404);
    }
    expect((await call(null, "POST", `/actions/${added.id}/take-back`)).status).toBe(401);
  });

  it("is refused where the owners could not be told", async () => {
    const { added } = await done();
    env = { ...env, RESEND_API_KEY: undefined } as Env;
    expect((await call(bob, "POST", `/actions/${added.id}/take-back`)).status).toBe(503);
  });
});
