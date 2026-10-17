import {
  alertDetail,
  alertEnded,
  groupAlerts,
  summarizeBySurface,
  surfaceWithTier,
} from "@nearcited/shared";
import { Resend } from "resend";
import type { Env } from "../env";
import type { ScanReport } from "../scans/runner";

export interface Email {
  subject: string;
  text: string;
}

const longDate = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });
const day = (iso: string) => longDate.format(new Date(iso));

/**
 * What the owners have not been told yet, as the lines that lead the report: each new alert with
 * what was counted, then each drop that has ended. Empty when there is nothing new to say.
 */
function alertLines(report: ScanReport): string[] {
  const { raised, named_again: ended } = report.alerts;
  const lines: string[] = [];
  if (raised.length > 0) {
    lines.push(
      `${report.location.name} has ${raised.length} new ${raised.length === 1 ? "alert" : "alerts"}.`,
      "",
    );
    for (const group of groupAlerts(raised)) {
      const [only] = group.alerts;
      lines.push(group.title);
      if (group.alerts.length === 1 && only) {
        lines.push(`  ${alertDetail(only, day)}`);
      } else {
        // Only drops are shown several as one, each under the prompt it is about.
        for (const alert of group.alerts) {
          const prompt = alert.kind === "drop" ? `"${alert.facts.prompt}": ` : "";
          lines.push(`  ${prompt}${alertDetail(alert, day)}`);
        }
      }
      lines.push("");
    }
  }
  // Only a drop ends by the business being named again.
  const again = ended.flatMap((alert) => (alert.kind === "drop" ? [alertEnded(alert, day)] : []));
  if (again.length > 0) lines.push(...again, "");
  return lines;
}

/** A new alert leads the subject line, so the message is not taken for a routine report. */
function subjectOf(report: ScanReport): string {
  const { location, score } = report;
  const groups = groupAlerts(report.alerts.raised);
  const [only] = groups;
  if (groups.length === 1 && only) {
    return `${location.name}: ${only.title}`;
  }
  if (groups.length > 1) return `${location.name}: ${report.alerts.raised.length} new alerts`;
  return `${location.name}: visibility ${score === null ? "not scored" : `${score} of 100`}`;
}

export function buildScanReportEmail(report: ScanReport, appUrl: string): Email {
  const { location, score, window } = report;
  // The window holds only the tier this scan asked each surface on, so this scan says which.
  const tierOn = (surface: string) =>
    report.results.find((result) => result.surface === surface)?.tier;
  const lines = summarizeBySurface(window.results).map(
    (summary) =>
      `  ${surfaceWithTier(summary.surface, tierOn(summary.surface))}: named in ${summary.mentions} of ${summary.checks}`,
  );
  const link = `${appUrl.replace(/\/$/, "")}/locations/${location.id}`;

  return {
    subject: subjectOf(report),
    text: [
      ...alertLines(report),
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
