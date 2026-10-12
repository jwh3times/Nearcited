import {
  ConnectionMatchSchema,
  type ConnectionMessage,
  ConnectionSchema,
  LocationDetailSchema,
  LocationSchema,
  OrganizationConnectionsSchema,
  OrganizationSchema,
} from "@nearcited/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  availableConnectionKinds,
  enqueueDueSyncs,
  removeConnection,
  requeueFirstSyncs,
  requeueStalledRemovals,
  syncConnection,
} from "../src/connections";
import { open, seal, sealingKey } from "../src/connections/seal";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const carol = "c0000000-0000-4000-8000-000000000003";

/** A key as a deployment would hold it: 32 random bytes in base64. */
const newSecret = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const SECRET = newSecret();

let db: MemoryDb;
let queued: ConnectionMessage[];
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

/** Alice's organization, with Bob in it as a member and Carol a stranger to it. */
async function organizationWithMember() {
  const organization = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  db.memberships.push({ organization_id: organization.id, user_id: bob, role: "member" });
  db.emails.set(alice, "alice@example.com");
  return organization;
}

const connectSample = (user: string | null, organizationId: string) =>
  call(user, "POST", `/organizations/${organizationId}/connections`, { kind: "sample" });

const list = async (user: string, organizationId: string) =>
  OrganizationConnectionsSchema.parse(
    await (await call(user, "GET", `/organizations/${organizationId}/connections`)).json(),
  );

/** What the worker has: every row, and the key. */
const worker = async () => ({ store: memoryStore(db, null), key: await sealingKey(SECRET) });

/** Alice's organization with a sample account connected, and nothing queued left to look at. */
async function connected() {
  const organization = await organizationWithMember();
  const connection = ConnectionSchema.parse(
    await (await connectSample(alice, organization.id)).json(),
  );
  queued = [];
  return { organization, connection };
}

beforeEach(() => {
  db = createMemoryDb();
  queued = [];
  queueFails = false;
  env = {
    PROVIDER_MODE: "mock",
    CONNECTIONS_KEY: SECRET,
    SCAN_QUEUE: {
      send: async (message: ConnectionMessage) => {
        if (queueFails) throw new Error("The queue is down.");
        queued.push(message);
      },
      sendBatch: async (messages: { body: ConnectionMessage }[]) => {
        queued.push(...messages.map((message) => message.body));
      },
    },
  } as unknown as Env;
});

describe("sealing a sign-in", () => {
  const id = "d0000000-0000-4000-8000-000000000004";

  it("opens what it sealed for the same connection, and never seals the same way twice", async () => {
    const key = await sealingKey(SECRET);
    if (!key) throw new Error("no key");
    const sealed = await seal(key, id, "the sign-in");
    expect(sealed).not.toContain("the sign-in");
    expect(await open(key, id, sealed)).toBe("the sign-in");
    expect(await seal(key, id, "the sign-in")).not.toBe(sealed);
  });

  it("does not open for another connection, with another key, or once it was changed", async () => {
    const key = await sealingKey(SECRET);
    const other = await sealingKey(newSecret());
    if (!key || !other) throw new Error("no key");
    const sealed = await seal(key, id, "the sign-in");
    await expect(open(key, crypto.randomUUID(), sealed)).rejects.toThrow();
    await expect(open(other, id, sealed)).rejects.toThrow();
    const last = sealed.at(-2) === "A" ? "B" : "A";
    await expect(open(key, id, `${sealed.slice(0, -2)}${last}=`)).rejects.toThrow();
    await expect(open(key, id, "not sealed at all")).rejects.toThrow(/Not a sealed sign-in/);
  });

  it("has no key where none is set, and refuses a value that is not one", async () => {
    expect(await sealingKey(undefined)).toBeNull();
    expect(await sealingKey("")).toBeNull();
    await expect(sealingKey("not base64 !")).rejects.toThrow(/not base64/);
    await expect(sealingKey(btoa("too short"))).rejects.toThrow(/32 bytes/);
  });
});

