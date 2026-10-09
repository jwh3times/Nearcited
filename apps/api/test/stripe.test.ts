import Stripe from "stripe";
import { beforeEach, describe, expect, it } from "vitest";
import { createStripePayments } from "../src/billing/stripe";
import { SignatureError } from "../src/billing/types";

/**
 * The Stripe side of billing, with Stripe's own library doing the signing and the request
 * building and a stand-in for the network. Nothing here reaches Stripe.
 */

const WEBHOOK_SECRET = "whsec_test_secret";
const organizationId = "0a000000-0000-4000-8000-000000000009";

let requests: { method: string; path: string; form: URLSearchParams }[];
let responses: { status: number; body: unknown }[];

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  requests.push({
    method: init?.method ?? "GET",
    path: url.pathname,
    form: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
  });
  const next = responses.shift() ?? { status: 500, body: { error: { message: "unexpected" } } };
  return new Response(JSON.stringify(next.body), {
    status: next.status,
    headers: { "Content-Type": "application/json", "Request-Id": "req_test" },
  });
};

const payments = () => createStripePayments("sk_test_not_a_real_key", WEBHOOK_SECRET, fakeFetch);

const signed = (payload: string, secret = WEBHOOK_SECRET) =>
  Stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret,
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });

const event = (type: string, object: Record<string, unknown>) =>
  JSON.stringify({ id: "evt_1", object: "event", type, data: { object } });

beforeEach(() => {
  requests = [];
  responses = [];
});

describe("a webhook from Stripe", () => {
  it("names the subscription a signed event is about", async () => {
    for (const type of [
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
    ]) {
      const body = event(type, { id: "sub_1", object: "subscription" });
      expect(await payments().readEvent(body, await signed(body)), type).toBe("sub_1");
    }
    const completed = event("checkout.session.completed", {
      id: "cs_1",
      object: "checkout.session",
      subscription: "sub_2",
    });
    expect(await payments().readEvent(completed, await signed(completed))).toBe("sub_2");
  });

  it("is about nothing when it is another kind of event", async () => {
    const body = event("invoice.paid", { id: "in_1", object: "invoice", subscription: "sub_1" });
    expect(await payments().readEvent(body, await signed(body))).toBeNull();
  });

  it("is refused without a signature, with another secret's, or once the body has changed", async () => {
    const body = event("customer.subscription.deleted", { id: "sub_1", object: "subscription" });
    const tampered = body.replace("sub_1", "sub_2");
    for (const [payload, signature] of [
      [body, null],
      [body, ""],
      [body, "t=1,v1=00"],
      [body, await signed(body, "whsec_someone_else")],
      [tampered, await signed(body)],
    ] as const) {
      await expect(payments().readEvent(payload, signature)).rejects.toBeInstanceOf(SignatureError);
    }
  });

  it("is refused when its signature is too old to trust", async () => {
    const body = event("customer.subscription.deleted", { id: "sub_1", object: "subscription" });
    const old = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload: body,
      secret: WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
      cryptoProvider: Stripe.createSubtleCryptoProvider(),
    });
    await expect(payments().readEvent(body, old)).rejects.toBeInstanceOf(SignatureError);
  });
});

describe("checkout", () => {
  const request = {
    organization_id: organizationId,
    customer_id: null,
    email: "owner@example.com",
    items: [
      { price_id: "price_standard", quantity: 1 },
      { price_id: "price_standard_location", quantity: 2 },
    ],
    success_url: "https://app.example/settings?billing=subscribed",
    cancel_url: "https://app.example/settings?billing=cancelled",
  };

  it("asks for a monthly subscription with tax, tied to the organization", async () => {
    responses.push({ status: 200, body: { id: "cs_1", url: "https://checkout.stripe.test/cs_1" } });
    expect(await payments().createCheckout(request)).toBe("https://checkout.stripe.test/cs_1");

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", path: "/v1/checkout/sessions" });
    expect(Object.fromEntries(requests[0]?.form ?? [])).toEqual({
      mode: "subscription",
      "line_items[0][price]": "price_standard",
      "line_items[0][quantity]": "1",
      "line_items[1][price]": "price_standard_location",
      "line_items[1][quantity]": "2",
      "automatic_tax[enabled]": "true",
      client_reference_id: organizationId,
      "subscription_data[metadata][organization_id]": organizationId,
      customer_email: "owner@example.com",
      success_url: request.success_url,
      cancel_url: request.cancel_url,
    });
  });

  it("uses the customer Stripe already has, and lets checkout keep their address for tax", async () => {
    responses.push({ status: 200, body: { id: "cs_1", url: "https://checkout.stripe.test/cs_1" } });
    await payments().createCheckout({ ...request, customer_id: "cus_1", email: null });
    const form = Object.fromEntries(requests[0]?.form ?? []);
    expect(form).toMatchObject({ customer: "cus_1", "customer_update[address]": "auto" });
    expect(form).not.toHaveProperty("customer_email");
  });
});

describe("the account pages", () => {
  it("are opened for the customer, with the way back", async () => {
    responses.push({ status: 200, body: { id: "bps_1", url: "https://billing.stripe.test/p" } });
    expect(await payments().createPortal("cus_1", "https://app.example/settings")).toBe(
      "https://billing.stripe.test/p",
    );
    expect(requests[0]).toMatchObject({ method: "POST", path: "/v1/billing_portal/sessions" });
    expect(Object.fromEntries(requests[0]?.form ?? [])).toEqual({
      customer: "cus_1",
      return_url: "https://app.example/settings",
    });
  });
});

describe("a subscription", () => {
  it("is read as what decides a plan: whose, its status and what it bills for", async () => {
    responses.push({
      status: 200,
      body: {
        id: "sub_1",
        object: "subscription",
        customer: "cus_1",
        status: "past_due",
        metadata: { organization_id: organizationId },
        items: {
          object: "list",
          data: [
            { id: "si_1", price: { id: "price_standard" }, quantity: 1 },
            { id: "si_2", price: { id: "price_standard_location" }, quantity: 2 },
          ],
        },
      },
    });
    expect(await payments().getSubscription("sub_1")).toEqual({
      id: "sub_1",
      customer_id: "cus_1",
      status: "past_due",
      organization_id: organizationId,
      items: [
        { price_id: "price_standard", quantity: 1 },
        { price_id: "price_standard_location", quantity: 2 },
      ],
    });
    expect(requests[0]).toMatchObject({ method: "GET", path: "/v1/subscriptions/sub_1" });
  });

  it("is null when Stripe has none by that ID, and has no organization when it is not ours", async () => {
    responses.push({
      status: 404,
      body: { error: { type: "invalid_request_error", code: "resource_missing", message: "No" } },
    });
    expect(await payments().getSubscription("sub_gone")).toBeNull();

    responses.push({
      status: 200,
      body: {
        id: "sub_2",
        customer: { id: "cus_2", object: "customer" },
        status: "active",
        metadata: {},
        items: { object: "list", data: [] },
      },
    });
    expect(await payments().getSubscription("sub_2")).toMatchObject({
      customer_id: "cus_2",
      organization_id: null,
    });
  });

  it("is an error, not a missing subscription, when Stripe cannot be asked", async () => {
    responses.push({
      status: 401,
      body: { error: { type: "invalid_request_error", message: "" } },
    });
    await expect(payments().getSubscription("sub_1")).rejects.toThrow();
  });
});
