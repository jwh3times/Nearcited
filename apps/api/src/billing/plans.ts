import type { PlanPrices } from "../store/types";
import type { BilledItem } from "./types";

/** A plan and how many locations are paid for on it. */
export interface PaidPlan {
  plan: PlanPrices;
  locations: number;
}

/**
 * Which plan a subscription's lines are for, and how many locations they pay for: the plan whose
 * own price is among them, plus one location for each of its extra-location price. Null when no
 * plan has any of the prices.
 */
export function readItems(items: readonly BilledItem[], plans: readonly PlanPrices[]) {
  const paid = new Map(items.map((item) => [item.price_id, item.quantity]));
  const plan = plans.find((p) => p.stripe_price_id !== null && paid.has(p.stripe_price_id));
  if (!plan) return null;
  const extra = paid.get(plan.stripe_extra_location_price_id ?? "") ?? 0;
  return { plan, locations: plan.included_locations + extra } satisfies PaidPlan;
}

/**
 * The lines that pay for a plan with a number of locations. Null when the plan cannot be bought:
 * it is not set up at the provider, or more locations are asked for than it can have.
 */
export function itemsFor(plan: PlanPrices, locations: number): BilledItem[] | null {
  if (!plan.stripe_price_id) return null;
  const items = [{ price_id: plan.stripe_price_id, quantity: 1 }];
  const extra = locations - plan.included_locations;
  if (extra > 0) {
    if (!plan.stripe_extra_location_price_id) return null;
    items.push({ price_id: plan.stripe_extra_location_price_id, quantity: extra });
  }
  return items;
}

/** What a plan costs a month, in US cents and before tax, with a number of locations. */
export function monthlyCents({ plan, locations }: PaidPlan): number {
  const extra = Math.max(0, locations - plan.included_locations);
  return plan.price_cents + extra * (plan.extra_location_price_cents ?? 0);
}