describe("what can be connected", () => {
  it("is nothing without a key, and the sample account only where the data is generated", () => {
    const real = { is_test: false };
    const test = { is_test: true };
    expect(availableConnectionKinds({ PROVIDER_MODE: "mock" }, real)).toEqual([]);
    expect(
      availableConnectionKinds({ PROVIDER_MODE: "mock", CONNECTIONS_KEY: SECRET }, real),
    ).toEqual(["sample"]);
    expect(
      availableConnectionKinds({ PROVIDER_MODE: "live", CONNECTIONS_KEY: SECRET }, real),
    ).toEqual([]);
    expect(
      availableConnectionKinds({ PROVIDER_MODE: "live", CONNECTIONS_KEY: SECRET }, test),
    ).toEqual(["sample"]);
  });
});

describe("an organization's connections", () => {
  it("are listed for its members, with who may change them, and not for a stranger", async () => {
    const organization = await organizationWithMember();
    expect(await list(alice, organization.id)).toEqual({
      available: ["sample"],
      can_manage: true,
      connections: [],
    });
    expect((await list(bob, organization.id)).can_manage).toBe(false);
    expect((await call(carol, "GET", `/organizations/${organization.id}/connections`)).status).toBe(
      404,
    );
    expect((await call(null, "GET", `/organizations/${organization.id}/connections`)).status).toBe(
      401,
    );
  });

  it("are read by the operator, who may not change them", async () => {
    const organization = await organizationWithMember();
    await connectSample(alice, organization.id);
    db.operators.add(carol);
    const seen = await list(carol, organization.id);
    expect(seen.can_manage).toBe(false);
    expect(seen.connections).toHaveLength(1);
    expect((await connectSample(carol, organization.id)).status).toBe(404);
    const [connection] = seen.connections;
    expect((await call(carol, "DELETE", `/connections/${connection?.id}`)).status).toBe(404);
  });

  it("are made by an owner, with the sign-in sealed before it is kept and never sent back", async () => {
    const organization = await organizationWithMember();
    const response = await connectSample(alice, organization.id);
    expect(response.status).toBe(201);
    const text = await response.text();
    const connection = ConnectionSchema.parse(JSON.parse(text));
    expect(connection).toMatchObject({
      organization_id: organization.id,
      kind: "sample",
      label: "Sample account",
      status: "working",
      connected_by_email: "alice@example.com",
      removed_at: null,
    });

    const sealed = db.connectionSecrets.get(connection.id) ?? "";
    const key = await sealingKey(SECRET);
    if (!key) throw new Error("no key");
    const signIn = await open(key, connection.id, sealed);
    expect(signIn).toMatch(/^sample-/);
    expect(sealed).not.toContain(signIn);
    expect(text).not.toContain(signIn);
    expect(text).not.toContain(sealed);
    // Nor in the list, for anyone.
    const listed = await (
      await call(alice, "GET", `/organizations/${organization.id}/connections`)
    ).text();
    expect(listed).not.toContain(signIn);
    expect(listed).not.toContain(sealed);
    expect((await list(bob, organization.id)).connections).toEqual([connection]);
  });

  it("are not made by a member, a stranger or anyone signed out", async () => {
    const organization = await organizationWithMember();
    expect((await connectSample(bob, organization.id)).status).toBe(404);
    expect((await connectSample(carol, organization.id)).status).toBe(404);
    expect((await connectSample(null, organization.id)).status).toBe(401);
    expect(db.connections).toEqual([]);
    expect(db.connectionSecrets.size).toBe(0);
  });

  it("are made by an admin as well as the owner", async () => {
    const organization = await organizationWithMember();
    db.memberships.push({ organization_id: organization.id, user_id: carol, role: "admin" });
    expect((await connectSample(carol, organization.id)).status).toBe(201);
    expect((await list(carol, organization.id)).can_manage).toBe(true);
  });

  it("cannot be made without a key to seal with, or of a kind that is not offered here", async () => {
    const organization = await organizationWithMember();
    const unknown = await call(alice, "POST", `/organizations/${organization.id}/connections`, {
      kind: "nonesuch",
    });
    expect(unknown.status).toBe(422);

    // A real organization on real data has no sample account to connect.
    env = { ...env, PROVIDER_MODE: "live" } as Env;
    expect((await list(alice, organization.id)).available).toEqual([]);
    const live = await connectSample(alice, organization.id);
    expect(live.status).toBe(422);
    expect(await errorCode(live)).toBe("connection_unavailable");

    env = { ...env, PROVIDER_MODE: "mock", CONNECTIONS_KEY: undefined } as unknown as Env;
    expect((await list(alice, organization.id)).available).toEqual([]);
    const keyless = await connectSample(alice, organization.id);
    expect(keyless.status).toBe(503);
    expect(await errorCode(keyless)).toBe("connections_unavailable");
    expect(db.connections).toEqual([]);
  });

  it("offer the sample account to a test organization on real data too", async () => {
    db.testAccounts.add(alice);
    const organization = await organizationWithMember();
    env = { ...env, PROVIDER_MODE: "live" } as Env;
    expect((await list(alice, organization.id)).available).toEqual(["sample"]);
    expect((await connectSample(alice, organization.id)).status).toBe(201);
  });
});

