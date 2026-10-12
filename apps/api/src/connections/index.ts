import type { ConnectionKind, ConnectionMessage, Organization } from "@nearcited/shared";
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

/** Takes back, at the outside service, the access a sign-in gave. The sample kind gave none. */
async function withdraw(kind: ConnectionKind, _signIn: string): Promise<void> {
  switch (kind) {
    case "sample":
      return;
  }
}

export interface RemovalDeps {
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
  { store, key }: RemovalDeps,
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
