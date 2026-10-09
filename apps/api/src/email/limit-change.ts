import { describeLowered, type LoweredLimits } from "@nearcited/shared";
import type { Email } from "./report";

const day = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

export interface LimitChangeEmail {
  /** `made` is for the free plan, where a reduction is made at once and told the same day. */
  kind: "announce" | "remind" | "call_off" | "made";
  organization: string;
  plan: string;
  lowered: LoweredLimits;
  /** The day it is made. An ISO timestamp. */
  effective_at: string;
  appUrl: string;
}

/**
 * The emails a reduction in what a plan allows sends an organization's owners: that it is
 * coming, that it is a week away, that it has been called off, and, for the free plan, that it
 * has been made. What goes down is listed, each line with what it is now and what it will be.
 */
export function buildLimitChangeEmail(email: LimitChangeEmail): Email {
  const { kind, organization, plan } = email;
  const when = day.format(new Date(email.effective_at));
  const base = email.appUrl.replace(/\/$/, "");
  const lines = describeLowered(email.lowered, kind === "made").map((line) => `  ${line}`);
  const kept =
    "Nothing is deleted. Anything the plan no longer covers is paused, stays readable, and comes back on a plan that covers it.";

  if (kind === "call_off") {
    return {
      subject: "Your Nearcited plan is not changing",
      text: [
        `We told you that what the ${plan} plan includes for ${organization} would change on ${when}.`,
        "",
        "That change has been called off. Your plan stays as it is, and there is nothing you need to do.",
        "",
        `Your plan: ${base}/settings`,
      ].join("\n"),
    };
  }

  if (kind === "made") {
    return {
      subject: `What the Nearcited ${plan} plan includes has changed`,
      text: [
        `What the ${plan} plan includes changed today. For ${organization}:`,
        "",
        ...lines,
        "",
        kept,
        "",
        `Plans that include more: ${base}/pricing`,
      ].join("\n"),
    };
  }

  return {
    subject:
      kind === "announce"
        ? `What your Nearcited plan includes is changing on ${when}`
        : `Reminder: your Nearcited plan changes on ${when}`,
    text: [
      kind === "announce"
        ? `What the ${plan} plan includes is changing on ${when}. For ${organization}:`
        : `A reminder: what the ${plan} plan includes changes in a week, on ${when}. For ${organization}:`,
      "",
      ...lines,
      "",
      "Nothing changes before that day.",
      kept,
      "",
      "If you would rather move to another plan or cancel, you can do either at any time before that day:",
      `${base}/settings`,
      "",
      "Reply to this email if you have a question.",
    ].join("\n"),
  };
}
