import type { Store } from "../store/types";
import { itemsFor, type PaidPlan, readItems } from "./plans";
import type { Payments } from "./types";

export interface FitDeps {
  /** The worker's store. */
  store: Store;
  payments: Payments;
}

export type FitOutcome = "fitted" | "nothing to do";

/**
 * Takes off an organization's subscription the stronger lines its plan no longer sells: what the
 * day an announced reduction takes stronger models off a plan does to each subscriber on it. Its
 * owners were told thirty days before. The renewal is billed without them and nothing is charged
 * or credited for the period already paid for, and a change waiting for the period to end is
 * rewritten without them too. The webhook then puts every assistant on Standard; until it does,
 * `apply_plan()` already keeps none on Stronger on such a plan. Safe to run again.
 */
export async function fitSubscription(organizationId: string, deps: FitDeps): Promise<FitOutcome> {
  const { store, payments } = deps;
  const kept = await store.getSubscription(organizationId);
  const subscription = kept?.stripe_subscription_id
    ? await payments.getSubscription(kept.stripe_subscription_id)
    : null;
  if (!subscription) return "nothing to do";
  const plans = await store.listPlanPrices();
  const unsold = (paid: PaidPlan | null) =>
    paid && paid.stronger.length > 0 && !paid.plan.sells_stronger ? paid : null;

  const paid = unsold(readItems(subscription.items, plans));
  const waiting = unsold(subscription.pending ? readItems(subscription.pending, plans) : null);
  if (!paid && !waiting) return "nothing to do";
  const without = (from: PaidPlan) => itemsFor({ ...from, stronger: [] });

  const now = paid && without(paid);
  if (now) await payments.reprice(subscription.id, now);
  // Repricing keeps a change that is waiting, which would put the lines back at the renewal.
  const later = waiting && without(waiting);
  if (later) await payments.changeAtPeriodEnd(subscription.id, later);
  return "fitted";
}
