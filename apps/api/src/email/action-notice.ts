import type { Action } from "@nearcited/shared";
import type { Email } from "./report";

const day = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

/** One action in the notice, with the location it was for. */
export interface NoticedAction {
  action: Action;
  location_name: string;
}

export interface ActionNoticeEmail {
  organization: string;
  /** What was carried out since the last notice. */
  done: NoticedAction[];
  /** What is waiting for a yes and has not been mentioned before. */
  waiting: NoticedAction[];
  appUrl: string;
}

/**
 * The day's message to an organization's owners: everything Nearcited did for it since the last
 * one, with who approved each, and what is newly waiting for a yes. An owner is told of what
 * they approved themselves too: this is the record of what changed.
 */
export function buildActionNoticeEmail(email: ActionNoticeEmail): Email {
  const { organization, done, waiting } = email;
  const app = email.appUrl.replace(/\/$/, "");
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const lines: string[] = [];

  if (done.length > 0) {
    lines.push(`Here is what Nearcited did for ${organization} since we last wrote:`, "");
    for (const { action, location_name } of done) {
      const approver = action.approved_by_email ?? "someone who has since left";
      lines.push(
        `- ${location_name}: ${action.summary}. Approved by ${approver}${
          action.approved_text ? ", who changed the text first" : ""
        }${action.done_at ? `, and done on ${day.format(new Date(action.done_at))}` : ""}.`,
      );
    }
    lines.push("");
  }
  if (waiting.length > 0) {
    lines.push(
      done.length > 0
        ? `${count(waiting.length, "thing is", "things are")} also waiting for a yes:`
        : `${count(waiting.length, "thing is", "things are")} waiting for a yes at ${organization}:`,
      "",
    );
    for (const { action, location_name } of waiting) {
      lines.push(
        `- ${location_name}: ${action.summary}. It waits until ${day.format(new Date(action.lapses_at))}.`,
      );
    }
    lines.push("", "Nothing waiting is done until someone in your organization approves it.", "");
  }
  lines.push(
    "You can read exactly what was changed, and answer what is waiting, on each location's Actions tab:",
    app,
    "",
    "Reply to this email if you have a question.",
  );

  return {
    subject:
      done.length > 0
        ? `What Nearcited did for ${organization}`
        : `Waiting for your yes at ${organization}`,
    text: lines.join("\n"),
  };
}
