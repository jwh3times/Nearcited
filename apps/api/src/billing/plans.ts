import { PLAN_ASSISTANTS, type PlanAssistant } from "@nearcited/shared";
import type { PlanPrices, PriceVersion } from "../store/types";
import type { BilledItem } from "./types";

/**
 * A plan, the version of its prices being paid, how many locations are paid for, and which
 * assistants are paid a stronger model on.
 */
export interface PaidPlan {
  plan: PlanPrices;
  version: PriceVersion;
  locations: number;
  stronger: PlanAssistant[];
}

/**
 * Which plan a subscription's lines are for, at which of its prices, how many locations they
 * pay for and which assistants they pay Stronger on: the plan with a version whose own price is
 * among them, plus one location for each of that version's extra-location price, plus each
 * assistant whose stronger price, of any version of the plan, is among them. Any version counts,
 * so a subscriber still on an older price is still on their plan. Null when no plan has ever had
 * any of the prices.
 */
export function readItems(items: readonly BilledItem[], plans: readonly PlanPrices[]) {
  const paid = new Map(items.map((item) => [item.price_id, item.quantity]));
  for (const plan of plans) {
    const version = plan.versions.find((v) => paid.has(v.stripe_price_id));
    if (version) {
      const extra = paid.get(version.stripe_extra_location_price_id ?? "") ?? 0;
      const stronger = PLAN_ASSISTANTS.filter((surface) =>
        plan.versions.some((v) => paid.has(v.stripe_stronger_price_ids?.[surface] ?? "")),
      );
      return {
        plan,
        version,
        locations: plan.included_locations + extra,
        stronger,
      } satisfies PaidPlan;
    }
  }
  return null;
}

/**
 * The lines that pay for a plan, at one version of its prices, with a number of locations and
 * Stronger on some assistants. A stronger line counts every location paid for, the plan's
 * included ones as well (`docs/adr/0022-a-stronger-model-is-charged-for-each-location.md`). Null
 * when that version cannot sell what is asked: more locations than it has a price for, or
 * Stronger where it has no stronger price.
 */
export function itemsFor({ plan, version, locations, stronger }: PaidPlan): BilledItem[] | null {
  const items = [{ price_id: version.stripe_price_id, quantity: 1 }];
  const extra = locations - plan.included_locations;
  if (extra > 0) {
    if (!version.stripe_extra_location_price_id) return null;
    items.push({ price_id: version.stripe_extra_location_price_id, quantity: extra });
  }
  for (const surface of stronger) {
    const price = version.stripe_stronger_price_ids?.[surface];
    if (!price) return null;
    items.push({ price_id: price, quantity: locations });
  }
  return items;
}

/**
 * What it comes to a month, in US cents and before tax: the stronger price is for each location
 * paid for, on each assistant on Stronger.
 */
export function monthlyCents({ plan, version, locations, stronger }: PaidPlan): number {
  const extra = Math.max(0, locations - plan.included_locations);
  return (
    version.price_cents +
    extra * (version.extra_location_price_cents ?? 0) +
    stronger.length * locations * (version.stronger_price_cents ?? 0)
  );
}
