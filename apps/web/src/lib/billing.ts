import type { Organization, OrganizationAccount, Plan } from "@nearcited/shared";

/** What a plan costs a month, in US cents, for a number of locations. */
export function monthlyCents(plan: Plan, locations: number): number {
  const extra = Math.max(0, locations - plan.included_locations);
  return plan.price_cents + extra * (plan.extra_location_price_cents ?? 0);
}

/** "$29", "$12.50": a price in whole dollars when it is one. */
export function formatPrice(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/** Who is looking at the price list. Null is a visitor who is not signed in. */
export type PricingViewer = {
  /** Null while an account has not made its organization yet. */
  organization: Organization | null;
  /** Null until it has loaded. */
  account: OrganizationAccount | null;
} | null;

/**
 * What a plan on the price list offers the person looking at it.
 *
 * - `sign-in`: a visitor, who signs in first and comes back to the plan.
 * - `finish-setup`: an account with no organization yet.
 * - `current`: the plan the organization is on.
 * - `subscribe`: the owner can go to checkout for it.
 * - `manage`: the owner changes or cancels a subscription on the provider's account pages.
 * - `owner-only`: a member, who can read the prices but not buy.
 * - `unavailable`: nobody can subscribe in this deployment.
 * - `none`: nothing to offer, such as the free plan to an organization not on it.
 */
export type PlanOffer =
  | "sign-in"
  | "finish-setup"
  | "current"
  | "subscribe"
  | "manage"
  | "owner-only"
  | "unavailable"
  | "none";

export function planOffer(plan: Plan, viewer: PricingViewer): PlanOffer {
  if (!viewer) return "sign-in";
  const { organization, account } = viewer;
  if (!organization) return "finish-setup";
  if (organization.plan_key === plan.key) return "current";
  // A test organization pays for nothing, and until the account loads nothing is known.
  if (organization.is_test || !account) return "none";
  if (!account.billing) return "owner-only";
  if (account.billing.subscribed) return "manage";
  // Moving to the free plan is cancelling, which an organization with no subscription cannot do.
  if (plan.price_cents === 0) return "none";
  return account.billing.available ? "subscribe" : "unavailable";
}

const PENDING_PLAN = "nearcited.pending-plan";

/** Remembers the plan a visitor chose, so the price list can come back to it after sign-in. */
export function rememberPlan(key: string): void {
  try {
    localStorage.setItem(PENDING_PLAN, key);
  } catch {
    // Storage can be turned off. The visitor then lands on their account, not the price list.
  }
}

/** The plan a visitor chose before signing in, once: reading it forgets it. */
export function takeRememberedPlan(): string | null {
  try {
    const key = localStorage.getItem(PENDING_PLAN);
    if (key) localStorage.removeItem(PENDING_PLAN);
    return key;
  } catch {
    return null;
  }
}

/** What to tell an owner about a subscription that needs something from them, or null. */
export function billingWarning(status: string | null): string | null {
  if (status === "past_due") {
    return "Your last payment did not go through. We are trying again; update your payment method to keep your plan.";
  }
  if (status === "unpaid" || status === "canceled") {
    return "Your subscription has ended, so this organization is on the free plan. Nothing was deleted: subscribe again to bring back what is paused.";
  }
  return null;
}
