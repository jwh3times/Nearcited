import type { PlanPrices, PriceVersion } from "../store/types";
import type { BilledItem } from "./types";

/** A plan, the version of its prices being paid, and how many locations are paid for. */
export interface PaidPlan {
  plan: PlanPrices;
  version: PriceVersion;
  locations: number;
}

/**
 * Which plan a subscription's lines are for, at which of its prices, and how many locations they
 * pay for: the plan with a version whose own price is among them, plus one location for each of
 * that version's extra-location price. Any version counts, so a subscriber still on an older
 * price is still on their plan. Null when no plan has ever had any of the prices.
 */
export function readItems(items: readonly BilledItem[], plans: readonly PlanPrices[]) {
  const paid = new Map(items.map((item) => [item.price_id, item.quantity]));
  for (const plan of plans) {
    const version = plan.versions.find((v) => paid.has(v.stripe_price_id));
    if (version) {
      const extra = paid.get(version.stripe_extra_location_price_id ?? "") ?? 0;
      return { plan, version, locations: plan.included_locations + extra } satisfies PaidPlan;
    }
  }
  return null;
}

/**
 * The lines that pay for a plan, at one version of its prices, with a number of locations. Null
 * when more locations are asked for than that version can have.
 */
export function itemsFor({ plan, version, locations }: PaidPlan): BilledItem[] | null {
  const items = [{ price_id: version.stripe_price_id, quantity: 1 }];
  const extra = locations - plan.included_locations;
  if (extra > 0) {
    if (!version.stripe_extra_location_price_id) return null;
    items.push({ price_id: version.stripe_extra_location_price_id, quantity: extra });
  }
  return items;
}

/** What it comes to a month, in US cents and before tax. */
export function monthlyCents({ plan, version, locations }: PaidPlan): number {
  const extra = Math.max(0, locations - plan.included_locations);
  return version.price_cents + extra * (version.extra_location_price_cents ?? 0);
}