describe("removing a connection", () => {
  const remove = (user: string | null, id: string) => call(user, "DELETE", `/connections/${id}`);

  it("is asked for by an owner, stops it at once, and is finished by the worker", async () => {
    const { organization, connection } = await connected();
    db.emails.set(alice, "alice@example.com");
    const response = await remove(alice, connection.id);
    expect(response.status).toBe(200);
    expect(ConnectionSchema.parse(await response.json())).toMatchObject({
      status: "removing",
      removed_by_email: "alice@example.com",
      removed_at: null,
    });
    expect(queued).toEqual([{ connection_id: connection.id, step: "remove" }]);
    // The request could not read the sign-in, so it is still there for the worker.
    expect(db.connectionSecrets.has(connection.id)).toBe(true);

    expect(await removeConnection(connection.id, await worker())).toBe("removed");
    expect(db.connectionSecrets.has(connection.id)).toBe(false);
    const [kept] = (await list(bob, organization.id)).connections;
    // The record of who connected it and who removed it stays.
    expect(kept).toMatchObject({
      id: connection.id,
      status: "removed",
      connected_by_email: "alice@example.com",
      removed_by_email: "alice@example.com",
    });
    expect(kept?.removed_at).not.toBeNull();
    // A message delivered twice finds nothing left to do.
    expect(await removeConnection(connection.id, await worker())).toBe("not_waiting");
  });

  it("is not for a member, a stranger or anyone signed out, and leaves the sign-in alone", async () => {
    const { connection } = await connected();
    expect((await remove(bob, connection.id)).status).toBe(404);
    expect((await remove(carol, connection.id)).status).toBe(404);
    expect((await remove(null, connection.id)).status).toBe(401);
    expect((await remove(alice, crypto.randomUUID())).status).toBe(404);
    expect(db.connections[0]?.status).toBe("working");
    expect(queued).toEqual([]);
    // The worker removes only what was asked to be removed.
    expect(await removeConnection(connection.id, await worker())).toBe("not_waiting");
    expect(db.connectionSecrets.has(connection.id)).toBe(true);
  });

  it("can be asked for twice, and once it is done there is nothing more to queue", async () => {
    const { connection } = await connected();
    await remove(alice, connection.id);
    expect((await remove(alice, connection.id)).status).toBe(200);
    expect(queued).toHaveLength(2);
    await removeConnection(connection.id, await worker());
    const done = await remove(alice, connection.id);
    expect(ConnectionSchema.parse(await done.json()).status).toBe("removed");
    expect(queued).toHaveLength(2);
  });

  it("is finished even when the sign-in cannot be opened, or there is no key any more", async () => {
    const first = await connected();
    await remove(alice, first.connection.id);
    const otherKey = await sealingKey(newSecret());
    expect(
      await removeConnection(first.connection.id, { store: memoryStore(db, null), key: otherKey }),
    ).toBe("removed");
    expect(db.connectionSecrets.has(first.connection.id)).toBe(false);

    const second = ConnectionSchema.parse(
      await (await connectSample(alice, first.organization.id)).json(),
    );
    queued = [];
    await remove(alice, second.id);
    expect(await removeConnection(second.id, { store: memoryStore(db, null), key: null })).toBe(
      "removed",
    );
    expect(db.connectionSecrets.size).toBe(0);
  });

  it("is asked of the worker again by the schedule when its message was lost", async () => {
    const { connection } = await connected();
    queueFails = true;
    // The request still succeeds: the connection has stopped being used.
    expect((await remove(alice, connection.id)).status).toBe(200);
    expect(queued).toEqual([]);
    queueFails = false;

    const store = memoryStore(db, null);
    const asked = Date.parse(db.connections[0]?.removal_requested_at ?? "");
    expect(await requeueStalledRemovals(store, env.SCAN_QUEUE, asked + 14 * 60_000)).toBe(0);
    expect(await requeueStalledRemovals(store, env.SCAN_QUEUE, asked + 16 * 60_000)).toBe(1);
    expect(queued).toEqual([{ connection_id: connection.id, step: "remove" }]);
    await removeConnection(connection.id, await worker());
    expect(await requeueStalledRemovals(store, env.SCAN_QUEUE, asked + 60 * 60_000)).toBe(0);
  });
});

