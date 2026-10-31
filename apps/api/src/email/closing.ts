import { ANALYTICS_LABEL } from "../connections/google-analytics";
import type { Email } from "./report";

export interface ClosingEmail {
  organization: string;
  /** Whether a paid subscription was cancelled. */
  cancelled: boolean;
  /**
   * What still holds access the product was given: WordPress sites holding an application password,
   * and Google Analytics, by its label, where Google could not be asked to take a sign-in back.
   */
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
  const sites = email.leftAtSites.filter((site) => site !== ANALYTICS_LABEL);
  if (sites.length > 0) {
    text.push(
      "",
      `Nearcited could not reach ${sites.length === 1 ? "this WordPress site" : "these WordPress sites"} to take back the application password it was given:`,
      ...sites.map((site) => `- ${site}`),
      "You can delete it yourself in WordPress, under Users → Profile → Application Passwords.",
    );
  }
  if (sites.length < email.leftAtSites.length) {
    text.push(
      "",
      "Nearcited could not reach Google to take back the read-only access to Google Analytics it was given. You can take it back yourself in your Google account, in its list of the apps that have access.",
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
