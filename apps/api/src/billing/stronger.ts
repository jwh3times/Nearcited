import {
  checkedAssistants,
  type Organization,
  PLAN_ASSISTANTS,
  type PlanAssistant,
} from "@nearcited/shared";
import type { PlanPrices, PriceVersion, Store } from "../store/types";
import { itemsFor, monthlyCents, readItems } from "./plans";
import type { Payments } from "./types";

/**
 * The assistants a plan, at one version of its prices, sells Stronger on: the plan includes
 * stronger models, the version has a price for them, and the deployment has one for the assistant
 * (`assistants`, from the tuning).
 */
export function sellsStronger(
  plan: PlanPrices,
  version: PriceVersion,
  assistants: readonly PlanAssistant[],
): PlanAssistant[] {
  if (!plan.sells_stronger || !version.stripe_stronger_price_ids) return [];
  return PLAN_ASSISTANTS.filter((surface) => assistants.includes(surface));
}

export interface SwitchDeps {
  /** The owner's store. */
  store: Store;
  payments: Payments;
  /** The assistants the tuning has a stronger model for. */
  assistants: readonly PlanAssistant[];
}

/**
 * After an owner switches assistant on a plan that checks one, moves what they pay Stronger on
 * to the new assistant, at once and for the same price. Where the new assistant has no stronger
 * model to sell, Stronger goes as a downgrade does, at the end of the period paid for. Nothing to
 * do without a subscription paying Stronger on an assistant no longer checked, or with one owing a
 * payment. Run again after a switch that did not finish, it finishes it.
 */
export async function followAssistantSwitch(
  organization: Organization,
  { store, payments, assistants }: SwitchDeps,
): Promise<void> {
  const billing = await store.getBillingState(organization.id);
  if (!billing?.stripe_subscription_id) return;
  const subscription = await payments.getSubscription(billing.stripe_subscription_id);
  if (subscription?.status !== "active") return;
  const current = readItems(subscription.items, await store.listPlanPrices());
  if (!current || current.stronger.length === 0) return;

  const checked = checkedAssistants(organization);
  if (current.stronger.every((surface) => checked.includes(surface))) return;
  const sold = sellsStronger(current.plan, current.version, assistants);
  // One stronger model for one stronger model: it follows to the assistant now checked.
  const stronger = checked
    .filter((surface) => sold.includes(surface))
    .slice(0, current.stronger.length);
  const moved = { ...current, stronger };
  const items = itemsFor(moved);
  if (!items) return;
  if (monthlyCents(moved) < monthlyCents(current)) {
    await payments.changeAtPeriodEnd(subscription.id, items);
  } else {
    await payments.changeNow(subscription.id, items);
  }
}
