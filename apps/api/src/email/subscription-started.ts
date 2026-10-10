import type { Email } from "./report";

const dollars = (cents: number) =>
  cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;

const day = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

export interface SubscriptionStartedEmail {
  organization: string;
  plan: string;
  /** How many locations are paid for. */
  locations: number;
  /** What it comes to a month, in US cents before tax. */
  monthly_cents: number;
  /** When the period paid for ends. An ISO timestamp, or null when the provider gave none. */
  renews_at: string | null;
  appUrl: string;
}

/**
 * The email an organization's owners get when its subscription starts: thanks, what they are
 * paying for, and where to change it. The receipt is the payment provider's to send.
 */
export function buildSubscriptionStartedEmail(email: SubscriptionStartedEmail): Email {
  const { organization, plan, locations } = email;
  const settings = `${email.appUrl.replace(/\/$/, "")}/settings`;
  return {
    subject: `Your Nearcited ${plan} subscription has started`,
    text: [
      `Thank you for subscribing. ${organization} is now on the ${plan} plan.`,
      "",
      `  Plan: ${plan}`,
      `  Locations: ${locations}`,
      `  Price: ${dollars(email.monthly_cents)} a month, before tax`,
      ...(email.renews_at ? [`  Renews: ${day.format(new Date(email.renews_at))}`] : []),
      "",
      "The receipt for your payment comes separately from Stripe, which takes payments for us.",
      "",
      "You can change your plan or the number of locations, update your payment method, see your invoices or cancel at any time:",
      settings,
      "",
      "Reply to this email if you have a question.",
    ].join("\n"),
  };
}
