import { type InvitedRole, ROLE_MEANS } from "@nearcited/shared";
import type { Email } from "./report";

export interface InvitationEmail {
  organization: string;
  /** The owner who sent it, when their address is known. */
  invitedBy: string | null;
  /** The address it was sent to, which is the one to sign in with. */
  email: string;
  role: InvitedRole;
  expiresAt: string;
  appUrl: string;
}

const AS_ROLE: Record<InvitedRole, string> = {
  admin: `an admin, who can ${ROLE_MEANS.admin}`,
  member: `a member, who can ${ROLE_MEANS.member}`,
};

/**
 * The email an invited person gets: who invited them to what, and that signing in with this
 * address is all accepting takes. There is no link to click that does anything by itself.
 */
export function buildInvitationEmail(email: InvitationEmail): Email {
  const { organization, invitedBy } = email;
  const until = new Date(email.expiresAt).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  return {
    subject: invitedBy
      ? `${invitedBy} invited you to ${organization} on Nearcited`
      : `You are invited to ${organization} on Nearcited`,
    text: [
      `${invitedBy ?? "An owner"} invited you to join ${organization} on Nearcited, as ${AS_ROLE[email.role]}.`,
      "",
      `To accept, sign in with this address (${email.email}). The invitation will be waiting:`,
      email.appUrl.replace(/\/$/, ""),
      "",
      `It waits until ${until}. If you were not expecting it, you can ignore this email, or decline it once you have signed in.`,
    ].join("\n"),
  };
}
