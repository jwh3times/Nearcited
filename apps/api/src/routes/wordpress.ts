import { WordPressApprovedSchema, type WordPressCheck } from "@nearcited/shared";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../app";
import { availableConnectionKinds, wordpressSignIn } from "../connections";
import { seal, sealingKey } from "../connections/seal";
import { checkWordPress, type NotConnected, signInWith } from "../connections/wordpress";
import { ApiError, notFound } from "../errors";
import type { Store } from "../store/types";
import { parseJson, uuidParam } from "../validation";
import { requireLocation } from "./locations";

export const wordpressRoutes = new Hono<AppEnv>();

/**
 * The location, for an owner or admin of its organization whose plan here offers a WordPress
 * connection. To anyone else the location is not found, as a connection is not.
 */
async function forConnecting(c: Context<AppEnv>) {
  const store: Store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  const organization = await store.getOrganization(location.organization_id);
  if (!organization || !(await store.managesConnections(organization.id))) {
    throw notFound("Location");
  }
  if (!(await sealingKey(c.env.CONNECTIONS_KEY))) {
    throw new ApiError(
      503,
      "connections_unavailable",
      "Nothing can be connected here: this deployment has no key to keep a sign-in with.",
    );
  }
  if (!availableConnectionKinds(c.env, organization).includes("wordpress")) {
    throw new ApiError(422, "connection_unavailable", "That cannot be connected here.");
  }
  const held = await store.listLocationConnections(location.id);
  if (held.some((connection) => connection.kind === "wordpress")) {
    throw new ApiError(
      409,
      "already_connected",
      "This location's WordPress site is connected already.",
    );
  }
  return { store, location, organization };
}

/**
 * Asks the location's website whether it is a WordPress that gives out application passwords,
 * and where its owner approves one. Reads only what the site shows anyone. Owner or admin only.
 */
wordpressRoutes.post("/locations/:locationId/wordpress/check", async (c) => {
  const { location } = await forConnecting(c);
  const check: WordPressCheck = await checkWordPress(location.website, {
    localOrigin: c.env.WORDPRESS_LOCAL_ORIGIN ?? null,
  });
  return c.json(check);
});

const NOT_CONNECTED: Record<NotConnected, [ContentfulStatusCode, string]> = {
  not_this_site: [422, "That was approved on a different site from this location's website."],
  refused: [422, "The site did not accept the password it made. Try connecting again."],
  cannot_publish: [
    422,
    "That WordPress account cannot publish pages. Sign in to WordPress as an administrator or an editor and connect again.",
  ],
  unreachable: [502, "The site could not be reached to finish connecting. Try again in a while."],
};

/**
 * Connects the location's WordPress site with what WordPress handed back once its owner approved:
 * the site, their user name and the application password it made. Owner or admin only. The
 * password is tried, sealed here before it is stored, and never returned. The worker's first
 * sync then matches the site to this location.
 */
wordpressRoutes.post("/locations/:locationId/wordpress", async (c) => {
  const approved = await parseJson(c, WordPressApprovedSchema);
  const { store, location, organization } = await forConnecting(c);
  if (!location.website) {
    throw new ApiError(422, "no_website", "Add this location's website under Settings first.");
  }
  const key = await sealingKey(c.env.CONNECTIONS_KEY);
  if (!key) throw new ApiError(503, "connections_unavailable", "Nothing can be connected here.");

  const signedIn = await signInWith(approved, location.website, {
    localOrigin: c.env.WORDPRESS_LOCAL_ORIGIN ?? null,
  });
  if (typeof signedIn === "string") {
    const [status, message] = NOT_CONNECTED[signedIn];
    throw new ApiError(status, signedIn, message);
  }

  // The ID comes first, because the sign-in is sealed to it.
  const id = crypto.randomUUID();
  const connection = await store.createConnection({
    id,
    organization_id: organization.id,
    kind: "wordpress",
    label: signedIn.label,
    sealed: await seal(key, id, wordpressSignIn(signedIn.signIn)),
    for_location: location.id,
  });
  if (!connection) throw notFound("Location");
  // What the site is called, and its match to this location, are the worker's to read. If this
  // message is lost the schedule sends it again.
  try {
    await c.env.SCAN_QUEUE.send({ connection_id: id, step: "sync" });
  } catch (error) {
    console.error(`Connection ${id}: could not queue its first sync, the schedule will`, error);
  }
  return c.json(connection, 201);
});
