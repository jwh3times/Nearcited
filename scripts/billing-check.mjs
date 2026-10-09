#!/usr/bin/env node
// Asks the payment provider and the deployment whether billing is set up the way the app
// expects. Reads only: it changes nothing at Stripe and nothing in the database.
//
//   op run --env-file <references> -- npm run billing:check
//
// Needs, from the environment and never from a file in this repository:
//
//   STRIPE_SECRET_KEY     the key the deployed Worker uses (a test-mode or a live one)
//   SUPABASE_SECRET_KEY   to read the provider's price IDs off the plans, which no page shows
//
// The deployment's address and its Supabase project are read from apps/api/wrangler.jsonc.
// Exits 0 when every check passes, 1 when any fails.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripJsonc } from "./create-audit.mjs";

/** The events the Worker's webhook acts on. An endpoint missing any would leave plans stale. */
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
];

/**
 * Judges what was read. Pure, so it can be tested without Stripe: `facts` in, a list of checks
 * out, each `{ ok, what, detail? }`.
 */
export function assess(facts) {
  const checks = [];
  const check = (ok, what, detail) =>
    checks.push({ ok: Boolean(ok), what, ...(detail ? { detail } : {}) });
  const { tax, registrations, portal, endpoints, webhookUrl, webhookAnswer, plans, prices, live } =
    facts;

  check(
    tax?.status === "active",
    "Stripe Tax is active",
    tax ? `status: ${tax.status}` : "not read",
  );
  check(
    registrations.some((registration) => registration.status === "active"),
    "There is an active tax registration",
    `${registrations.length} found`,
  );

  check(portal?.active, "The customer portal has a default configuration");
  if (portal) {
    const features = portal.features;
    check(features.subscription_cancel?.enabled, "The portal lets a customer cancel");
    check(
      features.subscription_cancel?.mode === "at_period_end",
      "Cancelling in the portal takes effect at the end of the paid period",
      `mode: ${features.subscription_cancel?.mode}`,
    );
    check(
      !features.subscription_update?.enabled,
      "The portal does not let a customer switch plan or quantity (the app does that)",
    );
    check(features.payment_method_update?.enabled, "The portal lets a customer change their card");
    check(features.invoice_history?.enabled, "The portal shows invoices");
  }

  const endpoint = endpoints.find((candidate) => candidate.url === webhookUrl);
  check(endpoint, `A webhook endpoint is registered for ${webhookUrl}`);
  if (endpoint) {
    check(
      endpoint.status === "enabled",
      "The webhook endpoint is enabled",
      `status: ${endpoint.status}`,
    );
    const missing = endpoint.enabled_events.includes("*")
      ? []
      : WEBHOOK_EVENTS.filter((event) => !endpoint.enabled_events.includes(event));
    check(
      missing.length === 0,
      "The webhook endpoint is sent every event the app acts on",
      missing.join(", "),
    );
  }
  check(
    webhookAnswer === 400,
    "The deployed webhook is on and turns away an unsigned request",
    webhookAnswer === 503
      ? "it answered 503: the Worker has no Stripe secrets"
      : `it answered ${webhookAnswer}`,
  );

  const paid = plans.filter((plan) => plan.on_sale && plan.price_cents > 0);
  check(paid.length > 0, "There is at least one paid plan on sale");
  for (const plan of paid) {
    for (const [id, cents, label] of [
      [plan.stripe_price_id, plan.price_cents, `${plan.name}`],
      [
        plan.stripe_extra_location_price_id,
        plan.extra_location_price_cents,
        `${plan.name}, extra location`,
      ],
    ]) {
      // A plan that sells no extra locations has neither a price nor an ID for one.
      if (cents === null && id === null) continue;
      const price = id ? prices[id] : null;
      if (!price) {
        check(
          false,
          `${label}: has a price at Stripe`,
          id ? `${id} was not found with this key` : "no price ID on the plan",
        );
        continue;
      }
      const wrong = [
        price.active ? null : "archived",
        price.unit_amount === cents
          ? null
          : `Stripe has ${price.unit_amount}, the plan has ${cents}`,
        price.currency === "usd" ? null : `currency ${price.currency}`,
        price.recurring?.interval === "month" ? null : "not monthly",
        price.tax_behavior === "exclusive" ? null : `tax_behavior ${price.tax_behavior}`,
        price.livemode === live ? null : "made in the other mode",
      ].filter(Boolean);
      check(wrong.length === 0, `${label}: its Stripe price matches the plan`, wrong.join("; "));
    }
  }

  const strays = facts.subscriptions.filter((row) => !row.found);
  check(
    strays.length === 0,
    "Every subscription the app has recorded exists at Stripe under this key",
    strays.length > 0
      ? `${strays.length} do not, which is what test-mode records look like to a live key`
      : `${facts.subscriptions.length} recorded`,
  );
  return checks;
}

