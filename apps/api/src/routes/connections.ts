import {
  ConnectionInputSchema,
  ConnectionMatchInputSchema,
  type OrganizationConnections,
} from "@nearcited/shared";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../app";
import { availableConnectionKinds, connect } from "../connections";
import { seal, sealingKey } from "../connections/seal";
import { ApiError, notFound } from "../errors";
import { parseJson, uuidParam } from "../validation";

export const connectionRoutes = new Hono<AppEnv>();

/**
 * Refuses to change what an answer subdomain is matched to: it is made for its location, under
 * that location's website, and is that location's until it is removed.
 */
async function matchedByHand(c: Context<AppEnv>, connectionId: string) {
  const connection = await c.get("store").getConnection(connectionId);
  if (connection?.kind === "hosted_pages") {
    throw new ApiError(
      422,
      "not_matched_by_hand",
      "An answer subdomain belongs to the location it was set up for. Remove it to set up another.",
    );
  }
}

/**
 * An organization's connections, for anyone who can read the organization: what is connected,
 * who connected it, and what can be connected here. Never a sign-in.
 */
connectionRoutes.get("/organizations/:organizationId/connections", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const store = c.get("store");
  const organization = await store.getOrganization(organizationId);
  if (!organization) throw notFound("Organization");
  const [connections, canManage] = await Promise.all([
    store.listConnections(organizationId),
    store.managesConnections(organizationId),
  ]);
  return c.json({
    available: availableConnectionKinds(c.env, organization),
    can_manage: canManage,
    connections,
  } satisfies OrganizationConnections);
});

/**
 * Connects an account. Owner or admin only: to anyone else the organization is not found. The
 * sign-in is sealed here, before it is stored, and is not part of what is returned.
 */
connectionRoutes.post("/organizations/:organizationId/connections", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const { kind } = await parseJson(c, ConnectionInputSchema);
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
  if (!availableConnectionKinds(c.env, organization).includes(kind)) {
    throw new ApiError(422, "connection_unavailable", "That cannot be connected here.");
  }
  // A site is connected by its owner approving on the site, from its location's Website tab.
  if (kind === "wordpress" || kind === "hosted_pages") {
    throw new ApiError(
      422,
      "connect_from_location",
      kind === "wordpress"
        ? "Connect a WordPress site from the Website tab of the location it belongs to."
        : "Set up an answer subdomain from the Website tab of the location it belongs to.",
    );
  }

  // The ID comes first, because the sign-in is sealed to it.
  const id = crypto.randomUUID();
  const { label, signIn } = await connect(kind);
  const connection = await store.createConnection({
    id,
    organization_id: organizationId,
    kind,
    label,
    sealed: await seal(key, id, signIn),
  });
  if (!connection) throw notFound("Organization");
  // What the account reaches is read by the worker, which alone can open the sign-in. If this
  // message is lost the schedule sends it again.
  try {
    await c.env.SCAN_QUEUE.send({ connection_id: id, step: "sync" });
  } catch (error) {
    console.error(`Connection ${id}: could not queue its first sync, the schedule will`, error);
  }
  return c.json(connection, 201);
});

/**
 * Says which of the things a connection reaches is a location's, replacing what was said before.
 * Owner or admin only, and only for a location of the same organization: to anyone and anything
 * else the connection is not found. 409 with the reason for a choice the account does not reach
 * or that is already taken.
 */
connectionRoutes.put("/connections/:connectionId/locations/:locationId", async (c) => {
  const connectionId = uuidParam(c, "connectionId", "Connection");
  const locationId = uuidParam(c, "locationId", "Location");
  const { external_id } = await parseJson(c, ConnectionMatchInputSchema);
  await matchedByHand(c, connectionId);
  const match = await c.get("store").matchConnectionLocation(connectionId, locationId, external_id);
  if (!match) throw notFound("Connection");
  // The worker reads the account again, now that it knows which part of it is this location's.
  try {
    await c.env.SCAN_QUEUE.send({ connection_id: connectionId, step: "sync" });
  } catch (error) {
    console.error(`Connection ${connectionId}: could not queue a sync after a match`, error);
  }
  return c.json(match);
});

/** Takes a location's match away. Owner or admin only. */
connectionRoutes.delete("/connections/:connectionId/locations/:locationId", async (c) => {
  const connectionId = uuidParam(c, "connectionId", "Connection");
  const locationId = uuidParam(c, "locationId", "Location");
  await matchedByHand(c, connectionId);
  if (!(await c.get("store").unmatchConnectionLocation(connectionId, locationId))) {
    throw notFound("Match");
  }
  return c.body(null, 204);
});

/**
 * Asks for a connection to be removed. Owner or admin only. It stops being used at once, and the
 * worker then withdraws access at the outside service and deletes the sign-in, which a request
 * cannot read. If the message is lost, the schedule sends it again.
 */
connectionRoutes.delete("/connections/:connectionId", async (c) => {
  const id = uuidParam(c, "connectionId", "Connection");
  const connection = await c.get("store").requestConnectionRemoval(id);
  if (!connection) throw notFound("Connection");
  if (connection.status === "removing") {
    try {
      await c.env.SCAN_QUEUE.send({ connection_id: id, step: "remove" });
    } catch (error) {
      console.error(`Connection ${id}: could not queue its removal, the schedule will`, error);
    }
  }
  return c.json(connection);
});
