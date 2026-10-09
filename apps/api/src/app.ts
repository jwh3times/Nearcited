import { type Rates, toPublicAudit } from "@nearcited/shared";
import { Hono } from "hono";
import { type AuthedUser, type Authenticate, authenticateWithSupabase } from "./auth";
import { createStripePayments } from "./billing/stripe";
import { syncSubscription } from "./billing/sync";
import { type Payments, SignatureError } from "./billing/types";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { billingRoutes } from "./routes/billing";
import { locationRoutes } from "./routes/locations";
import { operatorRoutes } from "./routes/operator";
import { organizationRoutes } from "./routes/organizations";
import { scanRoutes } from "./routes/scans";
import { createAdminClient, createAnonClient, createSupabaseStore } from "./store/supabase";
import { type Store, StoreError } from "./store/types";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: AuthedUser;
    store: Store;
    deployment: Deployment;
    /** The payment provider, made when a route asks. Null in a deployment with none set up. */
    payments: () => Payments | null;
  };
};

export interface AppDeps {
  authenticate: Authenticate;
  /** A store for a caller who is not signed in. It can only look an audit up by its token. */
  publicStore?: (env: Env) => Store;
  /**
   * The worker's store, which bypasses row-level security. Used by one route: the payment
   * provider's webhook, whose caller is the provider and is known by its signature.
   */
  workerStore?: (env: Env) => Store;
  /** The payment provider, or null when this deployment has none set up. */
  payments?: (env: Env) => Payments | null;
  /**
   * What the operator's view says about this deployment. Passed in by the Worker's entry point,
   * the one place allowed to read the tuning.
   */
  deployment?: Deployment;
}

export interface Deployment {
  /** The model each assistant is asked with, by surface. */
  models: Record<string, string>;
  /**
   * What each model costs. Used on the server to price usage for the operator, and never sent
   * to anyone: only the dollars worked out from it are.
   */
  rates?: Rates;
}

/** The token in an audit's link: 64 hex characters. Anything else is not worth a query. */
const AUDIT_TOKEN = /^[0-9a-f]{64}$/;

const STORE_ERRORS = {
  conflict: { status: 409, message: "That already exists." },
  forbidden: { status: 403, message: "You do not have access to do that." },
} as const;

/** Billing needs both secrets: one to ask the provider, one to know it is the provider asking. */
function stripeFromEnv(env: Env): Payments | null {
  return env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET
    ? createStripePayments(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET)
    : null;
}

export function createApp(deps: AppDeps = { authenticate: authenticateWithSupabase }) {
  const app = new Hono<AppEnv>().basePath("/api");
  const paymentsFor = deps.payments ?? stripeFromEnv;

  app.get("/health", (c) => c.json({ ok: true }));

  // A shareable audit. No sign-in: holding the link is the permission, and the database function
  // behind it answers only for a token that is neither revoked nor expired.
  app.get("/audits/:token", async (c) => {
    const token = c.req.param("token");
    const store = (deps.publicStore ?? ((env) => createSupabaseStore(createAnonClient(env))))(
      c.env,
    );
    const audit = AUDIT_TOKEN.test(token) ? await store.getAuditByToken(token) : null;
    if (!audit) throw new ApiError(404, "not_found", "This report is no longer available.");
    // The link is the secret, so keep the page out of shared caches and search results.
    c.header("Cache-Control", "private, no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
    return c.json(toPublicAudit(audit));
  });

  // The price list. No sign-in: it is what a visitor reads before deciding to make an account.
  app.get("/plans", async (c) => {
    const store = (deps.publicStore ?? ((env) => createSupabaseStore(createAnonClient(env))))(
      c.env,
    );
    c.header("Cache-Control", "public, max-age=300");
    return c.json(await store.listPlans());
  });

  // The payment provider reporting on a subscription. No sign-in: the signature on the request is
  // what says it came from the provider, and nothing in the body is acted on. The subscription
  // is read back from the provider and the organization's plan made to agree with it. This is
  // the one route that uses the worker's store, because a plan is not a member's to change.
  app.post("/stripe/webhook", async (c) => {
    const payments = paymentsFor(c.env);
    if (!payments) {
      throw new ApiError(503, "billing_unavailable", "No payment provider is set up here.");
    }
    let subscriptionId: string | null;
    try {
      subscriptionId = await payments.readEvent(
        await c.req.text(),
        c.req.header("Stripe-Signature") ?? null,
      );
    } catch (error) {
      if (!(error instanceof SignatureError)) throw error;
      throw new ApiError(400, "invalid_signature", "The signature did not verify.");
    }
    const subscription = subscriptionId ? await payments.getSubscription(subscriptionId) : null;
    if (subscription) {
      const store = (deps.workerStore ?? ((env) => createSupabaseStore(createAdminClient(env))))(
        c.env,
      );
      const outcome = await syncSubscription(subscription, store);
      console.log(`Subscription ${subscription.id} ${outcome}`);
    }
    return c.json({ received: true });
  });

  // Everything below requires a signed-in user.
  app.use("*", async (c, next) => {
    const identity = await deps.authenticate(c.req.raw, c.env);
    if (!identity) throw new ApiError(401, "unauthenticated", "Sign in to continue.");
    c.set("user", identity.user);
    c.set("store", identity.store);
    c.set("deployment", deps.deployment ?? { models: {} });
    c.set("payments", () => paymentsFor(c.env));
    await next();
  });

  app.route("/", organizationRoutes);
  app.route("/", operatorRoutes);
  app.route("/", locationRoutes);
  app.route("/", scanRoutes);
  app.route("/", billingRoutes);

  app.notFound((c) => c.json({ error: { code: "not_found", message: "No such route" } }, 404));

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof StoreError) {
      if (error.kind === "limit") {
        // The message names the limit and its value. It is written in the database trigger.
        return c.json({ error: { code: "limit_reached", message: error.message } }, 409);
      }
      if (error.kind !== "unexpected") {
        const { status, message } = STORE_ERRORS[error.kind];
        return c.json({ error: { code: error.kind, message } }, status);
      }
    }
    console.error(`${c.req.method} ${c.req.path} failed`, error);
    return c.json({ error: { code: "internal", message: "Something went wrong." } }, 500);
  });

  return app;
}
