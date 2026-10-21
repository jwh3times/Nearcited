import {
  type Invitation,
  invitationState,
  type Member,
  type MemberRole,
  type MyInvitation,
} from "@nearcited/shared";
import { formatDay } from "./billing";

export const ROLE_NAMES: Record<MemberRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

const AS_ROLE: Record<MemberRole, string> = {
  owner: "an owner",
  admin: "an admin",
  member: "a member",
};

/** Whether there is an owner besides this one, so they may step down, be removed or leave. */
export function anotherOwner(members: Member[], userId: string): boolean {
  return members.some((member) => member.role === "owner" && member.user_id !== userId);
}

/** Where an invitation stands, in words: "Waiting until …", "Expired on …" or "Declined". */
export function invitationLine(invitation: Invitation, now: Date = new Date()): string {
  switch (invitationState(invitation, now)) {
    case "declined":
      return "Declined";
    case "expired":
      return `Expired on ${formatDay(invitation.expires_at)}`;
    default:
      return `Waiting until ${formatDay(invitation.expires_at)}`;
  }
}

/** What the owner is told once an invitation is made or sent again. */
export function invitedNote(email: string, emailed: boolean): string {
  return emailed
    ? `Invited ${email}. They have been sent an email.`
    : `Invited ${email}, but no email could be sent. Tell them to sign in to Nearcited with that address, and the invitation will be waiting.`;
}

/** Who invited the signed-in person to what, as their invitation says it. */
export function invitationHeadline(invitation: MyInvitation): string {
  return `${invitation.invited_by_email ?? "An owner"} invited you to ${invitation.organization_name} as ${AS_ROLE[invitation.role]}.`;
}

/**
 * Why someone who has an organization cannot simply accept: an account has one. An only owner
 * would have to close theirs, anyone else leave it.
 */
export function joiningNeeds(ownOrganization: string, onlyOwner: boolean): string {
  return onlyOwner
    ? `An account belongs to one organization. To join, you would first close ${ownOrganization} from Account settings, which deletes it.`
    : `An account belongs to one organization. To join, you would first leave ${ownOrganization} from Account settings.`;
}
