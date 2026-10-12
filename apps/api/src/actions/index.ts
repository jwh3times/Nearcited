import type {
  Action,
  ActionKind,
  ActionMessage,
  Connection,
  ConnectionMatch,
} from "@nearcited/shared";
import { SignInRefused } from "../connections";
import { open } from "../connections/seal";
import type { Store } from "../store/types";

/**
 * Actions: what the product does outside itself for a location, once a member said yes
 * (docs/adr/0014-only-the-worker-carries-out-an-action.md).
 *
 * Everything here runs in the worker. It proposes after a sync, and it carries out what was
 * approved, because both need what only the worker can read: the sign-in.
 */

export interface ActionDeps {
  store: Store;
  /** The key this deployment seals with. Null where none is set. */
  key: CryptoKey | null;
}

/** What a kind of action is given to work with: the account, and what of it is the location's. */
interface Target {
  store: Store;
  connection: Connection;
  match: ConnectionMatch;
  signIn: string;
}

/** How one kind of action reads what is there now and makes its change. */
interface ActionHandler {
  /** What is there now, as the text a member would be shown. Null when there is nothing. */
  current(target: Target): Promise<string | null>;
  /** Puts the text there. */
  apply(target: Target, text: string): Promise<void>;
}

/**
 * The sample kind changes the opening line of one of the sample account's listings. The
 * listings exist nowhere but in this product's own table, so nothing leaves it.
 */
const sample: ActionHandler = {
  current: ({ store, connection, match }) => store.getSampleLine(connection.id, match.external_id),
  apply: ({ store, connection, match }, text) =>
    store.setSampleLine(connection.id, match.external_id, text),
};

const HANDLERS: Record<ActionKind, ActionHandler> = { sample };

/** What the sample listing of a location should open with, composed by rule from its details. */
export function sampleOpeningLine(location: { name: string; city: string | null }): string {
  const place = location.city ? ` in ${location.city}` : "";
  return `${location.name}${place}: open every day. Call ahead for large orders.`;
}

/**
 * Proposes what a connection's last sync shows could be done, for each location matched to it.
 * A proposal the store refuses, because one is already waiting or was declined, is not made
 * again. Returns how many were proposed.
 *
 * Only the sample kind proposes so far: it offers to set its sample listing's opening line to
 * what the location's own details say.
 */
export async function proposeAfterSync(
  connectionId: string,
  { store, key }: ActionDeps,
): Promise<number> {
  const connection = await store.getConnection(connectionId);
  if (connection?.status !== "working" || connection.kind !== "sample" || !key) return 0;
  const sealed = await store.getConnectionSecret(connectionId);
  if (!sealed) return 0;
  let signIn: string;
  try {
    signIn = await open(key, connectionId, sealed);
  } catch {
    return 0;
  }

  let proposed = 0;
  for (const match of connection.matches) {
    const location = await store.getLocation(match.location_id);
    if (!location) continue;
    const text = sampleOpeningLine(location);
    const now = await sample.current({ store, connection, match, signIn });
    if (now === text) continue;
    const made = await store.proposeAction({
      location_id: location.id,
      kind: "sample",
      connection_id: connection.id,
      subject: `opening-line:${match.external_id}`,
      basis: text,
      summary: `Set the opening line of ${match.external_label}`,
      seen: { text: now },
      proposed_text: text,
      written_by: "rule",
    });
    if (made) proposed++;
  }
  return proposed;
}

/** How many times an action is tried before it is marked failed. */
const MOST_ATTEMPTS = 3;

export type CarriedOut = "done" | "failed" | "out_of_date" | "again" | "not_approved" | "busy";

/** The text an action puts there: what was approved, which is the proposal unless it was changed. */
export const actionText = (action: Pick<Action, "approved_text" | "proposed_text">) =>
  action.approved_text ?? action.proposed_text;

/**
 * Carries out one approved action, once.
 *
 * It looks first at what is there now. If that is already what the action would make it, the
 * action is done and nothing is written: this is what makes a message delivered twice harmless.
 * If it is no longer what the member was shown, nothing is written either and the action lapses
 * as out of date, since a yes to one change is not a yes to another.
 *
 * A try that does not work is tried again, up to three times, and then the action is failed
 * with the reason. `again` asks whoever called to have it delivered again later.
 */
export async function carryOutAction(
  actionId: string,
  { store, key }: ActionDeps,
): Promise<CarriedOut> {
  const action = await store.getAction(actionId);
  if (action?.status !== "approved") return "not_approved";
  const attempt = await store.claimAction(actionId);
  if (attempt === 0) return "busy";

  const fail = async (why: string): Promise<CarriedOut> => {
    await store.finishAction(actionId, "failed", why);
    return "failed";
  };

  const connection = action.connection_id ? await store.getConnection(action.connection_id) : null;
  if (connection?.status !== "working") {
    return fail("The account this goes through is not connected, or is not working.");
  }
  const match = connection.matches.find((kept) => kept.location_id === action.location_id);
  if (!match) return fail("This location is no longer matched to that account.");
  const sealed = await store.getConnectionSecret(connection.id);
  if (!sealed || !key) return fail("The account's sign-in could not be read.");
  let signIn: string;
  try {
    signIn = await open(key, connection.id, sealed);
  } catch {
    return fail("The account's sign-in could not be read.");
  }
  const text = actionText(action);
  if (text === null) return fail("There is nothing for this action to put there.");

  const handler = HANDLERS[action.kind];
  const target = { store, connection, match, signIn };
  try {
    const now = await handler.current(target);
    if (now === text) {
      await store.finishAction(actionId, "done");
      return "done";
    }
    if (now !== (action.seen?.text ?? null)) {
      await store.finishAction(actionId, "out_of_date");
      return "out_of_date";
    }
    await handler.apply(target, text);
    await store.finishAction(actionId, "done");
    return "done";
  } catch (error) {
    const why = error instanceof Error ? error.message : "It could not be done.";
    console.error(`Action ${actionId}: a try at carrying it out failed`, error);
    // A refused sign-in will not work the next time either.
    if (error instanceof SignInRefused) return fail("The account refused the sign-in.");
    if (attempt >= MOST_ATTEMPTS) return fail(why);
    await store.finishAction(actionId, "again", why);
    return "again";
  }
}

/** The one queue method used here. `env.SCAN_QUEUE` satisfies it. */
type ActionQueue = Pick<Queue<ActionMessage>, "sendBatch">;

/**
 * How long an approved action may sit before it is queued again. Longer than the ten minutes a
 * worker's hold on one lasts, so one a worker took and died with can be taken by the next.
 */
const STALLED_AFTER_MS = 15 * 60_000;

/**
 * Queues again every approved action nobody is carrying out: its message was lost, the worker
 * let go of it to be tried again, or the worker that took it died. Returns how many.
 */
export async function requeueStalledActions(
  store: Store,
  queue: ActionQueue,
  now = Date.now(),
): Promise<number> {
  const stalled = await store.listStalledActions(new Date(now - STALLED_AFTER_MS).toISOString());
  if (stalled.length === 0) return 0;
  await queue.sendBatch(
    stalled.slice(0, 100).map((id) => ({ body: { action_id: id, step: "carry_out" as const } })),
  );
  return Math.min(stalled.length, 100);
}
