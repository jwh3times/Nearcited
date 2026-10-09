/** A subscription as the payment provider reports it, reduced to what decides a plan. */
export interface ProviderSubscription {
  id: string;
  customer_id: string;
  /** The provider's own word: active, trialing, past_due, unpaid, canceled and so on. */
  status: string;
  /** The organization it was bought for, as checkout recorded it. Null when it was not ours. */
  organization_id: string | null;
  /** What it bills for: each price and how many of it. */
  items: { price_id: string; quantity: number }[];
}

export interface CheckoutRequest {
  organization_id: string;
  /** The provider's customer, when the organization has been through checkout before. */
  customer_id: string | null;
  /** Fills in the email field for an organization checking out for the first time. */
  email: string | null;
  items: { price_id: string; quantity: number }[];
  success_url: string;
  cancel_url: string;
}

/** Thrown when a webhook's signature does not match: the request did not come from the provider. */
export class SignatureError extends Error {
  constructor(options?: ErrorOptions) {
    super("The webhook's signature did not verify.", options);
    this.name = "SignatureError";
  }
}

/**
 * Everything the API needs from the payment provider. The provider's pages take the card and
 * show the invoices; the app only sends an owner to them and hears what happened.
 */
export interface Payments {
  /** Starts a hosted checkout for a subscription. Returns the address to send the owner to. */
  createCheckout(request: CheckoutRequest): Promise<string>;
  /** Opens the provider's account pages for a customer. Returns the address. */
  createPortal(customerId: string, returnUrl: string): Promise<string>;
  /**
   * Checks a webhook's signature and returns the ID of the subscription it is about, or null
   * when it is about something else. Throws `SignatureError` when the signature does not verify.
   */
  readEvent(body: string, signature: string | null): Promise<string | null>;
  /** The subscription as it stands now, or null when the provider has none by that ID. */
  getSubscription(id: string): Promise<ProviderSubscription | null>;
}
