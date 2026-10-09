import { z } from "zod";
import type { Store } from "../store/types";
import { readItems } from "./plans";
import type { ProviderSubscription } from "./types";

/** The plan an organization is on when it pays for none. */
const FREE_PLAN = "free";

/**
 * Paid for, or still being collected: `past_due` is the provider retrying a failed payment, and
 * the organization keeps its plan until the provider gives up.
 */
const IN_FORCE = new Set(["active", "trialing", "past_due"]);
/** Over: cancelled, or left unpaid after the provider's retries. */
const ENDED = new Set(["canceled", "unpaid", "incomplete_expired"]);

const OrganizationId = z.uuid();

export type SyncOutcome = "applied" | "ended" | "ignored";

/**
 * Makes an organization's plan agree with its subscription as the provider reports it now. Takes
 * the subscription's present state, not an event, so events arriving twice or out of order end
 * in the same place. `store` is the worker's: only it may change a plan.
 *
 * Throws when the subscription bills for a price no plan has, which is a mistake in the setup
 * that somebody has to see.
 */
export async function syncSubscription(
  subscription: ProviderSubscription,
  store: Store,
): Promise<SyncOutcome> {
  const organizationId = OrganizationId.safeParse(subscription.organization_id);
  if (!organizationId.success) return "ignored";

  if (IN_FORCE.has(subscription.status)) {
    const paid = readItems(subscription.items, await store.listPlanPrices());
    if (!paid) {
      throw new Error(`Subscription ${subscription.id} bills for a price that no plan has.`);
    }
    const applied = await store.applyPlan(organizationId.data, paid.plan.key, paid.locations);
    if (!applied) return "ignored";
    await store.recordSubscription(organizationId.data, {
      stripe_customer_id: subscription.customer_id,
      stripe_subscription_id: subscription.id,
      status: subscription.status,
    });
    return "applied";
  }

  if (ENDED.has(subscription.status)) {
    // Only the end of the subscription the organization is on counts. One that never started,
    // an older one, or a repeat of news already acted on changes nothing: in particular it does
    // not put limits somebody set by hand back to the free plan's.
    const kept = await store.getSubscription(organizationId.data);
    if (kept?.stripe_subscription_id !== subscription.id) return "ignored";
    // The plan first: if this fails the record still names the subscription, so a retry ends it.
    await store.applyPlan(organizationId.data, FREE_PLAN);
    await store.recordSubscription(organizationId.data, {
      stripe_customer_id: kept.stripe_customer_id,
      stripe_subscription_id: null,
      status: subscription.status,
    });
    return "ended";
  }

  // `incomplete` (the first payment has not gone through yet) and `paused`: nothing to do.
  return "ignored";
}
