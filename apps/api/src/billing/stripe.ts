import Stripe from "stripe";
import {
  type BilledItem,
  PaymentDeclinedError,
  type Payments,
  type ProviderSubscription,
  SignatureError,
} from "./types";

/** The events that say a subscription started, changed or ended. Everything else is ignored. */
const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

const idOf = (value: string | { id: string }) => (typeof value === "string" ? value : value.id);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/**
 * Stripe, through its hosted checkout and customer portal. `fetchFn` is for tests; a Worker has
 * no Node HTTP client, so requests always go through fetch and signatures through Web Crypto.
 */
export function createStripePayments(
  secretKey: string,
  webhookSecret: string,
  fetchFn?: typeof fetch,
): Payments {
  const stripe = new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient(fetchFn) });
  const crypto = Stripe.createSubtleCryptoProvider();

  /**
   * The subscription's lines rewritten to bill for `items`: a line already at a wanted price
   * keeps its place with the new quantity, any other line is removed, and the rest are added.
   */
  function replaceItems(subscription: Stripe.Subscription, items: BilledItem[]) {
    const wanted = new Map(items.map((item) => [item.price_id, item.quantity]));
    const changes: Stripe.SubscriptionUpdateParams.Item[] = [];
    for (const line of subscription.items.data) {
      const quantity = wanted.get(line.price.id);
      changes.push(
        quantity === undefined ? { id: line.id, deleted: true } : { id: line.id, quantity },
      );
      wanted.delete(line.price.id);
    }
    for (const [price, quantity] of wanted) changes.push({ price, quantity });
    return changes;
  }

  /** The schedule's phase that has not started yet, which is what a waiting change is. */
  function waiting(subscription: Stripe.Subscription): BilledItem[] | null {
    const { schedule } = subscription;
    if (!schedule || typeof schedule === "string" || schedule.status !== "active") return null;
    const current = schedule.current_phase;
    const next = schedule.phases.find((phase) => current && phase.start_date >= current.end_date);
    return next
      ? next.items.map((item) => ({ price_id: idOf(item.price), quantity: item.quantity ?? 1 }))
      : null;
  }

  const withSchedule = (id: string) => stripe.subscriptions.retrieve(id, { expand: ["schedule"] });

  return {
    async createCheckout(request) {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: request.items.map((item) => ({
          price: item.price_id,
          quantity: item.quantity,
        })),
        // Tax is worked out by Stripe from the address checkout collects for it.
        automatic_tax: { enabled: true },
        client_reference_id: request.organization_id,
        // The subscription carries the organization, which is how the webhook knows whose it is.
        subscription_data: { metadata: { organization_id: request.organization_id } },
        ...(request.customer_id
          ? // An address is needed for tax, so let checkout save the one it collects.
            { customer: request.customer_id, customer_update: { address: "auto" } }
          : request.email
            ? { customer_email: request.email }
            : {}),
        success_url: request.success_url,
        cancel_url: request.cancel_url,
      });
      if (!session.url) throw new Error("Stripe returned a checkout session with no address.");
      return session.url;
    },

    async createPortal(customerId, returnUrl) {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });
      return session.url;
    },

    async readEvent(body, signature) {
      let event: Stripe.Event;
      try {
        event = await stripe.webhooks.constructEventAsync(
          body,
          signature ?? "",
          webhookSecret,
          undefined,
          crypto,
        );
      } catch (error) {
        throw new SignatureError({ cause: error });
      }
      if (event.type === "checkout.session.completed") {
        const { subscription } = event.data.object;
        return subscription ? idOf(subscription) : null;
      }
      if (SUBSCRIPTION_EVENTS.has(event.type)) {
        return (event.data.object as Stripe.Subscription).id;
      }
      return null;
    },

    async getSubscription(id) {
      let subscription: Stripe.Subscription;
      try {
        subscription = await withSchedule(id);
      } catch (error) {
        if (error instanceof Stripe.errors.StripeError && error.code === "resource_missing") {
          return null;
        }
        throw error;
      }
      const [first] = subscription.items.data;
      return {
        id: subscription.id,
        customer_id: idOf(subscription.customer),
        status: subscription.status,
        organization_id: subscription.metadata.organization_id ?? null,
        items: subscription.items.data.map((item) => ({
          price_id: item.price.id,
          quantity: item.quantity ?? 1,
        })),
        period_end: first ? iso(first.current_period_end) : null,
        pending: waiting(subscription),
      } satisfies ProviderSubscription;
    },

    async previewChange(subscriptionId, items) {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const preview = await stripe.invoices.createPreview({
        subscription: subscriptionId,
        subscription_details: {
          items: replaceItems(subscription, items),
          proration_behavior: "always_invoice",
        },
      });
      return preview.amount_due;
    },

    async changeNow(subscriptionId, items) {
      const subscription = await withSchedule(subscriptionId);
      // A schedule would carry its waiting change on past this one, so it goes first.
      const { schedule } = subscription;
      if (schedule && typeof schedule !== "string" && schedule.status === "active") {
        await stripe.subscriptionSchedules.release(schedule.id);
      }
      try {
        await stripe.subscriptions.update(subscriptionId, {
          items: replaceItems(subscription, items),
          // Invoice the difference now, and refuse the whole change if it cannot be paid.
          proration_behavior: "always_invoice",
          payment_behavior: "error_if_incomplete",
        });
      } catch (error) {
        if (error instanceof Stripe.errors.StripeCardError) {
          throw new PaymentDeclinedError({ cause: error });
        }
        throw error;
      }
    },

    async changeAtPeriodEnd(subscriptionId, items) {
      const subscription = await withSchedule(subscriptionId);
      const existing =
        subscription.schedule && typeof subscription.schedule !== "string"
          ? subscription.schedule
          : null;
      const schedule =
        existing?.status === "active"
          ? existing
          : await stripe.subscriptionSchedules.create({ from_subscription: subscriptionId });
      const current = schedule.phases.find(
        (phase) => phase.start_date === schedule.current_phase?.start_date,
      );
      if (!current) throw new Error(`Schedule ${schedule.id} has no current phase.`);
      await stripe.subscriptionSchedules.update(schedule.id, {
        // Once the change has happened the subscription carries on by itself.
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            items: current.items.map((item) => ({
              price: idOf(item.price),
              quantity: item.quantity ?? 1,
            })),
            start_date: current.start_date,
            end_date: current.end_date,
          },
          { items: items.map((item) => ({ price: item.price_id, quantity: item.quantity })) },
        ],
      });
    },

    async keepCurrent(subscriptionId) {
      const subscription = await withSchedule(subscriptionId);
      if (waiting(subscription) && subscription.schedule) {
        await stripe.subscriptionSchedules.release(idOf(subscription.schedule));
      }
    },
  };
}