describe("syncing a connection", () => {
  it("is asked of the worker as soon as an account is connected, and reads what it reaches", async () => {
    const organization = await organizationWithMember();
    const connection = ConnectionSchema.parse(
      await (await connectSample(alice, organization.id)).json(),
    );
    expect(queued).toEqual([{ connection_id: connection.id, step: "sync" }]);
    // The request could not read the sign-in, so it knows nothing of what the account reaches.
    expect(connection).toMatchObject({ last_synced_at: null, choices: [], matches: [] });

    expect(await syncConnection(connection.id, await worker())).toBe("synced");
    const [synced] = (await list(bob, organization.id)).connections;
    expect(synced?.last_synced_at).not.toBeNull();
    expect(synced?.choices).toHaveLength(3);
    for (const choice of synced?.choices ?? []) expect(choice.label).toMatch(/^Sample listing/);
    // A message delivered twice reads the same thing again.
    expect(await syncConnection(connection.id, await worker())).toBe("synced");
    expect((await list(bob, organization.id)).connections[0]?.choices).toHaveLength(3);
  });

  it("leaves alone one that is being removed, and one whose sign-in it cannot open", async () => {
    const { connection } = await connected();
    expect(
      await syncConnection(connection.id, {
        store: memoryStore(db, null),
        key: await sealingKey(newSecret()),
      }),
    ).toBe("unreadable");
    expect(await syncConnection(connection.id, { store: memoryStore(db, null), key: null })).toBe(
      "unreadable",
    );
    expect(db.connections[0]).toMatchObject({ last_synced_at: null, choices: [] });

    await call(alice, "DELETE", `/connections/${connection.id}`);
    expect(await syncConnection(connection.id, await worker())).toBe("not_working");
    expect(await syncConnection(crypto.randomUUID(), await worker())).toBe("not_working");
  });

  it("is queued once a day for each working connection, and never for one that is gone", async () => {
    const { connection } = await connected();
    const store = memoryStore(db, null);
    expect(await enqueueDueSyncs(store, env.SCAN_QUEUE)).toBe(1);
    expect(queued).toEqual([{ connection_id: connection.id, step: "sync" }]);

    // The store's clock is set, so "a day ago" is measured from when the sync was recorded.
    const synced = Date.now();
    db.now = new Date(synced).toISOString();
    await syncConnection(connection.id, await worker());
    expect(await enqueueDueSyncs(store, env.SCAN_QUEUE)).toBe(0);
    db.now = new Date(synced + 19 * 3_600_000).toISOString();
    expect(await enqueueDueSyncs(store, env.SCAN_QUEUE)).toBe(0);
    db.now = new Date(synced + 21 * 3_600_000).toISOString();
    expect(await enqueueDueSyncs(store, env.SCAN_QUEUE)).toBe(1);

    await call(alice, "DELETE", `/connections/${connection.id}`);
    expect(await enqueueDueSyncs(store, env.SCAN_QUEUE)).toBe(0);
  });

  it("has its first sync asked for again when the message was lost, for a day", async () => {
    const organization = await organizationWithMember();
    queueFails = true;
    // Connecting still succeeds: the account is connected, and what it reaches comes later.
    const response = await connectSample(alice, organization.id);
    expect(response.status).toBe(201);
    const connection = ConnectionSchema.parse(await response.json());
    expect(queued).toEqual([]);
    queueFails = false;

    const store = memoryStore(db, null);
    const made = Date.parse(connection.connected_at);
    expect(await requeueFirstSyncs(store, env.SCAN_QUEUE, made + 14 * 60_000)).toBe(0);
    expect(await requeueFirstSyncs(store, env.SCAN_QUEUE, made + 16 * 60_000)).toBe(1);
    expect(queued).toEqual([{ connection_id: connection.id, step: "sync" }]);
    // After a day the daily run has it, so the sweep stops asking.
    expect(await requeueFirstSyncs(store, env.SCAN_QUEUE, made + 25 * 3_600_000)).toBe(0);
    await syncConnection(connection.id, await worker());
    expect(await requeueFirstSyncs(store, env.SCAN_QUEUE, made + 30 * 60_000)).toBe(0);
  });
});

