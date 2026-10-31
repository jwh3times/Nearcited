import { GOOGLE_RETURN_PATH, GoogleReturnSchema, type GoogleStart } from "@nearcited/shared";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../app";
import { availableConnectionKinds, googleAppOf } from "../connections";
import {
  GoogleRefused,
  googleSignInAddress,
  googleState,
  googleStateIsGood,
  swapCode,
} from "../connections/google";
import { ANALYTICS_LABEL, ANALYTICS_SCOPE } from "../connections/google-analytics";
import { seal, sealingKey } from "../connections/seal";
import { ApiError, notFound } from "../errors";
import { parseJson, uuidParam } from "../validation";

/**
 * Connecting a Google Analytics account. Google sends its owner back to a page of the web app, not
 * here, so the code is posted by the person it was given to, with their own sign-in
 * (`docs/adr/0029-analytics-counts-are-kept-apart-from-the-lines.md`).
 */
export const googleRoutes = new Hono<AppEnv>();

/**
 * What connecting needs, for an owner or admin of an organization whose plan here offers this
 * kind. To anyone else the organization is not found, as a connection is not.
 */
async function forConnecting(c: Context<AppEnv>) {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const store = c.get("store");
  const organization = await store.getOrganization(organizationId);
  if (!organization || !(await store.managesConnections(organizationId))) {
    throw notFound("Organization");
  }
  const key = await sealingKey(c.env.CONNECTIONS_KEY);
  if (!key) {
    throw new ApiError(
      503,
      "connections_unavailable",
      "Nothing can be connected here: this deployment has no key to keep a sign-in with.",
    );
  }
  const app = googleAppOf(c.env);
  if (!app || !availableConnectionKinds(c.env, organization).includes("google_analytics")) {
    throw new ApiError(422, "connection_unavailable", "That cannot be connected here.");
  }
  return {
    store,
    organizationId,
    key,
    app,
    redirectUri: new URL(GOOGLE_RETURN_PATH, c.env.APP_URL).toString(),
  };
}

/**
 * Where to send an owner or admin to agree on Google's screen. The `state` it carries is sealed to
 * this caller and this organization, and lasts minutes.
 */
googleRoutes.post(
  "/organizations/:organizationId/connections/google-analytics/start",
  async (c) => {
    const { organizationId, key, app, redirectUri } = await forConnecting(c);
    const state = await googleState(key, c.get("user").id, organizationId);
    const url = googleSignInAddress(app, { redirectUri, scope: ANALYTICS_SCOPE, state });
    return c.json({ url } satisfies GoogleStart);
  },
);

/**
 * Connects what Google handed back to the app. Owner or admin only. The `state` must be the one made
 * for this caller and this organization, and in time, before Google is asked anything. The sign-in
 * is sealed here before it is stored, and never returned. The worker's first sync then matches each
 * property to the location whose website it measures.
 */
googleRoutes.post("/organizations/:organizationId/connections/google-analytics", async (c) => {
  const { code, state } = await parseJson(c, GoogleReturnSchema);
  const { store, organizationId, key, app, redirectUri } = await forConnecting(c);
  if (!(await googleStateIsGood(key, state, c.get("user").id, organizationId))) {
    throw new ApiError(
      422,
      "sign_in_not_started_here",
      "That sign-in has run out, or was not started here. Connect Google Analytics again.",
    );
  }

  let swapped: Awaited<ReturnType<typeof swapCode>>;
  try {
    swapped = await swapCode(app, code, redirectUri);
  } catch (error) {
    if (error instanceof GoogleRefused) {
      throw new ApiError(
        422,
        "sign_in_refused",
        "Google did not accept that sign-in. Connect Google Analytics again.",
      );
    }
    console.error("A Google sign-in could not be finished", error);
    throw new ApiError(502, "google_unavailable", "Google could not be reached. Try again soon.");
  }
  if (!swapped.scopes.includes(ANALYTICS_SCOPE)) {
    throw new ApiError(
      422,
      "analytics_not_allowed",
      "Google was not given leave to read Analytics. Connect again and leave that box ticked.",
    );
  }
  if (!swapped.refreshToken) {
    throw new ApiError(
      422,
      "no_lasting_sign_in",
      "Google gave no sign-in that lasts. Connect Google Analytics again.",
    );
  }

  // The ID comes first, because the sign-in is sealed to it.
  const id = crypto.randomUUID();
  const connection = await store.createConnection({
    id,
    organization_id: organizationId,
    kind: "google_analytics",
    label: ANALYTICS_LABEL,
    sealed: await seal(key, id, swapped.refreshToken),
  });
  if (!connection) throw notFound("Organization");
  // What the sign-in reaches is read by the worker, which alone can open it. If this message is
  // lost the schedule sends it again.
  try {
    await c.env.SCAN_QUEUE.send({ connection_id: id, step: "sync" });
  } catch (error) {
    console.error(`Connection ${id}: could not queue its first sync, the schedule will`, error);
  }
  return c.json(connection, 201);
});
