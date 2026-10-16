import {
  AnswerSubdomainSchema,
  type ConnectionMessage,
  ConnectionSchema,
  LocationHostedPagesSchema,
  LocationSchema,
  OrganizationSchema,
} from "@nearcited/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import {
  expireUnclaimedAnswerSubdomains,
  removeConnection,
  requeueAnswerSubdomainChecks,
  syncConnection,
} from "../src/connections";
import type { Email } from "../src/email/report";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const dave = "d0000000-0000-4000-8000-000000000004";
const erin = "e0000000-0000-4000-8000-000000000005";
const frank = "f0000000-0000-4000-8000-000000000006";
const gina = "a1000000-0000-4000-8000-000000000007";

const ZONE = "0123456789abcdef0123456789abcdef";
const TOKEN = "hostnames-token";

/**
 * The outside world an answer subdomain meets: public DNS, read over HTTPS as Cloudflare's
 * resolver answers it, and Cloudflare's interface for custom hostnames.
 */
interface World {
  /** What each name resolves to. A name not here resolves to nothing. */
  dns: Map<string, { cname?: string; a?: string[] }>;
  /** The custom hostnames registered on the zone, by ID. */
  hostnames: Map<string, { hostname: string; status: string; ssl: { status: string } }>;
  /** Every request to Cloudflare's interface, with whether it carried the token. */
  asked: { method: string; path: string; signed: boolean }[];
  /** The home page of each business's site, by its address. */
  homes: Map<string, string>;
}

let world: World;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const outside: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "cloudflare-dns.com") {
    const name = (url.searchParams.get("name") ?? "").replace(/\.$/, "");
    const type = url.searchParams.get("type");
    const kept = world.dns.get(name);
    const answer =
      type === "CNAME" && kept?.cname
        ? [{ name, type: 5, data: `${kept.cname}.` }]
        : type === "A" && kept?.a
          ? kept.a.map((address) => ({ name, type: 1, data: address }))
          : [];
    return json({ Status: 0, Answer: answer });
  }
  if (world.homes.has(url.href)) {
    return new Response(world.homes.get(url.href), { headers: { "Content-Type": "text/html" } });
  }
  if (url.hostname === "api.cloudflare.com") {
    const signed = new Headers(init?.headers).get("Authorization") === `Bearer ${TOKEN}`;
    const path = url.pathname.replace(`/client/v4/zones/${ZONE}/custom_hostnames`, "");
    world.asked.push({ method, path, signed });
    if (!signed) return json({ success: false, errors: [{ code: 10000 }] }, 403);
    if (method === "POST" && path === "") {
      const { hostname } = JSON.parse(String(init?.body)) as { hostname: string };
      const id = `ch-${world.hostnames.size + 1}`;
      const made = { hostname, status: "pending", ssl: { status: "initializing" } };
      world.hostnames.set(id, made);
      return json({ success: true, result: { id, ...made } });
    }
    const id = path.slice(1);
    const kept = world.hostnames.get(id);
    if (!kept) return json({ success: false, errors: [{ code: 1436 }] }, 404);
    if (method === "DELETE") {
      world.hostnames.delete(id);
      return json({ success: true, result: { id } });
    }
    return json({ success: true, result: { id, ...kept } });
  }
  return new Response("Not found", { status: 404 });
};

let db: MemoryDb;
let queued: ConnectionMessage[];
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

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string } }).error;

/**
 * An organization of `owner`'s on a plan that includes hosted pages, Bob a member and Dave an
 * admin of Alice's, and its location at `website`.
 */
