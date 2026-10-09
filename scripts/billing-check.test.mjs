import assert from "node:assert/strict";
import { test } from "node:test";
import { assess, WEBHOOK_EVENTS } from "./billing-check.mjs";

const webhookUrl = "https://app.example/api/stripe/webhook";
const price = (unit_amount, change = {}) => ({
  active: true,
  unit_amount,
  currency: "usd",
  recurring: { interval: "month" },
  tax_behavior: "exclusive",
  livemode: true,
  ...change,
});

/** A deployment with everything as the app expects it. */
const ready = () => ({
  live: true,
  tax: { status: "active" },
  registrations: [{ status: "active" }],
  portal: {
    active: true,
    features: {
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: { enabled: false },
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
    },
  },
  endpoints: [{ url: webhookUrl, status: "enabled", enabled_events: [...WEBHOOK_EVENTS] }],
  webhookUrl,
  webhookAnswer: 400,
  plans: [
    {
      key: "free",
      name: "Free",
      on_sale: true,
      price_cents: 0,
      extra_location_price_cents: null,
      stripe_price_id: null,
      stripe_extra_location_price_id: null,
    },
    {
      key: "starter",
      name: "Starter",
      on_sale: true,
      price_cents: 2900,
      extra_location_price_cents: 1000,
      stripe_price_id: "price_a",
      stripe_extra_location_price_id: "price_b",
    },
    {
      key: "solo",
      name: "Solo",
      on_sale: true,
      price_cents: 900,
      extra_location_price_cents: null,
      stripe_price_id: "price_c",
      stripe_extra_location_price_id: null,
    },
  ],
  prices: { price_a: price(2900), price_b: price(1000), price_c: price(900) },
  subscriptions: [{ found: true }],
});

const failures = (facts) =>
  assess(facts)
    .filter((check) => !check.ok)
    .map((check) => check.what);

test("passes a deployment set up as the app expects", () => {
  assert.deepEqual(failures(ready()), []);
});

test("notices tax that is not active, and no registration", () => {
  const facts = { ...ready(), tax: { status: "pending" }, registrations: [] };
  assert.deepEqual(failures(facts), [
    "Stripe Tax is active",
    "There is an active tax registration",
  ]);
});

test("notices a portal that still lets a customer switch plan, or cancels at once", () => {
  const facts = ready();
  facts.portal.features.subscription_update.enabled = true;
  facts.portal.features.subscription_cancel.mode = "immediately";
  assert.deepEqual(failures(facts), [
    "Cancelling in the portal takes effect at the end of the paid period",
    "The portal does not let a customer switch plan or quantity (the app does that)",
  ]);
  assert.deepEqual(failures({ ...ready(), portal: null }), [
    "The customer portal has a default configuration",
  ]);
});

test("notices a webhook that is missing, disabled, short of an event, or not switched on", () => {
  assert.deepEqual(failures({ ...ready(), endpoints: [] }), [
    `A webhook endpoint is registered for ${webhookUrl}`,
  ]);
  const short = ready();
  short.endpoints[0].status = "disabled";
  short.endpoints[0].enabled_events = ["checkout.session.completed"];
  assert.deepEqual(failures(short), [
    "The webhook endpoint is enabled",
    "The webhook endpoint is sent every event the app acts on",
  ]);
  const every = ready();
  every.endpoints[0].enabled_events = ["*"];
  assert.deepEqual(failures(every), []);
  assert.deepEqual(failures({ ...ready(), webhookAnswer: 503 }), [
    "The deployed webhook is on and turns away an unsigned request",
  ]);
});

test("notices a plan whose Stripe price is missing, wrong, or from the other mode", () => {
  const facts = ready();
  facts.prices.price_a = price(3900);
  facts.prices.price_b = price(1000, { livemode: false, tax_behavior: "unspecified" });
  delete facts.prices.price_c;
  const found = assess(facts).filter((check) => !check.ok);
  assert.deepEqual(
    found.map((check) => check.what),
    [
      "Starter: its Stripe price matches the plan",
      "Starter, extra location: its Stripe price matches the plan",
      "Solo: has a price at Stripe",
    ],
  );
  assert.match(found[0].detail, /Stripe has 3900, the plan has 2900/);
  assert.match(found[1].detail, /tax_behavior unspecified; made in the other mode/);
});

test("notices a paid plan with no price ID, and leaves the free plan alone", () => {
  const facts = ready();
  facts.plans[1].stripe_price_id = null;
  assert.deepEqual(failures(facts), ["Starter: has a price at Stripe"]);
});

test("notices subscriptions on record that this key cannot see", () => {
  assert.deepEqual(failures({ ...ready(), subscriptions: [{ found: true }, { found: false }] }), [
    "Every subscription the app has recorded exists at Stripe under this key",
  ]);
});
