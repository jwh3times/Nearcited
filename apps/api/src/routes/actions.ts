import {
  type Action,
  ActionApprovalSchema,
  ActionDeclineSchema,
  type LocationActions,
} from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { notFound } from "../errors";
import { parseJson, uuidParam } from "../validation";

export const actionRoutes = new Hono<AppEnv>();

/** Queues the worker to carry an approved action out. If the message is lost the schedule sends it. */
async function queueCarryOut(queue: AppEnv["Bindings"]["SCAN_QUEUE"], action: Action) {
  if (action.status !== "approved") return;
  try {
    await queue.send({ action_id: action.id, step: "carry_out" });
  } catch (error) {
    console.error(`Action ${action.id}: could not queue it, the schedule will`, error);
  }
}

/**
 * A location's actions, for anyone who can read the location: what is waiting for a yes, and
 * the record of everything else, newest first.
 */
actionRoutes.get("/locations/:locationId/actions", async (c) => {
  const locationId = uuidParam(c, "locationId", "Location");
  const store = c.get("store");
  if (!(await store.getLocation(locationId))) throw notFound("Location");
  const actions = await store.listLocationActions(locationId);
  return c.json({
    waiting: actions.filter((action) => action.status === "proposed"),
    record: actions.filter((action) => action.status !== "proposed"),
  } satisfies LocationActions);
});

/** How many actions wait for a yes at each of an organization's locations. */
actionRoutes.get("/organizations/:organizationId/actions/waiting", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const store = c.get("store");
  if (!(await store.getOrganization(organizationId))) throw notFound("Organization");
  return c.json(await store.countWaitingActions(organizationId));
});

/**
 * A member's yes to one action, with its text changed or not. Any member of the location's
 * organization: to anyone else, the operator included, the action is not found. The request
 * only records the yes. The worker carries the action out, because only it can read the sign-in.
 */
actionRoutes.post("/actions/:actionId/approve", async (c) => {
  const id = uuidParam(c, "actionId", "Action");
  const { text } = await parseJson(c, ActionApprovalSchema);
  const action = await c.get("store").approveAction(id, text);
  if (!action) throw notFound("Action");
  await queueCarryOut(c.env.SCAN_QUEUE, action);
  return c.json(action);
});

/** A member's no to one action, with a reason or without. */
actionRoutes.post("/actions/:actionId/decline", async (c) => {
  const id = uuidParam(c, "actionId", "Action");
  const { reason } = await parseJson(c, ActionDeclineSchema);
  const action = await c.get("store").declineAction(id, reason);
  if (!action) throw notFound("Action");
  return c.json(action);
});

/**
 * Asks for a failed action again. It is a new action, approved by whoever asked, which points
 * at the one that failed.
 */
actionRoutes.post("/actions/:actionId/retry", async (c) => {
  const id = uuidParam(c, "actionId", "Action");
  const action = await c.get("store").retryAction(id);
  if (!action) throw notFound("Action");
  await queueCarryOut(c.env.SCAN_QUEUE, action);
  return c.json(action, 201);
});
