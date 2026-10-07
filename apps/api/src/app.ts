import { Hono } from "hono";
import { type AuthedUser, type Authenticate, authenticateWithSupabase } from "./auth";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { locationRoutes } from "./routes/locations";
import { organizationRoutes } from "./routes/organizations";
import { scanRoutes } from "./routes/scans";
import { type Store, StoreError } from "./store/types";

export type AppEnv = {
  Bindings: Env;
  Variables: { user: AuthedUser; store: Store };
};

export interface AppDeps {
  authenticate: Authenticate;
}

const STORE_ERRORS = {
  conflict: { status: 409, message: "That already exists." },
  forbidden: { status: 403, message: "You do not have access to do that." },
} as const;

export function createApp(deps: AppDeps = { authenticate: authenticateWithSupabase }) {
  const app = new Hono<AppEnv>().basePath("/api");

  app.get("/health", (c) => c.json({ ok: true }));

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
