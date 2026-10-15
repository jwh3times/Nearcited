import {
  type ConnectionMessage,
  ConnectionSchema,
  LocationSchema,
  OrganizationSchema,
  WordPressCheckSchema,
} from "@nearcited/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { readWordPressSignIn, removeConnection, syncConnection } from "../src/connections";
import { open, sealingKey } from "../src/connections/seal";
import {
  checkWordPress,
  decodeEntities,
  readSite,
  route,
  signInWith,
  type WordPressSignIn,
  withdrawPassword,
} from "../src/connections/wordpress";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const carol = "c0000000-0000-4000-8000-000000000003";
const dave = "d0000000-0000-4000-8000-000000000004";

const SITE = "https://joespizza.example";
const PASSWORD = "abcd EFGH 1234 ijkl MNOP 5678";
const UUID = "5724fb55-f44c-4bff-adba-3f169e6beec2";
const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

/** A made-up WordPress, answering as WordPress 6.9 did when it was read on 2026-10-14. */
interface Site {
  /** Where the home page says the interface is. Null for a site that names none. */
  link: string | null;
  /** The interface's own index, as its fields were asked for, or null for none. */
  index: Record<string, unknown> | null;
  /** What the account may do. */
  capabilities: Record<string, boolean>;
  /** False once the password was taken back. */
  live: boolean;
  /** Every request, with whether it carried the sign-in. */
  asked: { url: string; method: string; signedIn: boolean }[];
}

let site: Site;

const READY_INDEX = {
  name: "Joe&#039;s Pizza",
  url: SITE,
  home: SITE,
  authentication: {
    "application-passwords": {
      endpoints: { authorization: `${SITE}/wp-admin/authorize-application.php` },
    },
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const wordpress: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const auth = new Headers(init?.headers).get("Authorization");
  const signedIn = auth === `Basic ${btoa(`owner:${PASSWORD}`)}`;
  site.asked.push({ url: url.href, method, signedIn: auth !== null });
  if (url.origin !== SITE) return new Response("elsewhere", { status: 404 });
  if (url.pathname === "/") {
    return new Response("<html>Joe's</html>", {
      headers: {
        "Content-Type": "text/html",
        ...(site.link ? { Link: `<${site.link}>; rel="https://api.w.org/"` } : {}),
      },
    });
  }
  if (url.pathname === "/wp-json/" && method === "GET") {
    return site.index ? json(site.index) : new Response("Not found", { status: 404 });
  }
  if (url.pathname.startsWith("/wp-json/wp/v2/users/me")) {
    if (!signedIn || !site.live) return json({ code: "rest_not_logged_in" }, 401);
    if (url.pathname.endsWith("/introspect")) return json({ uuid: UUID });
    if (url.pathname.endsWith(`/application-passwords/${UUID}`) && method === "DELETE") {
      site.live = false;
      return json({ deleted: true });
    }
    return json({ id: 1, capabilities: site.capabilities });
  }
  return new Response("Not found", { status: 404 });
};

beforeEach(() => {
  site = {
    link: `${SITE}/wp-json/`,
    index: READY_INDEX,
    capabilities: { publish_pages: true, unfiltered_html: true },
    live: true,
    asked: [],
  };
});

const deps = { fetch: wordpress };
const approved = { site_url: SITE, user_login: "owner", password: PASSWORD };

describe("asking a website whether it is a WordPress that can be connected", () => {
  it("is ready where its interface gives out application passwords, and says where to approve", async () => {
    expect(await checkWordPress(`${SITE}/menu`, deps)).toEqual({
      verdict: "ready",
      authorize_url: `${SITE}/wp-admin/authorize-application.php`,
      site_name: "Joe's Pizza",
    });
    // Nothing it asked carried a sign-in: there is none yet.
    expect(site.asked.every((request) => !request.signedIn)).toBe(true);
    expect(site.asked.map((request) => new URL(request.url).pathname)).toEqual([
      "/menu",
      "/wp-json/",
    ]);
  });

  it("looks beside the home page where the page names no interface", async () => {
    site.link = null;
    expect((await checkWordPress(SITE, deps)).verdict).toBe("ready");
  });

  it("says the passwords are off where the interface gives none out", async () => {
    site.index = { ...READY_INDEX, authentication: [] };
    expect(await checkWordPress(SITE, deps)).toEqual({
      verdict: "passwords_off",
      authorize_url: null,
      site_name: "Joe's Pizza",
    });
    // Nor where it would send its owner to approve on some other site.
    site.index = {
      ...READY_INDEX,
      authentication: {
        "application-passwords": {
          endpoints: { authorization: "https://approve.example/authorize-application.php" },
        },
      },
    };
    expect((await checkWordPress(SITE, deps)).verdict).toBe("passwords_off");
  });

  it("is not WordPress where there is no interface, or one that names no site", async () => {
    site.index = null;
    expect((await checkWordPress(SITE, deps)).verdict).toBe("not_wordpress");
    site.index = { hello: "world" };
    expect((await checkWordPress(SITE, deps)).verdict).toBe("not_wordpress");
    // An interface the page names on another site is not this site's.
    site.link = "https://elsewhere.example/wp-json/";
    site.index = READY_INDEX;
    expect((await checkWordPress(SITE, deps)).verdict).toBe("not_wordpress");
  });

  it("is unreachable where the site does not answer, faults, or is not one to call", async () => {
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect((await checkWordPress(SITE, { fetch: down })).verdict).toBe("unreachable");
    const faulty: typeof fetch = async () => new Response("", { status: 503 });
    expect((await checkWordPress(SITE, { fetch: faulty })).verdict).toBe("unreachable");
    for (const address of ["http://10.0.0.1", "http://localhost:8099", "https://site.internal"]) {
      expect((await checkWordPress(address, deps)).verdict, address).toBe("unreachable");
    }
    expect(site.asked).toEqual([]);
    expect((await checkWordPress(null, deps)).verdict).toBe("no_website");
  });

  it("follows a redirect only where it may go", async () => {
    const moved: typeof fetch = async (input, init) =>
      new URL(String(input)).hostname === "joespizza.example"
        ? new Response("", { status: 301, headers: { Location: "http://169.254.169.254/" } })
        : wordpress(input, init);
    expect((await checkWordPress(SITE, { fetch: moved })).verdict).toBe("unreachable");
  });

  it("reaches a WordPress on this machine only at the one origin it is told of", async () => {
    const local: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/")
        return new Response("", { headers: { "Content-Type": "text/html" } });
      return json({
        ...READY_INDEX,
        url: "http://localhost:8099",
        home: "http://localhost:8099",
        authentication: {
          "application-passwords": {
            endpoints: {
              authorization: "http://localhost:8099/wp-admin/authorize-application.php",
            },
          },
        },
      });
    };
    const there = { fetch: local, localOrigin: "http://localhost:8099" };
    expect((await checkWordPress("http://localhost:8099", there)).verdict).toBe("ready");
    expect((await checkWordPress("http://localhost:8100", there)).verdict).toBe("unreachable");
  });
});

