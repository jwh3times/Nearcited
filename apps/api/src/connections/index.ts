import type {
  ConnectionChoice,
  ConnectionKind,
  ConnectionMessage,
  Organization,
} from "@nearcited/shared";
import type { Env } from "../env";
import { usesSampleData } from "../providers";
import type { Store } from "../store/types";
import { open } from "./seal";

/**
 * The kinds of account an organization can connect in this deployment. None without a key to
 * seal the sign-in with. `sample` only where the data is generated: a deployment on sample data,
 * or a test organization in any deployment.
 */
export function availableConnectionKinds(
  env: Pick<Env, "CONNECTIONS_KEY" | "PROVIDER_MODE">,
  organization: Pick<Organization, "is_test">,
): ConnectionKind[] {
  if (!env.CONNECTIONS_KEY) return [];
  return usesSampleData(env) || organization.is_test ? ["sample"] : [];
}

/** What connecting an account comes to: what to call it, and the sign-in to keep. */
export interface Connected {
  label: string;
  signIn: string;
}

/** Signs in to an account of one kind. The sample kind has nowhere to sign in to, so it makes one up. */
export async function connect(kind: ConnectionKind): Promise<Connected> {
  switch (kind) {
    case "sample":
      return { label: "Sample account", signIn: `sample-${crypto.randomUUID()}` };
  }
}

/** What a sync finds: the things the sign-in reaches, for a location to be matched to one. */
export interface Reached {
  choices: ConnectionChoice[];
}

/** The sample account reaches three listings that exist nowhere, and are named as such. */
const SAMPLE_CHOICES: ConnectionChoice[] = [
  { id: "sample-listing-1", label: "Sample listing: Main Street" },
  { id: "sample-listing-2", label: "Sample listing: Riverside" },
  { id: "sample-listing-3", label: "Sample listing: Uptown" },
];

/** Reads from an account of one kind with its sign-in. The sample kind asks nobody anything. */
async function read(kind: ConnectionKind, _signIn: string): Promise<Reached> {
  switch (kind) {
    case "sample":
      return { choices: SAMPLE_CHOICES };
  }
}

/** Takes back, at the outside service, the access a sign-in gave. The sample kind gave none. */
async function withdraw(kind: ConnectionKind, _signIn: string): Promise<void> {
  switch (kind) {
    case "sample":
      return;
  }
}

/** What the worker needs to do anything with a connection's sign-in. */
export interface ConnectionDeps {
  store: Store;
  /** The key this deployment seals with. Null where none is set. */
  key: CryptoKey | null;
}

/**
 * Finishes removing a connection its owner asked to have removed: withdraws the access at the
 * outside service, then deletes the sign-in. Only the worker can do either, because only it can
 * read the sign-in. Safe to run twice.
 *
 * A sign-in that cannot be opened is deleted all the same: the owner asked for it gone, and one
 * this Worker cannot open is no use to it either.
 */
export async function removeConnection(
  connectionId: string,
  { store, key }: ConnectionDeps,
): Promise<"removed" | "not_waiting"> {
  const connection = await store.getConnection(connectionId);
  if (connection?.status !== "removing") return "not_waiting";

  const sealed = await store.getConnectionSecret(connectionId);
  if (sealed && key) {
    let signIn: string | null = null;
    try {
      signIn = await open(key, connectionId, sealed);
    } catch (error) {
      console.error(`Connection ${connectionId}: its sign-in could not be opened`, error);
    }
    if (signIn !== null) await withdraw(connection.kind, signIn);
  }
  return (await store.finishConnectionRemoval(connectionId)) ? "removed" : "not_waiting";
}

/**
 * Syncs one connection: reads what its sign-in reaches and keeps that. Only the worker can,
 * because only it can read the sign-in. Safe to run twice.
 *
 * `unreadable` is a sign-in this Worker cannot open: there is no key, or it is not the key the
 * sign-in was sealed with. Nothing is changed, and trying again would not help.
 */
export async function syncConnection(
  connectionId: string,
  { store, key }: ConnectionDeps,
): Promise<"synced" | "not_working" | "unreadable"> {
  const connection = await store.getConnection(connectionId);
  if (connection?.status !== "working") return "not_working";

  const sealed = await store.getConnectionSecret(connectionId);
  if (!sealed || !key) return "unreadable";
  let signIn: string;
  try {
    signIn = await open(key, connectionId, sealed);
  } catch (error) {
    console.error(`Connection ${connectionId}: its sign-in could not be opened`, error);
    return "unreadable";
  }

  const { choices } = await read(connection.kind, signIn);
  return (await store.recordConnectionSync(connectionId, choices)) ? "synced" : "not_working";
}

/** The most connections one run of the schedule queues, which is one `sendBatch`. */
const BATCH_LIMIT = 100;

/**
 * Queues a sync for every working connection that is due: once a day each. Returns how many.
 * Connections beyond the limit wait for the next run; the longest-waiting go first.
 */
export async function enqueueDueSyncs(
  store: Store,
  queue: Pick<Queue<ConnectionMessage>, "sendBatch">,
): Promise<number> {
  const due = await store.listConnectionsDueForSync(BATCH_LIMIT);
  if (due.length === 0) return 0;
  await queue.sendBatch(due.map((id) => ({ body: { connection_id: id, step: "sync" as const } })));
  return due.length;
}

/** How long a new connection's first sync may be missing before it is asked for again. */
const FIRST_SYNC_AFTER_MS = 15 * 60_000;
/** After this long the daily run has it, so the sweep stops asking. */
const FIRST_SYNC_UNTIL_MS = 24 * 3_600_000;

/**
 * Queues again the first sync of every connection made in the last day that still has none: its
 * message was lost, or the worker failed. Without it the owner would wait for the daily run to
 * choose what each location is matched to. Returns how many.
 */
export async function requeueFirstSyncs(
  store: Store,
  queue: Pick<Queue<ConnectionMessage>, "sendBatch">,
  now = Date.now(),
): Promise<number> {
  const waiting = await store.listConnectionsAwaitingFirstSync(
    new Date(now - FIRST_SYNC_UNTIL_MS).toISOString(),
    new Date(now - FIRST_SYNC_AFTER_MS).toISOString(),
  );
  if (waiting.length === 0) return 0;
  await queue.sendBatch(
    waiting
      .slice(0, BATCH_LIMIT)
      .map((id) => ({ body: { connection_id: id, step: "sync" as const } })),
  );
  return Math.min(waiting.length, BATCH_LIMIT);
}

/** How long a removal may wait before the schedule asks the worker for it again. */
const STALLED_AFTER_MS = 15 * 60_000;

/**
 * Queues again every removal that was asked for and has not been finished: its message was lost,
 * or the worker failed part-way. Returns how many.
 */
export async function requeueStalledRemovals(
  store: Store,
  queue: Pick<Queue<ConnectionMessage>, "sendBatch">,
  now = Date.now(),
): Promise<number> {
  const stalled = await store.listStalledRemovals(new Date(now - STALLED_AFTER_MS).toISOString());
  if (stalled.length === 0) return 0;
  await queue.sendBatch(
    stalled.map((id) => ({ body: { connection_id: id, step: "remove" as const } })),
  );
  return stalled.length;
}
