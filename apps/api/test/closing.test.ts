import {
  type ClosingMessage,
  ConnectionSchema,
  LocationSchema,
  OrganizationSchema,
} from "@nearcited/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { Payments } from "../src/billing/types";
import { closeAccount, dropFinishedClosings, requeueStalledClosings } from "../src/closing";
import { requeueStalledRemovals } from "../src/connections";
import { seal, sealingKey } from "../src/connections/seal";
import type { Email } from "../src/email/report";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const carol = "c0000000-0000-4000-8000-000000000003";
const dave = "d0000000-0000-4000-8000-000000000004";

const NAME = "Raleigh Pizza Group";
const ZONE = "0123456789abcdef0123456789abcdef";
const TOKEN = "hostnames-token";
const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const DAY = 86_400_000;

let db: MemoryDb;
let queued: ClosingMessage[];
let sent: { to: string[]; email: Email }[];
/** The custom hostnames registered at Cloudflare, by ID, and whether it answers at all. */
let hostnames: Map<string, string>;
let cloudflareDown: boolean;
/** The subscriptions cancelled at the payment provider. */
let cancelled: string[];
/** What every request to the business's own site was. It is down. */
let siteAsked: string[];

const env = {
  PROVIDER_MODE: "live",
  APP_URL: "https://nearcited.example",
  SCAN_QUEUE: {
    send: async (message: ClosingMessage) => {
      queued.push(message);
    },
    sendBatch: async (messages: { body: ClosingMessage }[]) => {
      queued.push(...messages.map((message) => message.body));
    },
  },
} as unknown as Env;

const outside: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === "api.cloudflare.com") {
    if (cloudflareDown) return new Response("{}", { status: 503 });
    const id = url.pathname.split("/").at(-1) ?? "";
    if ((init?.method ?? "GET") === "DELETE" && hostnames.delete(id)) {
      return Response.json({ success: true, result: { id } });
    }
    return Response.json({ success: false, errors: [{ code: 1436 }] }, { status: 404 });
  }
  siteAsked.push(`${init?.method ?? "GET"} ${url.href}`);
  throw new TypeError("fetch failed");
};

const payments = {
  async getSubscription() {
    return null;
  },
  async cancelNow(id: string) {
    cancelled.push(id);
  },
} as unknown as Payments;

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

const close = (user: string | null, organizationId: string, name = NAME) =>
  call(user, "POST", `/organizations/${organizationId}/close`, { name });

const worker = async (send = true) => ({
  store: memoryStore(db, null),
  key: await sealingKey(SECRET),
  send: send
    ? async (to: string[], email: Email) => {
        sent.push({ to, email });
      }
    : undefined,
  appUrl: "https://nearcited.example",
  hosting: { cloudflare: { token: TOKEN, zone: ZONE }, sampleData: false },
  payments,
});

const connection = (organizationId: string, kind: "wordpress" | "hosted_pages", label: string) =>
  ConnectionSchema.parse({
    id: crypto.randomUUID(),
    organization_id: organizationId,
    kind,
    label,
    status: "working",
    connected_by_email: `${alice}@example.com`,
    connected_at: "2026-10-01T00:00:00.000Z",
    removed_by_email: null,
    removal_requested_at: null,
    removed_at: null,
    broken_reason: null,
    broken_at: null,
    paused_at: null,
    removal_reason: null,
    last_synced_at: null,
    choices: [],
    matches: [],
  });

/**
 * Alice's organization, with Bob a member and Dave an admin, a paid subscription, a WordPress
 * site whose sign-in is kept, and an answer subdomain registered at Cloudflare.
 */
