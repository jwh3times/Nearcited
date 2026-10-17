import type { Email } from "./report";

export interface ClosingEmail {
  organization: string;
  /** Whether a paid subscription was cancelled. */
  cancelled: boolean;
  /** The WordPress sites still holding an application password the product was given. */
  leftAtSites: string[];
  /** The answer subdomains removed, whose DNS records point at nothing now. */
  hostnames: string[];
}

/**
 * The one email an owner gets when their account is closed: that it is, and anything left for
 * them to do themselves. Composed by rule from what the closing did.
 */
export function buildClosingEmail(email: ClosingEmail): Email {
  const text = [
    `Your Nearcited account and ${email.organization} are closed, as you asked. Everything Nearcited held for it has been deleted.`,
  ];
  if (email.cancelled) {
    text.push("", "Your subscription is cancelled, and you will not be charged again.");
  }
  if (email.leftAtSites.length > 0) {
    text.push(
      "",
      `Nearcited could not reach ${email.leftAtSites.length === 1 ? "this WordPress site" : "these WordPress sites"} to take back the application password it was given:`,
      ...email.leftAtSites.map((site) => `- ${site}`),
      "You can delete it yourself in WordPress, under Users → Profile → Application Passwords.",
    );
  }
  if (email.hostnames.length > 0) {
    text.push(
      "",
      "Nothing is served any more at:",
      ...email.hostnames.map((hostname) => `- ${hostname}`),
      "Delete the CNAME record for each where your domain's DNS is kept, so the name does not point at Nearcited.",
    );
  }
  text.push(
    "",
    "What Nearcited added to your website stays there until you remove it.",
    "",
    "Reply to this email if you have a question.",
  );
  return { subject: `${email.organization} is closed`, text: text.join("\n") };
}

/** The note everyone else in a closed organization gets. */
export function buildClosedNote(organization: string): Email {
  return {
    subject: `${organization} is closed`,
    text: [
      `${organization} was closed by its owner, and everything Nearcited held for it has been deleted. Your own sign-in is still there, and you can start an organization of your own with it.`,
      "",
      "Reply to this email if you have a question.",
    ].join("\n"),
  };
}