async function stripe(key, path) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Stripe answered ${response.status} for ${path}`);
  return response.json();
}

async function rows(url, key, path) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`The database answered ${response.status} for ${path}`);
  return response.json();
}

async function main() {
  const { STRIPE_SECRET_KEY: key, SUPABASE_SECRET_KEY: secret } = process.env;
  if (!key || !secret) {
    console.error("Set STRIPE_SECRET_KEY and SUPABASE_SECRET_KEY. See the top of this file.");
    return 2;
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { vars } = JSON.parse(
    stripJsonc(readFileSync(join(root, "apps/api/wrangler.jsonc"), "utf8")),
  );
  const live = !/^(sk|rk)_test_/.test(key);
  const webhookUrl = `${vars.APP_URL.replace(/\/$/, "")}/api/stripe/webhook`;

  const plans = await rows(
    vars.SUPABASE_URL,
    secret,
    "plans?select=key,name,on_sale,price_cents,extra_location_price_cents,stripe_price_id,stripe_extra_location_price_id&order=position",
  );
  const recorded = await rows(vars.SUPABASE_URL, secret, "subscriptions?select=stripe_customer_id");
  const prices = {};
  for (const id of plans.flatMap((plan) => [
    plan.stripe_price_id,
    plan.stripe_extra_location_price_id,
  ])) {
    if (id) prices[id] = await stripe(key, `/prices/${id}`);
  }
  const subscriptions = [];
  for (const row of recorded) {
    const customer = await stripe(key, `/customers/${row.stripe_customer_id}`);
    subscriptions.push({ found: customer !== null && !customer.deleted });
  }
  const [tax, registrations, portals, endpoints, unsigned] = await Promise.all([
    stripe(key, "/tax/settings"),
    stripe(key, "/tax/registrations?limit=100"),
    stripe(key, "/billing_portal/configurations?is_default=true&limit=1"),
    stripe(key, "/webhook_endpoints?limit=100"),
    fetch(webhookUrl, { method: "POST" }),
  ]);

  const checks = assess({
    live,
    tax,
    registrations: registrations?.data ?? [],
    portal: portals?.data?.[0] ?? null,
    endpoints: endpoints?.data ?? [],
    webhookUrl,
    webhookAnswer: unsigned.status,
    plans,
    prices,
    subscriptions,
  });

  console.log(
    `Billing check against ${vars.APP_URL}, with a ${live ? "LIVE" : "test-mode"} Stripe key\n`,
  );
  for (const { ok, what, detail } of checks) {
    console.log(`${ok ? "  ok  " : " FAIL "} ${what}${detail && !ok ? ` (${detail})` : ""}`);
  }
  const failed = checks.filter((result) => !result.ok).length;
  console.log(
    `\n${failed === 0 ? "Everything checked agrees." : `${failed} of ${checks.length} checks failed.`}`,
  );
  console.log(
    "Not checked here, because Stripe's API does not show them: that a subscription is cancelled\n" +
      "or marked unpaid when its payment retries run out, and that Stripe emails customers their\n" +
      "receipts and failed payments. Look at both in the dashboard's Billing settings.",
  );
  return failed === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
