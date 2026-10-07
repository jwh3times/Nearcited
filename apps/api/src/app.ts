import { toPublicAudit } from "@nearcited/shared";
import { Hono } from "hono";
import { type AuthedUser, type Authenticate, authenticateWithSupabase } from "./auth";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { locationRoutes } from "./routes/locations";
import { organizationRoutes } from "./routes/organizations";
import { scanRoutes } from "./routes/scans";
import { createAnonClient, createSupabaseStore } from "./store/supabase";
import { type Store, StoreError } from "./store/types";

export type AppEnv = {
  Bindings: Env;
  Variables: { user: AuthedUser; store: Store };
};

export interface AppDeps {
  authenticate: Authenticate;
  /** A store for a caller who is not signed in. It can only look an audit up by its token. */
  publicStore?: (env: Env) => Store;
}

/** The token in an audit's link: 64 hex characters. Anything else is not worth a query. */
const AUDIT_TOKEN = /^[0-9a-f]{64}$/;

const STORE_ERRORS = {
  conflict: { status: 409, message: "That already exists." },
  forbidden: { status: 403, message: "You do not have access to do that." },
} as const;

export function createApp(deps: AppDeps = { authenticate: authenticateWithSupabase }) {
  const app = new Hono<AppEnv>().basePath("/api");

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

  // Everything below requires a signed-in user.
  app.use("*", async (c, next) => {
    const identity = await deps.authenticate(c.req.raw, c.env);
    if (!identity) throw new ApiError(401, "unauthenticated", "Sign in to continue.");
    c.set("user", identity.user);
    c.set("store", identity.store);
    await next();
  });

  app.route("/", organizationRoutes);
  app.route("/", locationRoutes);
  app.route("/", scanRoutes);

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
