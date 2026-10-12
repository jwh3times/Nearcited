import type { BrokenReason } from "@nearcited/shared";
import type { Email } from "./report";

export interface ConnectionBrokenEmail {
  organization: string;
  /** What its owner knows the account by. */
  label: string;
  reason: BrokenReason;
  /** True for the one reminder, a week after it broke. */
  reminder: boolean;
  appUrl: string;
}

/**
 * The email an organization's owners and admins get when a connected account stops working, and
 * once more a week later: what happened, what it means, and where to put it right.
 */
export function buildConnectionBrokenEmail(email: ConnectionBrokenEmail): Email {
  const { organization, label, reason, reminder } = email;
  const page = `${email.appUrl.replace(/\/$/, "")}/connections`;
  const what =
    reason === "refused"
      ? [
          `${label} refused the sign-in Nearcited was given for ${organization}.`,
          "That happens when a password is changed, or when the access is taken away at the account itself.",
          "",
          "To put it right, remove the account on the Connections page and connect it again:",
        ]
      : [
          `Nearcited has not been able to read from ${label} for ${organization} for three days in a row.`,
          "It keeps trying once a day, and the account will start working again by itself if the cause passes.",
          "",
          "You can see where it stands on the Connections page:",
        ];
  return {
    subject: reminder
      ? `Still not working: ${label} on Nearcited`
      : `Nearcited can no longer read from ${label}`,
    text: [
      ...(reminder
        ? [
            "A week ago we wrote that a connected account had stopped working. It still has not.",
            "",
          ]
        : []),
      ...what,
      page,
      "",
      "Until it works again, nothing is read from it and nothing is done through it.",
      "",
      "Reply to this email if you have a question.",
    ].join("\n"),
  };
}