describe("signing in with what WordPress handed back", () => {
  it("keeps the site, its interface, the account and the password's own ID", async () => {
    expect(await signInWith(approved, `${SITE}/`, deps)).toEqual({
      signIn: {
        site: SITE,
        api: `${SITE}/wp-json/`,
        user: "owner",
        password: PASSWORD,
        uuid: UUID,
      },
      label: "joespizza.example",
    });
  });

  it("is refused for another site, a password the site refuses, or an account that cannot publish", async () => {
    expect(await signInWith({ ...approved, site_url: "https://other.example" }, SITE, deps)).toBe(
      "not_this_site",
    );
    expect(await signInWith({ ...approved, password: "wrong" }, SITE, deps)).toBe("refused");
    site.capabilities = { publish_pages: false };
    expect(await signInWith(approved, SITE, deps)).toBe("cannot_publish");
    // The site says it is another site.
    site.capabilities = { publish_pages: true };
    site.index = { ...READY_INDEX, home: "https://other.example" };
    expect(await signInWith(approved, SITE, deps)).toBe("not_this_site");
  });

  it("sends the password only over https to the site, and never on through a redirect", async () => {
    const http: WordPressSignIn = {
      site: "http://joespizza.example",
      api: "http://joespizza.example/wp-json/",
      user: "owner",
      password: PASSWORD,
      uuid: UUID,
    };
    await expect(readSite(http, deps)).rejects.toThrow(/may be sent/);
    const elsewhere = { ...http, site: SITE, api: "https://elsewhere.example/wp-json/" };
    await expect(readSite(elsewhere, deps)).rejects.toThrow(/may be sent/);
    expect(site.asked).toEqual([]);

    const redirecting: typeof fetch = async (input) => {
      site.asked.push({ url: String(input), method: "GET", signedIn: true });
      return new Response("", {
        status: 302,
        headers: { Location: "https://collector.example/" },
      });
    };
    const signIn = { ...http, site: SITE, api: `${SITE}/wp-json/` };
    await expect(readSite(signIn, { fetch: redirecting })).rejects.toThrow(/somewhere else/);
    expect(site.asked.map((request) => new URL(request.url).hostname)).toEqual([
      "joespizza.example",
    ]);
  });
});

