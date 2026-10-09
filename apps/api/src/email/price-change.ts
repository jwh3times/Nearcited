import type { Email } from "./report";

const dollars = (cents: number) =>
  cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;

const day = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

export interface PriceChangeEmail {
  kind: "announce" | "remind" | "call_off";
  organization: string;
  plan: string;
  /** What the organization pays a month now, in US cents before tax. */
  was_cents: number;
  /** What it will pay a month, for the same locations. */
  now_cents: number;
  /** From when: its first renewal on or after this day. An ISO timestamp. */
  effective_at: string;
  appUrl: string;
}

/**
 * The three emails a price change sends an organization's owners: that it is coming, that it is
 * a week away, and that it has been called off. Plain words and the numbers, nothing else.
 */
export function buildPriceChangeEmail(email: PriceChangeEmail): Email {
  const { kind, organization, plan } = email;
  const was = `${dollars(email.was_cents)} a month`;
  const next = `${dollars(email.now_cents)} a month`;
  const when = day.format(new Date(email.effective_at));
  const settings = `${email.appUrl.replace(/\/$/, "")}/settings`;
  const lower = email.now_cents < email.was_cents;

  if (kind === "call_off") {
    return {
      subject: `Your Nearcited price is not changing`,
      text: [
        `We told you the price of the ${plan} plan for ${organization} would change on ${when}.`,
        "",
        `That change has been called off. You go on paying ${was}, before tax, and there is nothing you need to do.`,
        "",
        `Your plan and billing: ${settings}`,
      ].join("\n"),
    };
  }

  const what = lower ? "is going down" : "is changing";
  const lines =
    kind === "announce"
      ? [
          `The price of the ${plan} plan ${what}.`,
          "",
          `${organization} pays ${was} today. From your first renewal on or after ${when} it will be ${next}. Both are before tax, for the locations you pay for now.`,
        ]
      : [
          `A reminder: the price of the ${plan} plan changes in a week.`,
          "",
          `${organization} pays ${was} today. From your first renewal on or after ${when} it will be ${next}, before tax.`,
        ];
  return {
    subject:
      kind === "announce"
        ? `The price of your Nearcited plan ${what} on ${when}`
        : `Reminder: your Nearcited price changes on ${when}`,
    text: [
      ...lines,
      "",
      lower
        ? "There is nothing you need to do."
        : "Nothing is charged until then, and nothing about your plan changes. If you would rather move to another plan or cancel, you can do either at any time before that day:",
      ...(lower ? [] : [settings]),
      "",
      "Reply to this email if you have a question.",
    ].join("\n"),
  };
}