async function withLocation({
  owner = alice,
  allowed = true,
  website = "https://www.joespizza.example/menu" as string | null,
  test = false,
} = {}) {
  const organization = OrganizationSchema.parse(
    await (await call(owner, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  if (owner === alice) {
    db.memberships.push({ organization_id: organization.id, user_id: bob, role: "member" });
    db.memberships.push({ organization_id: organization.id, user_id: dave, role: "admin" });
    db.emails.set(dave, `${dave}@example.com`);
  }
  db.emails.set(owner, `${owner}@example.com`);
  const kept = db.organizations.find((candidate) => candidate.id === organization.id);
  if (kept) {
    Object.assign(kept, {
      max_locations: 2,
      is_test: test,
      allowances: allowed ? { hosted_pages: true, wordpress: true } : {},
    });
  }
  const location = LocationSchema.parse(
    await (
      await call(owner, "POST", `/organizations/${organization.id}/locations`, {
        name: "Joe's Pizza",
        city: "Raleigh",
        ...(website ? { website } : {}),
      })
    ).json(),
  );
  return { organization, location };
}

const standing = async (user: string, locationId: string) =>
  LocationHostedPagesSchema.parse(
    await (await call(user, "GET", `/locations/${locationId}/hosted-pages`)).json(),
  );
const make = (user: string | null, locationId: string, label = "answers") =>
  call(user, "POST", `/locations/${locationId}/hosted-pages`, { label });

beforeEach(() => {
  db = createMemoryDb();
  queued = [];
  world = { dns: new Map(), hostnames: new Map(), asked: [], homes: new Map() };
  env = {
    PROVIDER_MODE: "live",
    CONNECTIONS_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
    CLOUDFLARE_HOSTNAMES_TOKEN: TOKEN,
    CLOUDFLARE_ZONE_ID: ZONE,
    SCAN_QUEUE: {
      send: async (message: ConnectionMessage) => {
        queued.push(message);
      },
      sendBatch: async (messages: { body: ConnectionMessage }[]) => {
        queued.push(...messages.map((message) => message.body));
      },
    },
  } as unknown as Env;
  vi.stubGlobal("fetch", outside);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("making an answer subdomain", () => {
  it("makes one under the location's website for an owner or admin, pointed at a target of its own", async () => {
    const { organization, location } = await withLocation();
    expect(await standing(alice, location.id)).toEqual({
      barred: null,
      can_manage: true,
      subdomain: null,
      removed: null,
    });

    const response = await make(dave, location.id, " Answers ");
    expect(response.status).toBe(201);
    const made = AnswerSubdomainSchema.parse(await response.json());
    expect(made).toMatchObject({
      location_id: location.id,
      hostname: "answers.joespizza.example",
      record: null,
      registered_at: null,
      live_at: null,
      website_matches: true,
      status: "working",
    });
    expect(made.target).toMatch(/^[a-z0-9]{12}\.pages\.nearcited\.com$/);
    expect(made.waits_until).not.toBeNull();
    // The worker looks for the record at once.
    expect(queued).toEqual([{ connection_id: made.connection_id, step: "sync" }]);

    // It is a connection like any other, matched to its location, with no sign-in.
    const listed = (await (
      await call(alice, "GET", `/organizations/${organization.id}/connections`)
    ).json()) as { connections: unknown[] };
    const [connection] = listed.connections.map((row) => ConnectionSchema.parse(row));
    expect(connection).toMatchObject({
      id: made.connection_id,
      kind: "hosted_pages",
      label: "answers.joespizza.example",
      matches: [{ location_id: location.id, external_id: "answers.joespizza.example" }],
    });
    expect(db.connectionSecrets.has(made.connection_id)).toBe(false);

    // A member reads it and cannot make or remove one.
    expect(await standing(bob, location.id)).toMatchObject({
      can_manage: false,
      subdomain: { hostname: "answers.joespizza.example" },
    });
  });

  it("stays its location's: it cannot be matched elsewhere or unmatched", async () => {
    const { location } = await withLocation();
    const made = AnswerSubdomainSchema.parse(await (await make(alice, location.id)).json());
    const path = `/connections/${made.connection_id}/locations/${location.id}`;
    const matching = await call(alice, "PUT", path, { external_id: made.hostname });
    expect(matching.status).toBe(422);
    expect((await errorOf(matching)).code).toBe("not_matched_by_hand");
    expect((await call(alice, "DELETE", path)).status).toBe(422);
    expect(db.connections[0]?.matches).toHaveLength(1);
  });

  it("gives each answer subdomain a target of its own", async () => {
    const one = await withLocation();
    const two = await withLocation({ owner: erin, website: "https://slicehouse.example" });
    const first = AnswerSubdomainSchema.parse(await (await make(alice, one.location.id)).json());
    const second = AnswerSubdomainSchema.parse(await (await make(erin, two.location.id)).json());
    expect(first.target).not.toBe(second.target);
  });

  it("refuses a member, and anyone outside the organization, as if there were no location", async () => {
    const { location } = await withLocation();
    for (const user of [bob, erin]) {
      expect((await make(user, location.id)).status, user).toBe(404);
    }
    expect((await make(null, location.id)).status).toBe(401);
    expect(db.connections).toEqual([]);
  });

  it("refuses a name that is not one word of a host name", async () => {
    const { location } = await withLocation();
    for (const label of ["two words", "-answers", "answers.more", "über"]) {
      const response = await make(alice, location.id, label);
      expect(response.status, label).toBe(422);
      expect((await errorOf(response)).code).toBe("bad_label");
    }
  });

  it("refuses a name that already points somewhere, so a subdomain in use is not broken", async () => {
    const { location } = await withLocation();
    world.dns.set("answers.joespizza.example", { a: ["203.0.113.7"] });
    const response = await make(alice, location.id);
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toMatchObject({
      code: "in_use",
      message: expect.stringContaining("answers.joespizza.example"),
    });
    world.dns.set("help.joespizza.example", { cname: "desk.example.net" });
    expect((await errorOf(await make(alice, location.id, "help"))).code).toBe("in_use");
    expect(db.connections).toEqual([]);
  });

  it("takes a name whose record still points at an old target of Nearcited's, since its owner only changes the target", async () => {
    const { location } = await withLocation();
    world.dns.set("answers.joespizza.example", { cname: "oldoldoldold.pages.nearcited.com" });
    expect((await make(alice, location.id)).status).toBe(201);
  });

  it("is not offered for a website on a site builder's own address, which has no records of its owner's", async () => {
    const { location } = await withLocation({ website: "https://joespizza.wixsite.com/menu" });
    expect((await standing(alice, location.id)).barred).toBe("no_own_domain");
    expect((await errorOf(await make(alice, location.id))).code).toBe("no_own_domain");
  });

  it("refuses a subdomain another connection holds, whoever's it is", async () => {
    const one = await withLocation();
    const two = await withLocation({ owner: erin });
    expect((await make(alice, one.location.id)).status).toBe(201);
    const response = await make(erin, two.location.id);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("taken");
  });

  it("refuses a second for the same location", async () => {
    const { location } = await withLocation();
    expect((await make(alice, location.id)).status).toBe(201);
    const response = await make(alice, location.id, "help");
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("already_connected");
  });

  it("says what stands in the way where one cannot be made, and refuses to make one", async () => {
    const notIncluded = await withLocation({ allowed: false });
    expect((await standing(alice, notIncluded.location.id)).barred).toBe("not_included");
    expect((await make(alice, notIncluded.location.id)).status).toBe(422);

    const noWebsite = await withLocation({ owner: erin, website: null });
    expect((await standing(erin, noWebsite.location.id)).barred).toBe("no_website");
    expect((await errorOf(await make(erin, noWebsite.location.id))).code).toBe("no_website");

    // Pages from a test organization would go out under a real domain, so it has none.
    const test = await withLocation({ owner: frank, test: true });
    expect((await standing(frank, test.location.id)).barred).toBe("not_included");

    // A deployment that cannot register a subdomain to be served offers none.
    const { location } = await withLocation({ owner: gina });
    env = { ...env, CLOUDFLARE_HOSTNAMES_TOKEN: undefined } as Env;
    expect((await standing(gina, location.id)).barred).toBe("unavailable");
    expect((await errorOf(await make(gina, location.id))).code).toBe("hosted_pages_unavailable");
  });

  it("is offered on sample data, where nothing is registered anywhere", async () => {
    env = {
      ...env,
      PROVIDER_MODE: "mock",
      CLOUDFLARE_HOSTNAMES_TOKEN: undefined,
      CLOUDFLARE_ZONE_ID: undefined,
    } as Env;
    const { location } = await withLocation();
    expect((await standing(alice, location.id)).barred).toBeNull();
    expect((await make(alice, location.id)).status).toBe(201);
  });

  it("keeps pages in one place: hosted pages and a WordPress site refuse each other", async () => {
    const { location } = await withLocation();
    db.connections.push(
      ConnectionSchema.parse({
        id: "f0000000-0000-4000-8000-00000000000f",
        organization_id: location.organization_id,
        kind: "wordpress",
        label: "joespizza.example",
        status: "working",
        connected_by_email: null,
        connected_at: "2026-10-01T00:00:00Z",
        removed_by_email: null,
        removal_requested_at: null,
        removed_at: null,
        broken_reason: null,
        broken_at: null,
        paused_at: null,
        removal_reason: null,
        last_synced_at: "2026-10-01T00:00:00Z",
        choices: [{ id: "https://joespizza.example", label: "Joe's Pizza" }],
        matches: [
          {
            location_id: location.id,
            external_id: "https://joespizza.example",
            external_label: "Joe's Pizza",
            matched_at: "2026-10-01T00:00:00Z",
          },
        ],
      }),
    );
    expect((await standing(alice, location.id)).barred).toBe("wordpress");
    expect((await errorOf(await make(alice, location.id))).code).toBe("wordpress_connected");

    const other = await withLocation({ owner: erin, website: "https://slicehouse.example" });
    expect((await make(erin, other.location.id)).status).toBe(201);
    const wordpress = await call(erin, "POST", `/locations/${other.location.id}/wordpress/check`);
    expect(wordpress.status).toBe(409);
    expect((await errorOf(wordpress)).code).toBe("hosted_pages_connected");
  });
});

describe("checking an answer subdomain", () => {
  let sent: { to: string[]; email: Email }[];
  const worker = (sampleData = false) => ({
    store: memoryStore(db, null),
    key: null,
    send: async (to: string[], email: Email) => {
      sent.push({ to, email });
    },
    appUrl: "https://nearcited.com",
    hosting: { cloudflare: { token: TOKEN, zone: ZONE }, sampleData },
  });
  beforeEach(() => {
    sent = [];
  });

  /** Alice's answer subdomain, made from her location's Website tab. */
  async function withSubdomain() {
    const { location } = await withLocation();
    const made = AnswerSubdomainSchema.parse(await (await make(alice, location.id)).json());
    queued = [];
    return { location, made, target: made.target };
  }
  const shown = async (locationId: string) => (await standing(alice, locationId)).subdomain;

  it("waits while the record is missing, and registers nothing", async () => {
    const { location, made } = await withSubdomain();
    expect(await syncConnection(made.connection_id, worker())).toBe("synced");
    expect(await shown(location.id)).toMatchObject({
      record: "missing",
      registered_at: null,
      live_at: null,
    });
    expect((await shown(location.id))?.checked_at).not.toBeNull();
    expect(world.asked).toEqual([]);
  });

  it("registers the name once its record points at the connection's own target, and tells the owners once it is live", async () => {
    const { location, made, target } = await withSubdomain();
    world.dns.set(made.hostname, { cname: target });
    expect(await syncConnection(made.connection_id, worker())).toBe("synced");
    // Registered, and asked at once whether it is served yet.
    expect(world.asked).toEqual([
      { method: "POST", path: "", signed: true },
      { method: "GET", path: "/ch-1", signed: true },
    ]);
    expect(world.hostnames.get("ch-1")?.hostname).toBe("answers.joespizza.example");
    const registered = await shown(location.id);
    expect(registered).toMatchObject({ record: "ours", live_at: null });
    expect(registered?.registered_at).not.toBeNull();
    // Registered is not yet working: it is still waited for.
    expect(registered?.waits_until).toBe(made.waits_until);
    expect(sent).toEqual([]);

    // Served, but not yet with its certificate: not live.
    world.hostnames.set("ch-1", {
      hostname: made.hostname,
      status: "active",
      ssl: { status: "pending_validation" },
    });
    await syncConnection(made.connection_id, worker());
    expect((await shown(location.id))?.live_at).toBeNull();

    // Cloudflare issues the certificate on its own time. Once both are active it is live.
    world.hostnames.set("ch-1", {
      hostname: made.hostname,
      status: "active",
      ssl: { status: "active" },
    });
    world.homes.set(
      "https://www.joespizza.example/menu",
      `<a href="https://answers.joespizza.example/">Answers</a>`,
    );
    expect(await syncConnection(made.connection_id, worker())).toBe("synced");
    const live = await shown(location.id);
    expect(live?.live_at).not.toBeNull();
    expect(live?.waits_until).toBeNull();
    expect(live?.home_links).toBe(true);
    expect(world.asked.filter((asked) => asked.method === "POST")).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual([`${alice}@example.com`, `${dave}@example.com`]);
    expect(sent[0]?.email.subject).toContain("answers.joespizza.example");
    expect(sent[0]?.email.text).toContain("https://answers.joespizza.example");

    // Told once.
    expect(await syncConnection(made.connection_id, worker())).toBe("synced");
    expect(sent).toHaveLength(1);
  });

  it("says whether the business's home page links to it", async () => {
    const { location, made, target } = await withSubdomain();
    world.dns.set(made.hostname, { cname: target });
    world.homes.set("https://www.joespizza.example/menu", "<p>Pizza.</p>");
    await syncConnection(made.connection_id, worker());
    world.hostnames.set("ch-1", {
      hostname: made.hostname,
      status: "active",
      ssl: { status: "active" },
    });
    await syncConnection(made.connection_id, worker());
    expect((await shown(location.id))?.home_links).toBe(false);
  });

  it("registers nothing for a record that points at another target, so nobody else can claim the name", async () => {
    const { location, made } = await withSubdomain();
    world.dns.set(made.hostname, { cname: "zzzzzzzzzzzz.pages.nearcited.com" });
    await syncConnection(made.connection_id, worker());
    expect((await shown(location.id))?.record).toBe("elsewhere");
    world.dns.set(made.hostname, { cname: "joespizza.wixsite.example" });
    await syncConnection(made.connection_id, worker());
    expect((await shown(location.id))?.record).toBe("elsewhere");
    expect(world.asked).toEqual([]);
  });

  it("tells a proxied record apart, since it hides where it points", async () => {
    const { location, made } = await withSubdomain();
    world.dns.set(made.hostname, { a: ["104.21.32.1", "172.67.180.5"] });
    await syncConnection(made.connection_id, worker());
    expect((await shown(location.id))?.record).toBe("proxied");
    expect(world.asked).toEqual([]);
  });

  it("looks nothing up on sample data", async () => {
    const { location, made, target } = await withSubdomain();
    world.dns.set(made.hostname, { cname: target });
    expect(await syncConnection(made.connection_id, worker(true))).toBe("synced");
    expect((await shown(location.id))?.record).toBeNull();
    expect(world.asked).toEqual([]);
  });

  it("asks again every few minutes until it is live, for thirty days", async () => {
    const { made, target } = await withSubdomain();
    const queue = env.SCAN_QUEUE;
    // Made more than thirty days ago, it is left to the daily run.
    const now = Date.parse("2026-11-15T12:00:00Z");
    db.now = new Date(now).toISOString();
    expect(await requeueAnswerSubdomainChecks(memoryStore(db, null), queue, now)).toBe(0);
    const kept = db.connections.find((connection) => connection.id === made.connection_id);
    if (kept) kept.connected_at = "2026-11-15T11:00:00Z";
    expect(await requeueAnswerSubdomainChecks(memoryStore(db, null), queue, now)).toBe(1);
    expect(queued).toEqual([{ connection_id: made.connection_id, step: "sync" }]);

    // Checked a moment ago, it waits; live, it is not asked for again.
    db.now = "2026-11-15T11:58:00Z";
    world.dns.set(made.hostname, { cname: target });
    await syncConnection(made.connection_id, worker());
    expect(await requeueAnswerSubdomainChecks(memoryStore(db, null), queue, now)).toBe(0);
    world.hostnames.set("ch-1", {
      hostname: made.hostname,
      status: "active",
      ssl: { status: "active" },
    });
    await syncConnection(made.connection_id, worker());
    expect(await requeueAnswerSubdomainChecks(memoryStore(db, null), queue, now + 3_600_000)).toBe(
      0,
    );
  });

  it("counts a failed lookup as a failed sync", async () => {
    const { made } = await withSubdomain();
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    expect(await syncConnection(made.connection_id, worker())).toBe("failed");
  });

  it("stops waiting after thirty days without the record, frees the name and tells the owners once", async () => {
    const { location, made } = await withSubdomain();
    const queue = env.SCAN_QUEUE;
    db.now = new Date(Date.parse(made.waits_until ?? "") - 3_600_000).toISOString();
    expect(await expireUnclaimedAnswerSubdomains(memoryStore(db, null), queue)).toBe(0);
    db.now = new Date(Date.parse(made.waits_until ?? "") + 3_600_000).toISOString();
    expect(await expireUnclaimedAnswerSubdomains(memoryStore(db, null), queue)).toBe(1);
    expect(queued).toEqual([{ connection_id: made.connection_id, step: "remove" }]);

    expect(await removeConnection(made.connection_id, worker())).toBe("removed");
    expect(world.asked).toEqual([]);
    // The card says what became of it until another is set up.
    const after = await standing(alice, location.id);
    expect(after.subdomain).toBeNull();
    expect(after.removed).toMatchObject({
      hostname: "answers.joespizza.example",
      removal_reason: "unclaimed",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.email.text).toContain("answers.joespizza.example");
    expect(sent[0]?.email.text).toContain("thirty days");

    // The name is anyone's again.
    expect((await make(alice, location.id)).status).toBe(201);
  });

  it("says when the location's website has moved to another domain", async () => {
    const { location } = await withSubdomain();
    expect((await shown(location.id))?.website_matches).toBe(true);
    const kept = db.locations.find((candidate) => candidate.id === location.id);
    if (kept) kept.website = "https://joesnewplace.example";
    expect((await shown(location.id))?.website_matches).toBe(false);
  });

  it("keeps saying it matches when the website moves within the same domain", async () => {
    const { location } = await withSubdomain();
    const kept = db.locations.find((candidate) => candidate.id === location.id);
    if (kept) kept.website = "https://shop.joespizza.example";
    expect((await shown(location.id))?.website_matches).toBe(true);
  });

  it("does not take a link to a lookalike host for a link to it", async () => {
    const { location, made, target } = await withSubdomain();
    world.dns.set(made.hostname, { cname: target });
    world.homes.set(
      "https://www.joespizza.example/menu",
      `<a href="https://answers.joespizza.example.evil.example/">Answers</a>`,
    );
    await syncConnection(made.connection_id, worker());
    world.hostnames.set("ch-1", {
      hostname: made.hostname,
      status: "active",
      ssl: { status: "active" },
    });
    await syncConnection(made.connection_id, worker());
    expect((await shown(location.id))?.home_links).toBe(false);
  });

  it("lets go of one registered but never served after thirty days, and takes it off Cloudflare", async () => {
    const { location, made, target } = await withSubdomain();
    world.dns.set(made.hostname, { cname: target });
    await syncConnection(made.connection_id, worker());
    expect((await shown(location.id))?.waits_until).toBe(made.waits_until);
    db.now = new Date(Date.parse(made.waits_until ?? "") + 3_600_000).toISOString();
    expect(await expireUnclaimedAnswerSubdomains(memoryStore(db, null), env.SCAN_QUEUE)).toBe(1);
    expect(await removeConnection(made.connection_id, worker())).toBe("removed");
    expect(world.asked.at(-1)).toEqual({ method: "DELETE", path: "/ch-1", signed: true });
    expect(sent[0]?.email.text).toContain("start working");
  });

  it("removes it with its location, since nothing is left to serve there", async () => {
    const { location, made } = await withSubdomain();
    expect((await call(alice, "DELETE", `/locations/${location.id}`)).status).toBe(204);
    expect(db.connections.find((c) => c.id === made.connection_id)?.status).toBe("removing");
    expect(await removeConnection(made.connection_id, worker())).toBe("removed");
    expect(sent[0]?.email.text).toContain(`CNAME record for ${made.hostname}`);
    expect(sent[0]?.email.text).toContain(`location ${made.hostname} was set up for was removed`);
  });

  it("takes a live one off Cloudflare when its owner removes it, and tells them to delete the record", async () => {
    const { location, made, target } = await withSubdomain();
    world.dns.set(made.hostname, { cname: target });
    await syncConnection(made.connection_id, worker());
    world.hostnames.set("ch-1", {
      hostname: made.hostname,
      status: "active",
      ssl: { status: "active" },
    });
    await syncConnection(made.connection_id, worker());
    sent = [];

    const removing = await call(alice, "DELETE", `/connections/${made.connection_id}`);
    expect(removing.status).toBe(200);
    expect(await removeConnection(made.connection_id, worker())).toBe("removed");
    expect(world.asked.at(-1)).toEqual({ method: "DELETE", path: "/ch-1", signed: true });
    expect(world.hostnames.size).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.email.text).toContain(`CNAME record for ${made.hostname}`);
    expect((await standing(alice, location.id)).subdomain).toBeNull();
  });
});