describe("what a WordPress connection reaches, and taking it back", () => {
  const signIn: WordPressSignIn = {
    site: SITE,
    api: `${SITE}/wp-json/`,
    user: "owner",
    password: PASSWORD,
    uuid: UUID,
  };

  it("is the one site, named as it names itself", async () => {
    expect(await readSite(signIn, deps)).toEqual([
      { id: SITE, label: "Joe's Pizza (joespizza.example)" },
    ]);
  });

  it("takes the password back at the site, after which the site refuses it", async () => {
    expect(await withdrawPassword(signIn, deps)).toBe(true);
    expect(site.asked.at(-1)).toMatchObject({
      method: "DELETE",
      url: `${SITE}/wp-json/wp/v2/users/me/application-passwords/${UUID}`,
    });
    // Gone already is gone.
    expect(await withdrawPassword(signIn, deps)).toBe(true);
    await expect(readSite(signIn, deps)).rejects.toThrow(/401/);
    expect(await withdrawPassword({ ...signIn, uuid: null }, deps)).toBe(false);
  });

  it("is addressed where the site has no pretty addresses", () => {
    expect(
      route("https://joespizza.example/?rest_route=/", "wp/v2/users/me", { context: "edit" }).href,
    ).toBe("https://joespizza.example/?rest_route=%2Fwp%2Fv2%2Fusers%2Fme&context=edit");
    expect(route(`${SITE}/wp-json`, "wp/v2/pages").href).toBe(`${SITE}/wp-json/wp/v2/pages`);
  });

  it("reads a site's name as WordPress writes it", () => {
    expect(decodeEntities("Joe&#039;s &amp; Sons &#x2014; &quot;Pizza&quot; &bogus;")).toBe(
      'Joe\'s & Sons — "Pizza" &bogus;',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The routes and the worker.

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

/** Alice's organization on a plan that includes WordPress, Bob a member, and her location. */
async function withSite({ allowed = true, test = false } = {}) {
  const organization = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  db.memberships.push({ organization_id: organization.id, user_id: bob, role: "member" });
  db.memberships.push({ organization_id: organization.id, user_id: dave, role: "admin" });
  db.emails.set(alice, "alice@example.com");
  const kept = db.organizations.find((candidate) => candidate.id === organization.id);
  if (kept) {
    Object.assign(kept, {
      max_locations: 2,
      is_test: test,
      allowances: allowed ? { wordpress: true } : {},
    });
  }
  const location = LocationSchema.parse(
    await (
      await call(alice, "POST", `/organizations/${organization.id}/locations`, {
        name: "Joe's Pizza",
        city: "Raleigh",
        website: "joespizza.example",
      })
    ).json(),
  );
  return { organization, location };
}

const check = (user: string | null, locationId: string) =>
  call(user, "POST", `/locations/${locationId}/wordpress/check`);
const connect = (user: string | null, locationId: string, body: unknown = approved) =>
  call(user, "POST", `/locations/${locationId}/wordpress`, body);
const worker = async () => ({
  store: memoryStore(db, null),
  key: await sealingKey(SECRET),
  outside: { fetch: wordpress },
});

describe("connecting a location's WordPress site", () => {
  beforeEach(() => {
    db = createMemoryDb();
    queued = [];
    env = {
      PROVIDER_MODE: "live",
      CONNECTIONS_KEY: SECRET,
      SCAN_QUEUE: {
        send: async (message: ConnectionMessage) => {
          queued.push(message);
        },
        sendBatch: async (messages: { body: ConnectionMessage }[]) => {
          queued.push(...messages.map((message) => message.body));
        },
      },
    } as unknown as Env;
    vi.stubGlobal("fetch", wordpress);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("checks the website for an owner or admin, and says where to approve", async () => {
    const { location } = await withSite();
    for (const user of [alice, dave]) {
      const response = await check(user, location.id);
      expect(response.status, user).toBe(200);
      expect(WordPressCheckSchema.parse(await response.json()).verdict).toBe("ready");
    }
  });

  it("connects with what WordPress handed back, seals it, and the first sync matches the location", async () => {
    const { organization, location } = await withSite();
    const response = await connect(alice, location.id);
    expect(response.status).toBe(201);
    const text = await response.clone().text();
    expect(text).not.toContain(PASSWORD);
    const connection = ConnectionSchema.parse(await response.json());
    expect(connection).toMatchObject({
      organization_id: organization.id,
      kind: "wordpress",
      label: "joespizza.example",
      status: "working",
      connected_by_email: "alice@example.com",
      matches: [],
    });
    expect(queued).toEqual([{ connection_id: connection.id, step: "sync" }]);

    // What is kept is sealed, and opens to the sign-in with its password's own ID.
    const sealed = db.connectionSecrets.get(connection.id) ?? "";
    expect(sealed).not.toContain(PASSWORD);
    const key = await sealingKey(SECRET);
    if (!key) throw new Error("no key");
    expect(readWordPressSignIn(await open(key, connection.id, sealed))).toEqual({
      site: SITE,
      api: `${SITE}/wp-json/`,
      user: "owner",
      password: PASSWORD,
      uuid: UUID,
    });

    expect(await syncConnection(connection.id, await worker())).toBe("synced");
    const [synced] = db.connections;
    expect(synced?.choices).toEqual([{ id: SITE, label: "Joe's Pizza (joespizza.example)" }]);
    expect(synced?.matches).toMatchObject([{ location_id: location.id, external_id: SITE }]);
    // Once only: the match is the owner's from then on.
    expect(db.connectionsFrom.size).toBe(0);

    // And the location now says so, and connecting again is refused.
    const again = await check(alice, location.id);
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("already_connected");
  });

  it("is refused for another site, a refused password, or an account that cannot publish", async () => {
    const { location } = await withSite();
    for (const [body, code] of [
      [{ ...approved, site_url: "https://other.example" }, "not_this_site"],
      [{ ...approved, password: "wrong" }, "refused"],
    ] as const) {
      const response = await connect(alice, location.id, body);
      expect(response.status, code).toBe(422);
      expect((await errorOf(response)).code).toBe(code);
    }
    site.capabilities = { publish_pages: false };
    const editor = await connect(alice, location.id);
    expect((await errorOf(editor)).code).toBe("cannot_publish");
    expect(db.connections).toEqual([]);
    expect((await connect(alice, location.id, { site_url: SITE })).status).toBe(422);
  });

  it("answers nobody but an owner or admin, and not the operator", async () => {
    const { location } = await withSite();
    db.operators.add(carol);
    for (const user of [bob, carol]) {
      expect((await check(user, location.id)).status, user).toBe(404);
      expect((await connect(user, location.id)).status, user).toBe(404);
    }
    expect((await check(null, location.id)).status).toBe(401);
    expect(db.connections).toEqual([]);
    expect(site.asked).toEqual([]);
  });

  it("is not offered on a plan without it, for a test organization, or without a key", async () => {
    const without = await withSite({ allowed: false });
    expect((await errorOf(await check(alice, without.location.id))).code).toBe(
      "connection_unavailable",
    );
    db = createMemoryDb();
    const test = await withSite({ test: true });
    expect((await check(alice, test.location.id)).status).toBe(422);
    db = createMemoryDb();
    const keyless = await withSite();
    env = { ...env, CONNECTIONS_KEY: undefined } as Env;
    expect((await check(alice, keyless.location.id)).status).toBe(503);
    expect(site.asked).toEqual([]);
  });

  it("is never connected through the button for other accounts", async () => {
    const { organization } = await withSite();
    const response = await call(alice, "POST", `/organizations/${organization.id}/connections`, {
      kind: "wordpress",
    });
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("connect_from_location");
  });

  it("breaks at once when the site refuses the sign-in, and takes the password back on removal", async () => {
    const { location } = await withSite();
    const connection = ConnectionSchema.parse(await (await connect(alice, location.id)).json());
    await syncConnection(connection.id, await worker());

    const removing = await call(alice, "DELETE", `/connections/${connection.id}`);
    expect(removing.status).toBe(200);
    expect(await removeConnection(connection.id, await worker())).toBe("removed");
    expect(site.live).toBe(false);
    expect(site.asked.at(-1)?.method).toBe("DELETE");
    expect(db.connectionSecrets.has(connection.id)).toBe(false);

    // A second site whose password was taken back at WordPress.
    db = createMemoryDb();
    site.live = true;
    const other = await withSite();
    const second = ConnectionSchema.parse(await (await connect(alice, other.location.id)).json());
    site.live = false;
    expect(await syncConnection(second.id, await worker())).toBe("refused");
    expect(db.connections[0]).toMatchObject({ status: "broken", broken_reason: "refused" });
  });

  it("is removed all the same where the site cannot be asked to take the password back", async () => {
    const { location } = await withSite();
    const connection = ConnectionSchema.parse(await (await connect(alice, location.id)).json());
    await call(alice, "DELETE", `/connections/${connection.id}`);
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const deps = { ...(await worker()), outside: { fetch: down } };
    expect(await removeConnection(connection.id, deps)).toBe("removed");
    expect(db.connectionSecrets.has(connection.id)).toBe(false);
  });
});