describe("matching a location to what an account reaches", () => {
  /** A synced sample account, and two locations of Alice's organization. */
  async function synced() {
    const { organization, connection } = await connected();
    await syncConnection(connection.id, await worker());
    const locations = [];
    for (const name of ["Joe's Pizza", "Joe's Pizza Uptown"]) {
      locations.push(
        LocationSchema.parse(
          await (
            await call(alice, "POST", `/organizations/${organization.id}/locations`, {
              name,
              city: "Raleigh",
            })
          ).json(),
        ),
      );
    }
    const [first, second] = locations;
    if (!first || !second) throw new Error("no locations");
    return { organization, connection, first, second };
  }
  const match = (user: string | null, connectionId: string, locationId: string, external: string) =>
    call(user, "PUT", `/connections/${connectionId}/locations/${locationId}`, {
      external_id: external,
    });
  const unmatch = (user: string | null, connectionId: string, locationId: string) =>
    call(user, "DELETE", `/connections/${connectionId}/locations/${locationId}`);
  const matchesOf = async (organizationId: string) =>
    (await list(bob, organizationId)).connections[0]?.matches.map((kept) => [
      kept.location_id,
      kept.external_id,
    ]);

  it("is said by an owner, from what the last sync found, and shown on the location", async () => {
    const { organization, connection, first } = await synced();
    const response = await match(alice, connection.id, first.id, "sample-listing-2");
    expect(response.status).toBe(200);
    expect(ConnectionMatchSchema.parse(await response.json())).toMatchObject({
      location_id: first.id,
      external_id: "sample-listing-2",
      external_label: "Sample listing: Riverside",
    });
    expect(await matchesOf(organization.id)).toEqual([[first.id, "sample-listing-2"]]);

    const detail = LocationDetailSchema.parse(
      await (await call(bob, "GET", `/locations/${first.id}`)).json(),
    );
    expect(detail.connections).toEqual([
      {
        connection_id: connection.id,
        kind: "sample",
        label: "Sample account",
        external_label: "Sample listing: Riverside",
      },
    ]);
    // Said again, it replaces what was said before.
    expect((await match(alice, connection.id, first.id, "sample-listing-3")).status).toBe(200);
    expect(await matchesOf(organization.id)).toEqual([[first.id, "sample-listing-3"]]);
  });

  it("refuses what the account does not reach, what is another location's, and a second account of a kind", async () => {
    const { organization, connection, first, second } = await synced();
    const unreached = await match(alice, connection.id, first.id, "nonesuch");
    expect(unreached.status).toBe(409);
    expect(await errorCode(unreached)).toBe("limit_reached");
    expect((await match(alice, connection.id, first.id, "  ")).status).toBe(422);

    await match(alice, connection.id, first.id, "sample-listing-1");
    expect((await match(alice, connection.id, second.id, "sample-listing-1")).status).toBe(409);

    const other = ConnectionSchema.parse(
      await (await connectSample(alice, organization.id)).json(),
    );
    await syncConnection(other.id, await worker());
    expect((await match(alice, other.id, first.id, "sample-listing-2")).status).toBe(409);
    expect((await match(alice, other.id, second.id, "sample-listing-2")).status).toBe(200);
    expect(await matchesOf(organization.id)).toHaveLength(1);
  });

  it("is not for a member, a stranger, or a location of another organization", async () => {
    const { connection, first } = await synced();
    expect((await match(bob, connection.id, first.id, "sample-listing-1")).status).toBe(404);
    expect((await match(null, connection.id, first.id, "sample-listing-1")).status).toBe(401);
    expect((await match(alice, crypto.randomUUID(), first.id, "sample-listing-1")).status).toBe(
      404,
    );

    // Carol's own organization and location: Alice cannot match her account to it.
    const theirs = OrganizationSchema.parse(
      await (await call(carol, "POST", "/organizations", { name: "Durham Tacos" })).json(),
    );
    const elsewhere = LocationSchema.parse(
      await (
        await call(carol, "POST", `/organizations/${theirs.id}/locations`, {
          name: "Durham Tacos",
          city: "Durham",
        })
      ).json(),
    );
    expect((await match(alice, connection.id, elsewhere.id, "sample-listing-1")).status).toBe(404);
    expect((await match(carol, connection.id, elsewhere.id, "sample-listing-1")).status).toBe(404);
    expect(db.connections[0]?.matches).toEqual([]);
  });

  it("can be taken away by an owner, and goes with the account when it is removed", async () => {
    const { organization, connection, first, second } = await synced();
    await match(alice, connection.id, first.id, "sample-listing-1");
    await match(alice, connection.id, second.id, "sample-listing-2");
    expect((await unmatch(bob, connection.id, first.id)).status).toBe(404);
    expect((await unmatch(alice, connection.id, first.id)).status).toBe(204);
    expect((await unmatch(alice, connection.id, first.id)).status).toBe(404);
    expect(await matchesOf(organization.id)).toEqual([[second.id, "sample-listing-2"]]);

    await call(alice, "DELETE", `/connections/${connection.id}`);
    // Being removed, it takes no new match.
    expect((await match(alice, connection.id, first.id, "sample-listing-1")).status).toBe(409);
    await removeConnection(connection.id, await worker());
    expect(db.connections[0]).toMatchObject({ status: "removed", choices: [], matches: [] });
    const detail = LocationDetailSchema.parse(
      await (await call(alice, "GET", `/locations/${second.id}`)).json(),
    );
    expect(detail.connections).toEqual([]);
  });

  it("keeps its choice and takes the name the choice has at the next sync", async () => {
    const { connection, first } = await synced();
    await match(alice, connection.id, first.id, "sample-listing-1");
    await memoryStore(db, null).recordConnectionSync(connection.id, [
      { id: "sample-listing-1", label: "Renamed at the outside service" },
    ]);
    expect(db.connections[0]?.matches).toMatchObject([
      { external_id: "sample-listing-1", external_label: "Renamed at the outside service" },
    ]);
  });
});
