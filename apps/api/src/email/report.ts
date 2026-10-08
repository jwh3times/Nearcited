import { SURFACE_LABELS, summarizeBySurface } from "@nearcited/shared";
import { Resend } from "resend";
import type { Env } from "../env";
import type { ScanReport } from "../scans/runner";

export interface Email {
  subject: string;
  text: string;
}

export function buildScanReportEmail(report: ScanReport, appUrl: string): Email {
  const { location, score, window } = report;
  const lines = summarizeBySurface(window.results).map(
    (summary) =>
      `  ${SURFACE_LABELS[summary.surface]}: named in ${summary.mentions} of ${summary.checks}`,
  );
  const link = `${appUrl.replace(/\/$/, "")}/locations/${location.id}`;

  return {
    subject: `${location.name}: visibility ${score === null ? "not scored" : `${score} of 100`}`,
    text: [
      `Latest scan for ${location.name} (${location.city}).`,
      "",
      `Visibility score: ${score === null ? "not scored" : `${score} of 100`}`,
      "",
      window.scans > 1
        ? `Where it was named, over the last ${window.scans} scans:`
        : "Where it was named:",
      ...lines,
      "",
      `Full results: ${link}`,
    ].join("\n"),
  };
}

/**
 * An email as it is handed to the mail service. The sender is an address nobody reads, so a
 * reply is pointed at one that is, when the deployment names it.
 */
export function emailMessage(
  env: Pick<Env, "EMAIL_FROM" | "EMAIL_REPLY_TO">,
  to: string[],
  email: Email,
) {
  const replyTo = env.EMAIL_REPLY_TO?.trim();
  return { from: env.EMAIL_FROM, to, ...(replyTo ? { replyTo } : {}), ...email };
}

export async function sendEmail(env: Env, to: string[], email: Email): Promise<void> {
  if (!env.RESEND_API_KEY || to.length === 0) return;
  const resend = new Resend(env.RESEND_API_KEY);
  const { error } = await resend.emails.send(emailMessage(env, to, email));
  if (error) throw new Error(`Resend rejected the email: ${error.message}`);
}
