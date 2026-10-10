import type { Email } from "../email/report";
import { buildSubscriptionStartedEmail } from "../email/subscription-started";
import type { Store } from "../store/types";
import { monthlyCents, readItems } from "./plans";
import type { ProviderSubscription } from "./types";

export interface StartedDeps {
  /** The worker's store. */
  store: Store;
  /** Sends an email to an organization's owners. Throws when it could not be sent. */
  send: (to: string[], email: Email) => Promise<void>;
  appUrl: string;
}

export type StartedOutcome = "thanked" | "nothing to do";

/**
 * Thanks an organization's owners for a subscription that has just been applied, once for each
 * subscription. The provider reports a new one several times over, so the subscription is
 * claimed first and only the first claim sends: an email that then fails is not sent again.
 */
export async function thankForSubscription(
  organizationId: string,
  subscription: ProviderSubscription,
  deps: StartedDeps,
): Promise<StartedOutcome> {
  const { store } = deps;
  if (!(await store.claimSubscriptionStart(organizationId, subscription.id))) {
    return "nothing to do";
  }
  const [organization, owners, prices, plans] = await Promise.all([
    store.getOrganization(organizationId),
    store.listOwnerEmails(organizationId),
    store.listPlanPrices(),
    store.listPlans(),
  ]);
  const paid = readItems(subscription.items, prices);
  if (!organization || !paid || owners.length === 0) return "nothing to do";
  await deps.send(
    owners,
    buildSubscriptionStartedEmail({
      organization: organization.name,
      plan: plans.find((plan) => plan.key === paid.plan.key)?.name ?? paid.plan.key,
      locations: paid.locations,
      monthly_cents: monthlyCents(paid),
      renews_at: subscription.period_end,
      appUrl: deps.appUrl,
    }),
  );
  return "thanked";
}
