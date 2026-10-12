import { ConnectionInputSchema, type OrganizationConnections } from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { availableConnectionKinds, connect } from "../connections";
import { seal, sealingKey } from "../connections/seal";
import { ApiError, notFound } from "../errors";
import { parseJson, uuidParam } from "../validation";

export const connectionRoutes = new Hono<AppEnv>();

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
  return c.json(connection, 201);
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
