import Stripe from "stripe";
import { type Payments, type ProviderSubscription, SignatureError } from "./types";

/** The events that say a subscription started, changed or ended. Everything else is ignored. */
const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

const idOf = (value: string | { id: string }) => (typeof value === "string" ? value : value.id);

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
        subscription = await stripe.subscriptions.retrieve(id);
      } catch (error) {
        if (error instanceof Stripe.errors.StripeError && error.code === "resource_missing") {
          return null;
        }
        throw error;
      }
      return {
        id: subscription.id,
        customer_id: idOf(subscription.customer),
        status: subscription.status,
        organization_id: subscription.metadata.organization_id ?? null,
        items: subscription.items.data.map((item) => ({
          price_id: item.price.id,
          quantity: item.quantity ?? 1,
        })),
      } satisfies ProviderSubscription;
    },
  };
}
