import {
  type BillingRedirect,
  CheckoutInputSchema,
  type OrganizationAccount,
} from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { ApiError, notFound } from "../errors";
import { parseJson, uuidParam } from "../validation";

export const billingRoutes = new Hono<AppEnv>();

const unavailable = () =>
  new ApiError(503, "billing_unavailable", "Subscriptions are not available here yet.");

const planUnavailable = (message: string) => new ApiError(422, "plan_unavailable", message);

/**
 * What Account settings shows: this month's use for anyone who can read the organization, and
 * where billing stands for its owner alone. A member, and the operator reading through, get
 * `billing: null`.
 */
billingRoutes.get("/organizations/:organizationId/account", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const store = c.get("store");
  const used = await store.getManualScansUsed(organizationId);
  if (used === null) throw notFound("Organization");
  const billing = await store.getBillingState(organizationId);
  return c.json({
    manual_scans_used: used,
    billing: billing && {
      available: c.get("payments")() !== null,
      subscribed: billing.stripe_subscription_id !== null,
      status: billing.status,
      has_customer: billing.stripe_customer_id !== null,
    },
  } satisfies OrganizationAccount);
});

/**
 * Starts a subscription: answers with the address of the payment provider's checkout. Owner
 * only. Nothing changes here; the plan moves when the provider's webhook says it was paid for.
 */
billingRoutes.post("/organizations/:organizationId/checkout", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const input = await parseJson(c, CheckoutInputSchema);
  const payments = c.get("payments")();
  if (!payments) throw unavailable();

  const store = c.get("store");
  const billing = await store.getBillingState(organizationId);
  if (!billing) throw notFound("Organization");
  if (billing.is_test) {
    throw new ApiError(409, "test_organization", "A test organization cannot subscribe.");
  }
  if (billing.stripe_subscription_id) {
    throw new ApiError(
      409,
      "already_subscribed",
      "This organization already has a subscription. Change it from your account pages.",
    );
  }

  const plan = (await store.listPlanPrices()).find((p) => p.key === input.plan_key && p.on_sale);
  if (!plan?.stripe_price_id) throw planUnavailable("That plan cannot be bought.");
  const items = [{ price_id: plan.stripe_price_id, quantity: 1 }];
  const extra = (input.locations ?? 0) - plan.included_locations;
  if (extra > 0) {
    if (!plan.stripe_extra_location_price_id) {
      throw planUnavailable(
        `That plan covers ${plan.included_locations} and no more can be added to it.`,
      );
    }
    items.push({ price_id: plan.stripe_extra_location_price_id, quantity: extra });
  }

  const settings = `${c.env.APP_URL}/settings`;
  const url = await payments.createCheckout({
    organization_id: organizationId,
    customer_id: billing.stripe_customer_id,
    // The provider takes one or the other: a customer it knows already has an email.
    email: billing.stripe_customer_id ? null : c.get("user").email,
    items,
    success_url: `${settings}?billing=subscribed`,
    cancel_url: `${settings}?billing=cancelled`,
  });
  return c.json({ url } satisfies BillingRedirect);
});

/**
 * Answers with the address of the provider's account pages, where the owner changes plan, pays
 * a failed invoice, or cancels. Owner only.
 */
billingRoutes.post("/organizations/:organizationId/billing-portal", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const payments = c.get("payments")();
  if (!payments) throw unavailable();

  const billing = await c.get("store").getBillingState(organizationId);
  if (!billing) throw notFound("Organization");
  if (!billing.stripe_customer_id) {
    throw new ApiError(409, "no_subscription", "This organization has never subscribed.");
  }
  const url = await payments.createPortal(billing.stripe_customer_id, `${c.env.APP_URL}/settings`);
  return c.json({ url } satisfies BillingRedirect);
});
