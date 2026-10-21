import {
  type Invitation,
  type Invited,
  InviteInputSchema,
  type Members,
  RoleChangeSchema,
} from "@nearcited/shared";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../app";
import { buildInvitationEmail } from "../email/invitation";
import { notFound } from "../errors";
import { parseJson, uuidParam } from "../validation";

/**
 * Who is in an organization (issue #10). Every change goes through a database function that
 * answers an owner, or the person themselves, and keeps the organization an owner; anyone else
 * gets 404, as if there were nothing there.
 */
export const memberRoutes = new Hono<AppEnv>();

/**
 * Emails an invitation from the request that made it. False where none went: a test organization,
 * which never writes to an inbox, a deployment with no mail service, or a send that failed. The
 * invitation stands either way, since signing in with the address is what accepting takes.
 */
async function emailInvitation(c: Context<AppEnv>, invitation: Invitation): Promise<boolean> {
  const organization = await c.get("store").getOrganization(invitation.organization_id);
  if (!organization || organization.is_test || !c.env.RESEND_API_KEY) return false;
  try {
    await c.get("send")(
      [invitation.email],
      buildInvitationEmail({
        organization: organization.name,
        invitedBy: invitation.invited_by_email,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expires_at,
        appUrl: c.env.APP_URL,
      }),
    );
    return true;
  } catch (error) {
    console.error(`Invitation ${invitation.id}: its email could not be sent`, error);
    return false;
  }
}

/** Who is in it, for any member and the operator; and its invitations, for an owner and the operator. */
memberRoutes.get("/organizations/:organizationId/members", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const store = c.get("store");
  const members = await store.listMembers(organizationId);
  if (!members) throw notFound("Organization");
  const readsInvitations =
    (await store.listMyRoles())[organizationId] === "owner" ||
    (await store.getPlatformRole(c.get("user").id)) === "operator";
  const answer: Members = {
    members,
    invitations: readsInvitations ? await store.listInvitations(organizationId) : null,
  };
  return c.json(answer);
});

/** Invites an address as an admin or a member. Owner only. */
memberRoutes.post("/organizations/:organizationId/invitations", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const { email, role } = await parseJson(c, InviteInputSchema);
  const invitation = await c.get("store").inviteMember(organizationId, email, role);
  if (!invitation) throw notFound("Organization");
  const answer: Invited = { invitation, emailed: await emailInvitation(c, invitation) };
  return c.json(answer, 201);
});

/** Sends an invitation again, for fourteen days from now. Owner only, once an hour. */
memberRoutes.post("/organizations/:organizationId/invitations/:invitationId/send", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const invitationId = uuidParam(c, "invitationId", "Invitation");
  const invitation = await c.get("store").sendInvitationAgain(organizationId, invitationId);
  if (!invitation) throw notFound("Invitation");
  const answer: Invited = { invitation, emailed: await emailInvitation(c, invitation) };
  return c.json(answer);
});

/** Cancels an invitation, or removes a declined or expired one from the list. Owner only. */
memberRoutes.delete("/organizations/:organizationId/invitations/:invitationId", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const invitationId = uuidParam(c, "invitationId", "Invitation");
  const cancelled = await c.get("store").cancelInvitation(organizationId, invitationId);
  if (!cancelled) throw notFound("Invitation");
  return c.body(null, 204);
});

/** Gives someone another role, owner included. Owner only. */
memberRoutes.patch("/organizations/:organizationId/members/:userId", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const userId = uuidParam(c, "userId", "Member");
  const { role } = await parseJson(c, RoleChangeSchema);
  if (!(await c.get("store").changeMemberRole(organizationId, userId, role))) {
    throw notFound("Member");
  }
  return c.body(null, 204);
});

/** Removes someone from the organization. Owner only. Their sign-in stays theirs. */
memberRoutes.delete("/organizations/:organizationId/members/:userId", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  const userId = uuidParam(c, "userId", "Member");
  if (!(await c.get("store").removeMember(organizationId, userId))) throw notFound("Member");
  return c.body(null, 204);
});

/** The caller leaves the organization, unless they are its last owner. */
memberRoutes.post("/organizations/:organizationId/leave", async (c) => {
  const organizationId = uuidParam(c, "organizationId", "Organization");
  if (!(await c.get("store").leaveOrganization(organizationId))) throw notFound("Organization");
  return c.body(null, 204);
});

/** The invited person accepts, signed in with the address it was sent to. */
memberRoutes.post("/invitations/:invitationId/accept", async (c) => {
  const invitationId = uuidParam(c, "invitationId", "Invitation");
  const accepted = await c.get("store").acceptInvitation(invitationId);
  if (!accepted) throw notFound("Invitation");
  return c.json(accepted);
});

/** The invited person declines. */
memberRoutes.post("/invitations/:invitationId/decline", async (c) => {
  const invitationId = uuidParam(c, "invitationId", "Invitation");
  if (!(await c.get("store").declineInvitation(invitationId))) throw notFound("Invitation");
  return c.body(null, 204);
});