async function seed() {
  const organization = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: NAME })).json(),
  );
  db.memberships.push({ organization_id: organization.id, user_id: bob, role: "member" });
  db.memberships.push({ organization_id: organization.id, user_id: dave, role: "admin" });
  for (const user of [alice, bob, dave]) db.emails.set(user, `${user}@example.com`);
  const kept = db.organizations.find((candidate) => candidate.id === organization.id);
  if (kept) Object.assign(kept, { max_locations: 2 });
  const location = LocationSchema.parse(
    await (
      await call(alice, "POST", `/organizations/${organization.id}/locations`, {
        name: "Joe's Pizza",
        city: "Raleigh",
        website: "https://www.joespizza.example",
      })
    ).json(),
  );
  db.subscriptions.set(organization.id, {
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    status: "active",
  });

  const site = connection(organization.id, "wordpress", "Joe's Pizza (joespizza.example)");
  db.connections.push(site);
  const key = await sealingKey(SECRET);
  if (!key) throw new Error("no key");
  const signIn = {
    site: "https://joespizza.example",
    api: "https://joespizza.example/wp-json/",
    user: "joe",
    password: "abcd efgh ijkl mnop",
    uuid: "0f0f0f0f-0000-4000-8000-000000000001",
  };
  db.connectionSecrets.set(site.id, await seal(key, site.id, JSON.stringify(signIn)));

  const hosted = connection(organization.id, "hosted_pages", "answers.joespizza.example");
  db.connections.push(hosted);
  db.answerSubdomains.push({
    connection_id: hosted.id,
    organization_id: organization.id,
    location_id: location.id,
    hostname: "answers.joespizza.example",
    target: "x7f3",
    record: null,
    checked_at: null,
    cloudflare_id: "ch-1",
    registered_at: "2026-10-02T00:00:00.000Z",
    live_at: "2026-10-02T01:00:00.000Z",
    live_told_at: "2026-10-02T01:00:00.000Z",
    home_links: true,
    released_at: null,
  });
  hostnames.set("ch-1", "answers.joespizza.example");
  return { organization, location, site, hosted };
}

