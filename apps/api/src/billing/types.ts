/** A subscription as the payment provider reports it, reduced to what decides a plan. */
export interface ProviderSubscription {
  id: string;
  customer_id: string;
  /** The provider's own word: active, trialing, past_due, unpaid, canceled and so on. */
  status: string;
  /** The organization it was bought for, as checkout recorded it. Null when it was not ours. */
  organization_id: string | null;
  /** What it bills for: each price and how many of it. */
  items: BilledItem[];
  /** When the period paid for ends, an ISO timestamp. Null when it bills for nothing. */
  period_end: string | null;
  /** What it will bill for from the end of the period instead, when a change is waiting. */
  pending: BilledItem[] | null;
}

/** One line of a subscription: a price at the provider, and how many of it. */
export interface BilledItem {
  price_id: string;
  quantity: number;
}

/** Thrown when the provider could not take the payment a change needed. Nothing was changed. */
export class PaymentDeclinedError extends Error {
  constructor(options?: ErrorOptions) {
    super("The payment did not go through.", options);
    this.name = "PaymentDeclinedError";
  }
}

export interface CheckoutRequest {
  organization_id: string;
  /** The provider's customer, when the organization has been through checkout before. */
  customer_id: string | null;
  /** Fills in the email field for an organization checking out for the first time. */
  email: string | null;
  items: BilledItem[];
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
  /**
   * What would be charged now, in cents and with tax, if the subscription billed for `items`
   * from this moment: the new price for the rest of the period, less what is unused of the old.
   */
  previewChange(subscriptionId: string, items: BilledItem[]): Promise<number>;
  /**
   * Makes the subscription bill for `items` from now and charges the difference for the rest of
   * the period. A change that was waiting for the period to end is dropped. Throws
   * `PaymentDeclinedError`, having changed nothing, when the charge fails.
   */
  changeNow(subscriptionId: string, items: BilledItem[]): Promise<void>;
  /** Makes the subscription bill for `items` from the end of the period paid for. Charges nothing. */
  changeAtPeriodEnd(subscriptionId: string, items: BilledItem[]): Promise<void>;
  /**
   * Makes the subscription bill for `items` from its next invoice on, charging and crediting
   * nothing now. It is how a subscriber is moved to a plan's new price: what they have paid for
   * this period stands, and the renewal is at the new amount. A change of their own that was
   * waiting for the period to end is kept.
   */
  reprice(subscriptionId: string, items: BilledItem[]): Promise<void>;
  /** Drops a change that was waiting for the period to end. Nothing to do when there is none. */
  keepCurrent(subscriptionId: string): Promise<void>;
  /**
   * Makes a new monthly price and returns the provider's ID for it. It is a price of the same
   * product as `like`, an existing price; with no `like` a product called `product_name` is
   * made for it first. Prices at the provider are never edited, so the old one goes on billing
   * whoever is on it.
   */
  createPrice(price: { like: string | null; product_name: string; cents: number }): Promise<string>;
}
