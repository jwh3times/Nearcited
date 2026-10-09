import type { PriceChange, PriceChangeMessage, PriceChangeStep } from "@nearcited/shared";
import { buildPriceChangeEmail } from "../email/price-change";
import type { Email } from "../email/report";
import type { Store } from "../store/types";
import { itemsFor, monthlyCents, type PaidPlan, readItems } from "./plans";
import type { Payments } from "./types";

const DAY_MS = 86_400_000;
/** How long before a price goes up its subscribers must have been told. */
export const NOTICE_MS = 30 * DAY_MS;
/** How long before it takes effect the reminder goes out. */
export const REMINDER_MS = 7 * DAY_MS;
/** How long after it takes effect a change is kept open for subscriptions not yet moved. */
const GIVE_UP_MS = 60 * DAY_MS;

export interface PriceChangeDeps {
  /** The worker's store. */
  store: Store;
  payments: Payments;
  /** Sends an email to an organization's owners. Throws when it could not be sent. */
  send: (to: string[], email: Email) => Promise<void>;
  appUrl: string;
  now?: Date;
}

/** What a step came to, for the log. */
export type StepOutcome =
  | "told"
  | "reminded"
  | "told it is off"
  | "moved"
  | "nothing to do"
  | "skipped"
  | "waiting"
  | "not given notice";

/**
 * Takes one step of a price change for one organization: tell its owners, remind them, tell
 * them it is off, or move its subscription to the new prices.
 *
 * Every step starts from the subscription as the provider has it now, so a message that arrives
 * twice, or after the organization has changed plan or cancelled, does the right thing. A step
 * already taken is not taken again.
 *
 * The rule that matters: a subscription is moved to a higher price only when its owners were
 * sent the announcement at least thirty days before. One that was not is left where it is.
 */
export async function runPriceChangeStep(
  message: PriceChangeMessage,
  deps: PriceChangeDeps,
): Promise<StepOutcome> {
  const { store, payments } = deps;
  const now = deps.now ?? new Date();
  const { price_change_id: id, organization_id: organizationId, step } = message;
  const change = await store.getPriceChange(id);
  if (!change) return "nothing to do";
  const notice = (await store.listPriceChangeNotices(id)).find(
    (kept) => kept.organization_id === organizationId,
  );
  if (notice?.skipped || notice?.moved_at) return "nothing to do";

  const record = (done: Parameters<Store["recordPriceChangeNotice"]>[2]) =>
    store.recordPriceChangeNotice(id, organizationId, done);
  const skip = async (why: string): Promise<StepOutcome> => {
    await record({ skipped: why });
    return "skipped";
  };

  const kept = await store.getSubscription(organizationId);
  const subscription = kept?.stripe_subscription_id
    ? await payments.getSubscription(kept.stripe_subscription_id)
    : null;
  if (!subscription) return skip("It has no subscription.");
  const plans = await store.listPlanPrices();
  const paid = readItems(subscription.items, plans);
  if (!paid || paid.plan.key !== change.plan_key) return skip("It is not on this plan.");
  const target = paid.plan.versions.find((v) => v.stripe_price_id === change.stripe_price_id);
  if (!target) return skip("The plan no longer has the announced price.");
  if (paid.version.stripe_price_id === target.stripe_price_id) {
    return skip("It already pays the new price.");
  }
  const next = { ...paid, version: target } satisfies PaidPlan;
  const items = itemsFor(next);
  if (!items) return skip("It pays for locations the new price does not sell.");
  const goesUp = monthlyCents(next) > monthlyCents(paid);

  if (step === "move") return move();
  return tell(step);

  async function tell(kind: Exclude<PriceChangeStep, "move">): Promise<StepOutcome> {
    const at = now.toISOString();
    if (kind === "call_off") {
      if (!notice?.announced_at || notice.called_off_at) return "nothing to do";
    } else if (change?.called_off_at) {
      return "nothing to do";
    } else if (kind === "announce") {
      if (notice?.announced_at) return "nothing to do";
    } else if (!notice?.announced_at || notice.reminded_at || !goesUp) {
      // A reminder is for a price that goes up, and for someone who was told it would.
      return "nothing to do";
    }

    const [organization, owners, allPlans] = await Promise.all([
      store.getOrganization(organizationId),
      store.listOwnerEmails(organizationId),
      store.listPlans(),
    ]);
    // Nobody to tell is not the same as told: it is left, and so never moved to a higher price.
    if (!organization || owners.length === 0) return "waiting";
    await deps.send(
      owners,
      buildPriceChangeEmail({
        kind,
        organization: organization.name,
        plan: allPlans.find((plan) => plan.key === change?.plan_key)?.name ?? paid?.plan.key ?? "",
        was_cents: monthlyCents(paid as PaidPlan),
        now_cents: monthlyCents(next),
        effective_at: change?.effective_at ?? at,
        appUrl: deps.appUrl,
      }),
    );
    if (kind === "announce") await record({ announced_at: at });
    else if (kind === "remind") await record({ reminded_at: at });
    else await record({ called_off_at: at });
    return kind === "announce" ? "told" : kind === "remind" ? "reminded" : "told it is off";
  }

  async function move(): Promise<StepOutcome> {
    if (!change || !subscription || !items) return "nothing to do";
    if (change.called_off_at || change.completed_at) return "nothing to do";
    if (now.getTime() < Date.parse(change.effective_at)) return "waiting";
    // A payment being retried is settled first. The next day's run tries again.
    if (subscription.status !== "active") return "waiting";
    if (goesUp) {
      const told = notice?.announced_at ? Date.parse(notice.announced_at) : Number.NaN;
      if (!(told <= now.getTime() - NOTICE_MS)) return "not given notice";
    }

    await payments.reprice(subscription.id, items);
    // A change of their own that is waiting for the period to end was made at the old prices.
    // Left alone it would put them back on those, so it is rewritten at the new ones.
    const waiting = subscription.pending ? readItems(subscription.pending, plans) : null;
    if (
      waiting &&
      waiting.plan.key === change.plan_key &&
      waiting.version.stripe_price_id !== change.stripe_price_id &&
      target
    ) {
      const rewritten = itemsFor({ ...waiting, version: target });
      if (rewritten) await payments.changeAtPeriodEnd(subscription.id, rewritten);
    }
    await record({ moved_at: now.toISOString() });
    return "moved";
  }
}