beforeEach(() => {
  db = createMemoryDb();
  queued = [];
  sent = [];
  hostnames = new Map();
  cloudflareDown = false;
  cancelled = [];
  siteAsked = [];
  vi.stubGlobal("fetch", outside);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("asking to close an account", () => {
  it("is taken from an owner who types the organization's name, and queues the worker", async () => {
    const { organization } = await seed();
    const response = await close(alice, organization.id, `  ${NAME} `);
    expect(response.status).toBe(202);
    expect(queued).toEqual([{ closing_id: expect.any(String), step: "close" }]);
    // Asking again closes nothing twice.
    expect((await close(alice, organization.id)).status).toBe(202);
    expect(new Set(queued.map((message) => message.closing_id)).size).toBe(1);
  });

  it("is refused to anyone but an owner, and to a name that is not the organization's", async () => {
    const { organization } = await seed();
    for (const user of [bob, dave, carol]) {
      const response = await close(user, organization.id);
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe("owners_only");
    }
    const wrong = await close(alice, organization.id, "Raleigh Pizza");
    expect(wrong.status).toBe(422);
    expect((await errorOf(wrong)).code).toBe("name_mismatch");
    expect((await close(null, organization.id)).status).toBe(401);
    expect(queued).toEqual([]);
    expect(db.organizations).toHaveLength(1);
  });

  it("is refused to the operator and to a test account, closing nothing", async () => {
    db.operators.add(carol);
    const operators = OrganizationSchema.parse(
      await (await call(carol, "POST", "/organizations", { name: NAME })).json(),
    );
    db.testAccounts.add(dave);
    const tests = OrganizationSchema.parse(
      await (await call(dave, "POST", "/organizations", { name: NAME })).json(),
    );
    for (const [user, organization] of [
      [carol, operators],
      [dave, tests],
    ] as const) {
      const response = await close(user, organization.id);
      expect(response.status).toBe(409);
      expect((await errorOf(response)).code).toBe("not_closable");
    }
    expect(queued).toEqual([]);
  });
});

describe("the worker's closing", () => {
  it("cancels the subscription, removes every connection, deletes the organization and the sign-in, and sends one email", async () => {
    const { organization } = await seed();
    await close(alice, organization.id);
    const [message] = queued;
    if (!message) throw new Error("nothing queued");

    expect(await closeAccount(message.closing_id, await worker())).toBe("closed");

    expect(cancelled).toEqual(["sub_1"]);
    // The site was asked to take its password back, and was down.
    expect(siteAsked).toEqual([
      expect.stringMatching(
        /^DELETE https:\/\/joespizza\.example\/wp-json\/wp\/v2\/users\/me\/application-passwords\//,
      ),
    ]);
    expect(hostnames.size).toBe(0);
    expect(db.connectionSecrets.size).toBe(0);
    expect(db.organizations).toEqual([]);
    expect(db.memberships).toEqual([]);
    expect(db.locations).toEqual([]);
    expect(db.emails.has(alice)).toBe(false);
    // Bob and Dave keep their sign-ins.
    expect(db.emails.has(bob)).toBe(true);

    // One email to the owner, a note to everyone else, and nothing for each connection.
    expect(sent.map((one) => one.to)).toEqual([
      [`${alice}@example.com`],
      [`${dave}@example.com`, `${bob}@example.com`].sort(),
    ]);
    const [told, noted] = sent;
    expect(told?.email.subject).toBe(`${NAME} is closed`);
    expect(told?.email.text).toContain("subscription is cancelled");
    expect(told?.email.text).toContain("Joe's Pizza (joespizza.example)");
    expect(told?.email.text).toContain("Users → Profile → Application Passwords");
    expect(told?.email.text).toContain("answers.joespizza.example");
    expect(noted?.email.text).toContain(`${NAME} was closed by its owner`);

    // Done is done: running it again does nothing and tells nobody.
    expect(await closeAccount(message.closing_id, await worker())).toBe("not_waiting");
    expect(sent).toHaveLength(2);
    expect(cancelled).toEqual(["sub_1"]);
  });

  it("says nothing of a subscription or a site where there was none", async () => {
    const organization = OrganizationSchema.parse(
      await (await call(alice, "POST", "/organizations", { name: NAME })).json(),
    );
    db.emails.set(alice, `${alice}@example.com`);
    await close(alice, organization.id);
    const [message] = queued;
    if (!message) throw new Error("nothing queued");
    expect(await closeAccount(message.closing_id, await worker())).toBe("closed");
    expect(cancelled).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.email.text).not.toContain("subscription");
    expect(sent[0]?.email.text).not.toContain("Application Passwords");
    expect(sent[0]?.email.text).not.toContain("DNS");
  });

  it("holds the closing until Cloudflare lets the subdomain go, and carries on from there", async () => {
    const { organization } = await seed();
    await close(alice, organization.id);
    const [message] = queued;
    if (!message) throw new Error("nothing queued");
    cloudflareDown = true;
    await expect(closeAccount(message.closing_id, await worker())).rejects.toThrow();
    expect(db.organizations).toHaveLength(1);
    expect(hostnames.size).toBe(1);
    expect(sent).toEqual([]);

    cloudflareDown = false;
    expect(await closeAccount(message.closing_id, await worker())).toBe("closed");
    expect(hostnames.size).toBe(0);
    expect(db.organizations).toEqual([]);
    // The subscription was cancelled once, and the site was still named.
    expect(cancelled).toEqual(["sub_1"]);
    expect(sent[0]?.email.text).toContain("Joe's Pizza (joespizza.example)");
  });

  it("deletes nothing while a connection of the organization is not removed", async () => {
    const { organization } = await seed();
    await close(alice, organization.id);
    const [message] = queued;
    if (!message) throw new Error("nothing queued");
    // One that came in after the ask, which nothing marked for removal.
    db.connections.push(connection(organization.id, "wordpress", "late.example"));
    await expect(closeAccount(message.closing_id, await worker())).rejects.toThrow(
      /not removed yet/,
    );
    expect(db.organizations).toHaveLength(1);
    expect(db.emails.has(alice)).toBe(true);
    expect(sent).toEqual([]);
  });

  it("is worked on by one worker at a time", async () => {
    const { organization } = await seed();
    await close(alice, organization.id);
    const [message] = queued;
    if (!message) throw new Error("nothing queued");
    const asked = db.closings[0];
    if (!asked) throw new Error("no closing");
    asked.working_since = new Date().toISOString();
    expect(await closeAccount(message.closing_id, await worker())).toBe("not_waiting");
    expect(cancelled).toEqual([]);
    asked.working_since = new Date(Date.now() - 11 * 60_000).toISOString();
    expect(await closeAccount(message.closing_id, await worker())).toBe("closed");
  });

  it("sends neither email twice when a try fails between them", async () => {
    const { organization } = await seed();
    await close(alice, organization.id);
    const [message] = queued;
    if (!message) throw new Error("nothing queued");
    let notes = 0;
    const deps = {
      ...(await worker()),
      send: async (to: string[], email: Email) => {
        if (to.length > 1 && notes++ === 0) throw new Error("the mail service is down");
        sent.push({ to, email });
      },
    };
    await expect(closeAccount(message.closing_id, deps)).rejects.toThrow(/mail service/);
    expect(await closeAccount(message.closing_id, deps)).toBe("closed");
    expect(sent.map((one) => one.to.length)).toEqual([1, 2]);
  });

  it("leaves its removals to itself, and lets nothing else email the owners meanwhile", async () => {
    const { organization } = await seed();
    await close(alice, organization.id);
    const store = memoryStore(db, null);
    expect(await requeueStalledRemovals(store, env.SCAN_QUEUE, Date.now() + 16 * 60_000)).toBe(0);
    expect(await store.listOwnerEmails(organization.id)).toEqual([]);
    expect(await store.listManagerEmails(organization.id)).toEqual([]);
  });

  it("says nothing of a subscription that had already ended", async () => {
    const { organization } = await seed();
    db.subscriptions.set(organization.id, {
      stripe_customer_id: "cus_1",
      stripe_subscription_id: "sub_1",
      status: "canceled",
    });
    await close(alice, organization.id);
    const [message] = queued;
    if (!message) throw new Error("nothing queued");
    expect(await closeAccount(message.closing_id, await worker())).toBe("closed");
    expect(cancelled).toEqual([]);
    expect(sent[0]?.email.text).not.toContain("subscription");
  });

  it("finishes without email where none is set up, and keeps no address", async () => {
    const { organization } = await seed();
    await close(alice, organization.id);
    const [message] = queued;
    if (!message) throw new Error("nothing queued");
    expect(await closeAccount(message.closing_id, await worker(false))).toBe("closed");
    expect(db.organizations).toEqual([]);
    // Nor whose it was: only the fingerprint, the day and an id that now names nothing.
    const kept = JSON.stringify(db.closings);
    expect(kept).not.toContain("@example.com");
    expect(kept).not.toContain(NAME);
    expect(kept).not.toContain(alice);
  });

  it("scans nothing and carries nothing out for an organization that is closing", async () => {
    const { organization, location } = await seed();
    await call(alice, "POST", `/locations/${location.id}/queries`, {
      kind: "ai_prompt",
      text: "late night pizza in Raleigh",
    });
    const store = memoryStore(db, null);
    expect(await store.listLocationsDueForScan(10)).toEqual([location.id]);
    await close(alice, organization.id);
    expect(await store.listLocationsDueForScan(10)).toEqual([]);
    expect(await store.isOrganizationHeld(organization.id)).toBe(true);
  });
});

describe("the schedule", () => {
  it("asks again for a closing the worker did not finish, and forgets one thirty days after", async () => {
    const { organization } = await seed();
    await close(alice, organization.id);
    const [message] = queued;
    if (!message) throw new Error("nothing queued");
    queued = [];
    const store = memoryStore(db, null);
    const now = Date.now();
    expect(await requeueStalledClosings(store, env.SCAN_QUEUE, now)).toBe(0);
    expect(await requeueStalledClosings(store, env.SCAN_QUEUE, now + 16 * 60_000)).toBe(1);
    expect(queued).toEqual([message]);

    await closeAccount(message.closing_id, await worker());
    expect(await requeueStalledClosings(store, env.SCAN_QUEUE, now + 60 * 60_000)).toBe(0);
    expect(await dropFinishedClosings(store, now + 29 * DAY)).toBe(0);
    expect(db.closings).toHaveLength(1);
    expect(await dropFinishedClosings(store, now + 31 * DAY)).toBe(1);
    expect(db.closings).toEqual([]);
  });
});
