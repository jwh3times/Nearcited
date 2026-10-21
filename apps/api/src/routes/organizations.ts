import {
  AssistantChoiceSchema,
  CloseAccountInputSchema,
  type ClosingMessage,
  LocationInputSchema,
  type Me,
  OrganizationInputSchema,
} from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { followAssistantSwitch } from "../billing/stronger";
import { PaymentDeclinedError } from "../billing/types";
import { ApiError, notFound } from "../errors";
import { exportFileName, exportZip } from "../export";
import { usesSampleData } from "../providers";
import { parseJson, uuidParam } from "../validation";
import { withStrongerModel } from "./billing";

export const organizationRoutes = new Hono<AppEnv>();

organizationRoutes.get("/me", async (c) => {
  const user = c.get("user");
  const store = c.get("store");
  const me: Me = {
    user_id: user.id,
    email: user.email,
    organizations: await store.listOrganizations(),
    roles: await store.listMyRoles(),
    invitations: await store.listMyInvitations(),
    sample_data: usesSampleData(c.env),
    platform_role: await store.getPlatformRole(user.id),
  };
  return c.json(me);
});

organizationRoutes.post("/organizations", async (c) => {
  const { name } = await parseJson(c, OrganizationInputSchema);
  return c.json(await c.get("store").createOrganization(name), 201);
});

organizationRoutes.patch("/organizations/:organizationId", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const { name } = await parseJson(c, OrganizationInputSchema);
  const renamed = await c.get("store").renameOrganization(organizationId, name);
  if (!renamed) throw notFound("Organization");
  return c.json(renamed);
});

/** Which assistants the organization is checked on, within what its plan covers. Owner only. */
organizationRoutes.put("/organizations/:organizationId/assistants", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const { surfaces } = await parseJson(c, AssistantChoiceSchema);
  const organization = await c.get("store").chooseAssistants(organizationId, surfaces);
  if (!organization) throw notFound("Organization");
  // What is paid Stronger on follows to the new assistant. Asking for the same assistants again
  // finishes a move the payment provider did not make the first time.
  const payments = c.get("payments")();
  if (payments) {
    try {
      await followAssistantSwitch(organization, {
        store: c.get("store"),
        payments,
        assistants: withStrongerModel(c),
      });
    } catch (error) {
      if (!(error instanceof PaymentDeclinedError)) throw error;
      throw new ApiError(
        402,
        "payment_declined",
        "The assistant was switched, but your card was declined, so the stronger model has not moved to it. Update your payment method and choose it again.",
      );
    }
  }
  return c.json(organization);
});

/** Everything the organization holds, as a ZIP for its owner to download. Owner only. */
organizationRoutes.get("/organizations/:organizationId/export", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const exported = await c.get("store").exportOrganization(organizationId);
  if (!exported) {
    throw new ApiError(403, "owners_only", "Only an owner of this organization can download it.");
  }
  return new Response(exportZip(exported, c.env.APP_URL), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${exportFileName(exported)}"`,
      "Cache-Control": "private, no-store",
    },
  });
});

const CLOSING_REFUSALS = {
  owners_only: [403, "Only an owner of this organization can close it."],
  not_closable: [409, "This account cannot be closed from here."],
  name_mismatch: [422, "Type the organization's name exactly as it is shown."],
} as const;

/**
 * An owner's ask to close the account. The worker does the closing, and the queue is told here
 * (docs/adr/0020-the-worker-closes-an-account.md). Owner only, never the operator or a test account.
 */
organizationRoutes.post("/organizations/:organizationId/close", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const { name } = await parseJson(c, CloseAccountInputSchema);
  const asked = await c.get("store").requestClosing(organizationId, name);
  if ("refused" in asked) {
    const [status, message] = CLOSING_REFUSALS[asked.refused];
    throw new ApiError(status, asked.refused, message);
  }
  const message: ClosingMessage = { closing_id: asked.closing_id, step: "close" };
  await c.env.SCAN_QUEUE.send(message);
  return c.body(null, 202);
});

organizationRoutes.get("/organizations/:organizationId/locations", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  return c.json(await c.get("store").listLocations(organizationId));
});

organizationRoutes.post("/organizations/:organizationId/locations", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const input = await parseJson(c, LocationInputSchema);
  return c.json(await c.get("store").createLocation(organizationId, input), 201);
});