/** The one queue method the daily run uses. `env.SCAN_QUEUE` satisfies it. */
export interface PriceChangeQueue {
  sendBatch(messages: Iterable<{ body: PriceChangeMessage }>): Promise<unknown>;
}

/** Cloudflare Queues accepts at most 100 messages per sendBatch call. */
const BATCH_LIMIT = 100;

export async function enqueuePriceChangeSteps(
  queue: PriceChangeQueue,
  change: Pick<PriceChange, "id">,
  organizationIds: readonly string[],
  step: PriceChangeStep,
): Promise<void> {
  for (let from = 0; from < organizationIds.length; from += BATCH_LIMIT) {
    await queue.sendBatch(
      organizationIds.slice(from, from + BATCH_LIMIT).map((organization_id) => ({
        body: { price_change_id: change.id, organization_id, step },
      })),
    );
  }
}

/**
 * The daily look at every open price change. A week before one takes effect its reminders are
 * queued, once. From the day it takes effect a move is queued for every subscription not yet
 * moved, each day until none is left, and then the change is finished. Returns how many
 * messages were queued.
 */
export async function advancePriceChanges(
  store: Store,
  queue: PriceChangeQueue,
  now: Date = new Date(),
): Promise<number> {
  let queued = 0;
  for (const change of await store.listOpenPriceChanges()) {
    const effective = Date.parse(change.effective_at);
    const subscribers = await store.listPlanSubscribers(change.plan_key);

    if (now.getTime() < effective) {
      if (!change.reminded_at && now.getTime() >= effective - REMINDER_MS) {
        await enqueuePriceChangeSteps(queue, change, subscribers, "remind");
        await store.markPriceChange(change.id, "reminded", now.toISOString());
        queued += subscribers.length;
      }
      continue;
    }

    const notices = await store.listPriceChangeNotices(change.id);
    const settled = new Set(
      notices.filter((n) => n.moved_at || n.skipped).map((notice) => notice.organization_id),
    );
    const left = subscribers.filter((id) => !settled.has(id));
    // Whoever is still not moved long after was never given notice, or never paid up. The
    // change is closed so the plan's prices can be changed again; they stay on what they pay.
    if (left.length === 0 || now.getTime() > effective + GIVE_UP_MS) {
      await store.markPriceChange(change.id, "completed", now.toISOString());
      continue;
    }
    await enqueuePriceChangeSteps(queue, change, left, "move");
    queued += left.length;
  }
  return queued;
}
