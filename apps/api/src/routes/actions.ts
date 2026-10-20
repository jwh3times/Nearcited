import {
  type Action,
  ActionApprovalSchema,
  ActionDeclineSchema,
  ActionKindSchema,
  EDITABLE_ACTION_KINDS,
  type LocationActions,
  type Organization,
  StandingPermissionAskSchema,
} from "@nearcited/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { ApiError, notFound } from "../errors";
import { usesSampleData } from "../providers";
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
 * Refuses a yes where the notice it would need cannot be sent. An organization's owners are told
 * of every action within 48 hours, so where this deployment has no outgoing email a real action
 * is not started at all. Sample data and test organizations are let through: their record on
 * the page is the notice. An action the caller cannot read is left for the store to refuse.
 */
async function requireNotice(c: Context<AppEnv>, actionId: string) {
  if (c.env.RESEND_API_KEY || usesSampleData(c.env)) return;
  const store = c.get("store");
  const action = await store.getAction(actionId);
  const location = action && (await store.getLocation(action.location_id));
  const organization = location && (await store.getOrganization(location.organization_id));
  requireNoticeFor(c, organization);
}

/** The same refusal, for an organization: standing permission is a yes to every action of a kind. */
function requireNoticeFor(c: Context<AppEnv>, organization: Organization | null | undefined) {
  if (c.env.RESEND_API_KEY || usesSampleData(c.env)) return;
  if (!organization || organization.is_test) return;
  throw new ApiError(
    503,
    "actions_unavailable",
    "Nothing can be approved here: outgoing email is not set up, so your organization's owners could not be told what was done.",
  );
}

/**
 * A location's actions, for anyone who can read the location: what is waiting for a yes, and
 * the record of everything else, newest first.
 */
actionRoutes.get("/locations/:locationId/actions", async (c) => {
  const locationId = uuidParam(c, "locationId", "Location");
  const store = c.get("store");
  if (!(await store.getLocation(locationId))) throw notFound("Location");
  const [actions, held, permission] = await Promise.all([
    store.listLocationActions(locationId),
    store.isLocationHeld(locationId),
    store.getPermissionState(locationId),
  ]);
  if (!permission) throw notFound("Location");
  return c.json({
    waiting: actions.filter((action) => action.status === "proposed"),
    record: actions.filter((action) => action.status !== "proposed"),
    held,
    ...permission,
  } satisfies LocationActions);
});

/**
 * Gives standing permission for one kind of action, for the whole organization. Owner or admin
 * only: to anyone else, the operator included, the organization is not found. Refused where the
 * plan does not include it, fewer than three of the kind were approved as proposed and done, or
 * no notice of what is done under it could be sent.
 */
actionRoutes.post("/organizations/:organizationId/standing-permissions", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const { kind } = await parseJson(c, StandingPermissionAskSchema);
  const store = c.get("store");
  const organization = await store.getOrganization(organizationId);
  if (!organization) throw notFound("Organization");
  requireNoticeFor(c, organization);
  const given = await store.giveStandingPermission(organizationId, kind);
  if (!given) throw notFound("Organization");
  return c.json(given, 201);
});

/**
 * Ends standing permission for one kind of action. Owner or admin only. What it approved and is
 * not under way waits for a yes again, at once.
 */
actionRoutes.delete("/organizations/:organizationId/standing-permissions/:kind", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const kind = ActionKindSchema.safeParse(c.req.param("kind"));
  if (!kind.success) throw notFound("Kind of action");
  const ended = await c.get("store").endStandingPermission(organizationId, kind.data);
  if (!ended) throw notFound("Organization");
  return c.json(ended);
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
  await requireNotice(c, id);
  // What a rule composed from the location's details goes onto a site as it is.
  if (text !== undefined) {
    const kept = await c.get("store").getAction(id);
    if (kept && !EDITABLE_ACTION_KINDS.includes(kept.kind)) {
      throw new ApiError(
        422,
        "not_editable",
        "This change is made as it was proposed. Approve it or decline it.",
      );
    }
  }
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
  await requireNotice(c, id);
  const action = await c.get("store").retryAction(id);
  if (!action) throw notFound("Action");
  await queueCarryOut(c.env.SCAN_QUEUE, action);
  return c.json(action, 201);
});

/**
 * Asks to have an action that was done taken back. It is a new action, approved by whoever asked,
 * which puts back what was there before, where that is still what the action left. Any member of
 * the location's organization; to anyone else, the operator included, the action is not found.
 */
actionRoutes.post("/actions/:actionId/take-back", async (c) => {
  const id = uuidParam(c, "actionId", "Action");
  await requireNotice(c, id);
  const action = await c.get("store").takeBackAction(id);
  if (!action) throw notFound("Action");
  await queueCarryOut(c.env.SCAN_QUEUE, action);
  return c.json(action, 201);
});
