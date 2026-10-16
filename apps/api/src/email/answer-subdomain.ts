import type { Email } from "./report";

export interface AnswerSubdomainEmail {
  organization: string;
  hostname: string;
  /** Live, or why it was removed: an owner asked, the plan stopped including it, or no record. */
  event: "live" | "asked" | "plan" | "unclaimed";
  /** Where the location's Website tab is. */
  page: string;
}

/**
 * The email an organization's owners and admins get when an answer subdomain starts working, and
 * when it is removed: what happened, and what, if anything, they need to do at their registrar.
 */
export function buildAnswerSubdomainEmail(email: AnswerSubdomainEmail): Email {
  const { organization, hostname, page } = email;
  const record = `the CNAME record for ${hostname}`;
  const lines: Record<AnswerSubdomainEmail["event"], { subject: string; text: string[] }> = {
    live: {
      subject: `${hostname} is working`,
      text: [
        `The record you added for ${organization} is in place, and Nearcited now serves https://${hostname}.`,
        "",
        "Each page written for your prompts is offered for approval on the location's Website tab, and goes up there once somebody approves it:",
        page,
      ],
    },
    asked: {
      subject: `Nearcited no longer serves ${hostname}`,
      text: [
        `${hostname} was removed from Nearcited for ${organization}, and nothing is served there now.`,
        "",
        `Delete ${record} where your domain's DNS is kept, so the name does not point at Nearcited any more.`,
      ],
    },
    plan: {
      subject: `Nearcited no longer serves ${hostname}`,
      text: [
        `Your plan no longer includes hosted pages, so ${hostname} was removed for ${organization} and nothing is served there now.`,
        "",
        `Delete ${record} where your domain's DNS is kept, so the name does not point at Nearcited any more.`,
      ],
    },
    unclaimed: {
      subject: `${hostname} was not set up`,
      text: [
        `Nearcited waited thirty days for ${record} for ${organization}, and it did not appear, so ${hostname} was let go.`,
        "",
        "You can start again from the location's Website tab whenever you like:",
        page,
      ],
    },
  };
  const { subject, text } = lines[email.event];
  return {
    subject,
    text: [...text, "", "Reply to this email if you have a question."].join("\n"),
  };
}
