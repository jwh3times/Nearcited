import {
  type BillingRedirect,
  CheckoutInputSchema,
  type OrganizationAccount,
  type SubscriptionChange,
} from "@nearcited/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { itemsFor, monthlyCents, type PaidPlan, readItems } from "../billing/plans";
import { type BilledItem, PaymentDeclinedError, type Payments } from "../billing/types";
import { ApiError, notFound } from "../errors";
import type { PlanPrices } from "../store/types";
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
  const payments = c.get("payments")();

  // What is paid for and what is waiting live at the provider. If it cannot be asked, the page
  // still shows the rest: an owner must be able to reach their billing when something is wrong.
  let paid: PaidPlan | null = null;
  let renewsAt: string | null = null;
  let pending: NonNullable<OrganizationAccount["billing"]>["pending"] = null;
  let priceChange: NonNullable<OrganizationAccount["billing"]>["price_change"] = null;
  if (billing?.stripe_subscription_id && payments) {
    try {
      const subscription = await payments.getSubscription(billing.stripe_subscription_id);
      const plans = await store.listPlanPrices();
      paid = subscription && readItems(subscription.items, plans);
      renewsAt = subscription?.period_end ?? null;
      const next = subscription?.pending ? readItems(subscription.pending, plans) : null;
      if (next && renewsAt) {
        pending = {
          plan_key: next.plan.key,
          locations: next.locations,
          monthly_cents: monthlyCents(next),
          at: renewsAt,
        };
      }
      // A price change announced for their plan, when they have not been moved to it yet.
      const announced = paid ? await store.getOpenPriceChange(paid.plan.key) : null;
      const target = paid?.plan.versions.find(
        (version) => version.stripe_price_id === announced?.stripe_price_id,
      );
      if (paid && announced && target && target.stripe_price_id !== paid.version.stripe_price_id) {
        const moved = { ...paid, version: target };
        if (itemsFor(moved)) {
          priceChange = { monthly_cents: monthlyCents(moved), at: announced.effective_at };
        }
      }
    } catch (error) {
      console.error(`Could not read the subscription of ${organizationId}`, error);
    }
  }

  // A reduction announced for the plan, for anyone in the organization to see coming.
  const organization = await store.getOrganization(organizationId);
  const reduction = organization?.plan_key
    ? await store.getOpenLimitChange(organization.plan_key)
    : null;

  return c.json({
    manual_scans_used: used,
    limit_change: reduction && { lowered: reduction.lowered, at: reduction.effective_at },
    billing: billing && {
      available: payments !== null,
      subscribed: billing.stripe_subscription_id !== null,
      status: billing.status,
      has_customer: billing.stripe_customer_id !== null,
      locations: paid?.locations ?? null,
      renews_at: renewsAt,
      paying: paid && {
        price_cents: paid.version.price_cents,
        extra_location_price_cents: paid.version.extra_location_price_cents,
        monthly_cents: monthlyCents(paid),
      },
      price_change: priceChange,
      pending,
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
      "This organization already has a subscription. Change it from Account settings.",
    );
  }

  const { items } = await wanted(await store.listPlanPrices(), input, null);
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
 * Answers with the address of the provider's account pages, where the owner pays a failed
 * invoice, changes their card, reads their invoices or cancels. Owner only.
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

/**
 * What a change of plan, or of the number of locations paid for, would come to. Owner only, and
 * changes nothing: it is what the owner reads before confirming.
 */
billingRoutes.post("/organizations/:organizationId/subscription/preview", async (c) => {
  const { payments, subscriptionId, change, items } = await plannedChange(c);
  if (change.kind === "upgrade") {
    change.due_now_cents = await payments.previewChange(subscriptionId, items);
  }
  return c.json(change);
});

/**
 * Changes the plan, or the number of locations paid for. Owner only. Paying more happens now and
 * charges the difference for the rest of the period; paying less waits for the period to end.
 * Either way the organization's plan moves when the provider's webhook reports it, not here.
 */
billingRoutes.put("/organizations/:organizationId/subscription", async (c) => {
  const { payments, subscriptionId, change, items } = await plannedChange(c);
  if (change.kind === "downgrade") {
    await payments.changeAtPeriodEnd(subscriptionId, items);
    return c.json(change);
  }
  try {
    await payments.changeNow(subscriptionId, items);
  } catch (error) {
    if (!(error instanceof PaymentDeclinedError)) throw error;
    throw new ApiError(
      402,
      "payment_declined",
      "Your card was declined, so nothing changed. Update your payment method and try again.",
    );
  }
  return c.json(change);
});

/** Drops a change that was waiting for the period to end, keeping the plan as it is. Owner only. */
billingRoutes.delete("/organizations/:organizationId/subscription/pending", async (c) => {
  const { payments, subscriptionId } = await subscribed(c);
  await payments.keepCurrent(subscriptionId);
  return c.body(null, 204);
});

/**
 * The plan and lines an owner asked for, or a 422 saying why they cannot have them. A new
 * subscriber to a plan pays what it is sold at now. A subscriber changing the locations on the
 * plan they are already on (`own`) keeps the prices they pay, whatever it is sold at since, and
 * may do so even after it has gone off sale.
 */
async function wanted(
  plans: PlanPrices[],
  input: { plan_key: string; locations?: number },
  own: PaidPlan | null,
) {
  const staying = own?.plan.key === input.plan_key ? own : null;
  const plan = staying?.plan ?? plans.find((p) => p.key === input.plan_key && p.on_sale);
  const version = staying?.version ?? plan?.current;
  if (!plan || !version) throw planUnavailable("That plan cannot be bought.");
  const paid = {
    plan,
    version,
    locations: Math.max(plan.included_locations, input.locations ?? 0),
  } satisfies PaidPlan;
  const items = itemsFor(paid);
  if (!items) {
    throw planUnavailable(
      `That plan covers ${plan.included_locations} and no more can be added to it.`,
    );
  }
  return { paid, items };
}

/** The owner's subscription, or the error that says why there is none to change. */
async function subscribed(
  c: Context<AppEnv>,
): Promise<{ payments: Payments; subscriptionId: string }> {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const payments = c.get("payments")();
  if (!payments) throw unavailable();
  const billing = await c.get("store").getBillingState(organizationId);
  if (!billing) throw notFound("Organization");
  if (!billing.stripe_subscription_id) {
    throw new ApiError(409, "no_subscription", "This organization has no subscription to change.");
  }
  return { payments, subscriptionId: billing.stripe_subscription_id };
}

/**
 * Works out what the owner's request would do to their subscription, from the subscription as
 * the provider has it now. Which way it goes is decided here by the monthly price, never by
 * what the request says.
 */
async function plannedChange(c: Context<AppEnv>): Promise<{
  payments: Payments;
  subscriptionId: string;
  change: SubscriptionChange;
  items: BilledItem[];
}> {
  const { payments, subscriptionId } = await subscribed(c);
  const input = await parseJson(c, CheckoutInputSchema);
  const plans = await c.get("store").listPlanPrices();

  const subscription = await payments.getSubscription(subscriptionId);
  // A payment being retried has to be settled first: changing what is owed would muddle it.
  if (subscription?.status !== "active") {
    throw new ApiError(
      409,
      "payment_due",
      "This subscription has a payment outstanding. Settle it from Manage billing first.",
    );
  }
  const current = readItems(subscription.items, plans);
  if (!current || !subscription.period_end) {
    throw new Error(`Subscription ${subscriptionId} bills for a price that no plan has.`);
  }
  const { paid, items } = await wanted(plans, input, current);
  if (current.plan.key === paid.plan.key && current.locations === paid.locations) {
    throw new ApiError(422, "no_change", "That is the plan this organization is already on.");
  }

  // Paying the same for something different is treated as paying more: it happens now.
  const downgrade = monthlyCents(paid) < monthlyCents(current);
  return {
    payments,
    subscriptionId,
    items,
    change: {
      kind: downgrade ? "downgrade" : "upgrade",
      plan_key: paid.plan.key,
      locations: paid.locations,
      monthly_cents: monthlyCents(paid),
      due_now_cents: null,
      effective_at: downgrade ? subscription.period_end : null,
    },
  };
}
