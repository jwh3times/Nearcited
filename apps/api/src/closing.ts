import type { ClosingMessage } from "@nearcited/shared";
import type { Payments } from "./billing/types";
import { type ConnectionDeps, removeConnection } from "./connections";
import { buildClosedNote, buildClosingEmail } from "./email/closing";
import type { Store } from "./store/types";

/** What the worker needs to close an account. */
export interface ClosingDeps extends ConnectionDeps {
  /** The payment provider. Null where none is set up, and then no subscription can be cancelled. */
  payments: Payments | null;
}

/**
 * Closes an account its owner asked to close (docs/adr/0020-the-worker-closes-an-account.md):
 * cancels the subscription, removes every connection the way an owner removes one, deletes the
 * organization and the owner's sign-in, and sends one email. Each step is written down as it is
 * done and is safe to run again, so a retry picks up where the last try stopped.
 */
export async function closeAccount(
  closingId: string,
  deps: ClosingDeps,
): Promise<"closed" | "not_waiting"> {
  const { store } = deps;
  // One worker at a time: a retry and the schedule's sweep can both ask for the same closing.
  if (!(await store.claimClosing(closingId))) return "not_waiting";
  try {
    return await close(closingId, deps);
  } catch (error) {
    await store.releaseClosing(closingId);
    throw error;
  }
}

/** A subscription that is over: cancelling it again does nothing and is not news. */
const ENDED = new Set(["canceled", "unpaid", "incomplete_expired"]);

async function close(closingId: string, deps: ClosingDeps): Promise<"closed" | "not_waiting"> {
  const { store, payments, send } = deps;
  const closing = await store.getClosing(closingId);
  if (!closing || closing.finished_at !== null) return "not_waiting";
  const org = closing.organization_id;
  const name = closing.organization_name ?? "Your organization";

  if (closing.cancelled_at === null) {
    const subscription = await store.getSubscription(org);
    const paying =
      subscription?.stripe_subscription_id && !ENDED.has(subscription.status ?? "")
        ? subscription.stripe_subscription_id
        : null;
    if (paying) {
      if (!payments) throw new Error(`Closing ${closingId}: no payment provider to cancel with`);
      await payments.cancelNow(paying);
    }
    closing.cancelled_at = new Date().toISOString();
    closing.had_subscription = paying !== null;
    await store.recordClosingProgress(closingId, {
      cancelled_at: closing.cancelled_at,
      had_subscription: closing.had_subscription,
    });
  }

  if (closing.organization_deleted_at === null) {
    for (const connection of await store.listConnections(org)) {
      if (connection.status === "removed") continue;
      const hostname =
        connection.kind === "hosted_pages"
          ? ((await store.getAnswerSubdomain(connection.id))?.hostname ?? null)
          : null;
      // Throws where Cloudflare has not let a subdomain go, which holds the closing until it has.
      const outcome = await removeConnection(connection.id, deps);
      if (outcome === "left_at_site") closing.left_at_sites.push(connection.label);
      if (hostname && outcome !== "not_waiting") closing.hostnames.push(hostname);
      await store.recordClosingProgress(closingId, {
        left_at_sites: closing.left_at_sites,
        hostnames: closing.hostnames,
      });
    }
    const left = (await store.listConnections(org)).filter((c) => c.status !== "removed");
    if (left.length > 0) {
      throw new Error(`Closing ${closingId}: ${left.length} connections are not removed yet`);
    }
    await store.deleteClosedOrganization(org);
    closing.organization_deleted_at = new Date().toISOString();
    await store.recordClosingProgress(closingId, {
      organization_deleted_at: closing.organization_deleted_at,
    });
  }

  if (closing.account_deleted_at === null) {
    if (closing.owner_id) await store.deleteAccount(closing.owner_id);
    await store.recordClosingProgress(closingId, { account_deleted_at: new Date().toISOString() });
  }

  // Where email is not set up, there is nobody to tell, and nothing to keep for telling them.
  // Each email is written down as sent, so a retry sends neither twice.
  if (send && closing.owner_email && closing.told_at === null) {
    await send(
      [closing.owner_email],
      buildClosingEmail({
        organization: name,
        cancelled: closing.had_subscription,
        leftAtSites: closing.left_at_sites,
        hostnames: closing.hostnames,
      }),
    );
    await store.recordClosingProgress(closingId, { told_at: new Date().toISOString() });
  }
  if (send && closing.member_emails.length > 0 && closing.noted_at === null) {
    await send(closing.member_emails, buildClosedNote(name));
    await store.recordClosingProgress(closingId, { noted_at: new Date().toISOString() });
  }
  await store.finishClosing(closingId);
  return "closed";
}

/** How long a closing may wait before the schedule asks the worker for it again. */
const STALLED_AFTER_MS = 15 * 60_000;

/**
 * Queues again every closing that was asked for and has not been finished: its message was lost,
 * or the worker failed part-way, waiting on Cloudflare for instance. Returns how many.
 */
export async function requeueStalledClosings(
  store: Store,
  queue: Pick<Queue<ClosingMessage>, "sendBatch">,
  now = Date.now(),
): Promise<number> {
  const stalled = await store.listStalledClosings(new Date(now - STALLED_AFTER_MS).toISOString());
  if (stalled.length === 0) return 0;
  await queue.sendBatch(
    stalled.map((id) => ({ body: { closing_id: id, step: "close" as const } })),
  );
  return stalled.length;
}

/** How long the fingerprint of a closed account's email is kept. */
const KEPT_FOR_MS = 30 * 86_400_000;

/** Forgets every closing that finished thirty days ago or more. Returns how many. */
export async function dropFinishedClosings(store: Store, now = Date.now()): Promise<number> {
  return store.dropFinishedClosings(new Date(now - KEPT_FOR_MS).toISOString());
}
