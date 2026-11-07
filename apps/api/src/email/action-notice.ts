import { ACTION_KIND_DOING, type Action, type StandingPermission } from "@nearcited/shared";
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
  /** Standing permission given since the last notice. */
  given?: StandingPermission[];
  /** Standing permission that ended since the last notice, with what a take-back took back. */
  ended?: EndedPermission[];
  /** Senders of receipts waiting to be confirmed or declined, with a receipt held. */
  senders?: { address: string; location_name: string }[];
  appUrl: string;
}

/** A standing permission that ended, with the summary of the action whose take-back ended it. */
export type EndedPermission = StandingPermission & { taken_back: string | null };

/** What one standing permission's ending says: who or what ended it, and on what day. */
function endedLine(permission: EndedPermission): string {
  const doing = ACTION_KIND_DOING[permission.kind];
  const on = permission.ended_at ? day.format(new Date(permission.ended_at)) : "";
  const who = permission.ended_by_email ?? "someone who has since left";
  const why =
    permission.end_reason === "switched_off"
      ? `- ${who} ended the standing permission to ${doing} on ${on}.`
      : permission.end_reason === "taken_back"
        ? `- The standing permission to ${doing} ended on ${on}, when ${who} asked to take back something done under it${
            permission.taken_back ? `: ${permission.taken_back}` : ""
          }.`
        : `- The standing permission to ${doing} ended on ${on}: your plan no longer includes standing permission.`;
  return `${why} These wait for a yes again.`;
}

/** How many review requests one location sent, and how many newly wait for a yes. */
interface RequestsAt {
  location_name: string;
  sent: number;
  waiting: number;
}

/**
 * Review requests by location, in the order their locations first come: told as one line each,
 * since a location may ask dozens of customers a day.
 */
function requestsByLocation(done: NoticedAction[], waiting: NoticedAction[]) {
  const at = new Map<string, RequestsAt>();
  const add = (rows: NoticedAction[], which: "sent" | "waiting") => {
    for (const { action, location_name } of rows) {
      if (action.kind !== "review_request") continue;
      const kept = at.get(action.location_id) ?? { location_name, sent: 0, waiting: 0 };
      kept[which]++;
      at.set(action.location_id, kept);
    }
  };
  add(done, "sent");
  add(waiting, "waiting");
  return at;
}

/**
 * The day's message to an organization's owners: everything Nearcited did for it since the last
 * one, with who approved each or the standing permission it was done under, what is newly waiting
 * for a yes, and any standing permission given or ended. Review requests are told as one line for
 * each location, with how many were sent and how many wait, linking to the list. An owner is told
 * of what they approved themselves too: this is the record of what changed.
 */
export function buildActionNoticeEmail(email: ActionNoticeEmail): Email {
  const { organization, given = [], ended = [], senders = [] } = email;
  const app = email.appUrl.replace(/\/$/, "");
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const notRequest = ({ action }: NoticedAction) => action.kind !== "review_request";
  const done = email.done.filter(notRequest);
  const waiting = email.waiting.filter(notRequest);
  const requests = requestsByLocation(email.done, email.waiting);
  const lines: string[] = [];

  if (done.length > 0) {
    lines.push(`Here is what Nearcited did for ${organization} since we last wrote:`, "");
    for (const { action, location_name } of done) {
      const doneOn = action.done_at ? ` on ${day.format(new Date(action.done_at))}` : "";
      if (action.approved_under) {
        const giver = action.approved_under_by_email ?? "someone who has since left";
        const givenOn = action.approved_under_at
          ? ` gave on ${day.format(new Date(action.approved_under_at))}`
          : " gave";
        lines.push(
          `- ${location_name}: ${action.summary}. Done${doneOn} without waiting for a yes, under the standing permission ${giver}${givenOn}.`,
        );
        continue;
      }
      const approver = action.approved_by_email ?? "someone who has since left";
      lines.push(
        `- ${location_name}: ${action.summary}. Approved by ${approver}${
          action.approved_text ? ", who changed the text first" : ""
        }${doneOn ? `, and done${doneOn}` : ""}.`,
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
  if (requests.size > 0) {
    lines.push("Review requests:", "");
    for (const [locationId, { location_name, sent, waiting: asked }] of requests) {
      const said = [
        sent > 0 ? `${count(sent, "review request", "review requests")} sent` : "",
        asked > 0
          ? `${sent > 0 ? asked : count(asked, "review request", "review requests")} waiting for a yes`
          : "",
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(
        `- ${location_name}: ${said}. See them: ${app}/locations/${locationId}?tab=actions`,
      );
    }
    lines.push(
      "",
      "A review request waiting is sent only once someone in your organization approves it, and lapses a week after the job.",
      "",
    );
  }
  if (given.length > 0 || ended.length > 0) {
    lines.push("Standing permission:", "");
    for (const permission of given) {
      const giver = permission.given_by_email ?? "someone who has since left";
      lines.push(
        `- ${giver} gave standing permission on ${day.format(new Date(permission.given_at))}: Nearcited may ${ACTION_KIND_DOING[permission.kind]} at every location without waiting for a yes.`,
      );
    }
    for (const permission of ended) lines.push(endedLine(permission));
    lines.push("");
  }
  if (email.done.some(({ action }) => action.approved_under) || given.length > 0) {
    lines.push(
      "An owner or admin can end a standing permission on the Actions tab of any location, and from then on everything of that kind waits for a yes.",
      "",
    );
  }
  if (senders.length > 0) {
    lines.push(
      senders.length === 1
        ? "Receipts from a new sender are held until someone confirms it is your own tool:"
        : "Receipts from new senders are held until someone confirms each is your own tool:",
      "",
    );
    for (const sender of senders) lines.push(`- ${sender.location_name}: ${sender.address}`);
    lines.push(
      "",
      "An owner or admin confirms or declines a sender under Review requests on the location's Settings tab. What a sender sent is deleted after seven days if nobody confirms it.",
      "",
    );
  }
  lines.push(
    "You can read exactly what was changed, and answer what is waiting, on each location's Actions tab:",
    app,
    "",
    "Reply to this email if you have a question.",
  );

  return {
    subject:
      email.done.length > 0
        ? `What Nearcited did for ${organization}`
        : email.waiting.length > 0
          ? `Waiting for your yes at ${organization}`
          : given.length > 0 || ended.length > 0
            ? `Standing permission at ${organization}`
            : `Receipts waiting for your yes at ${organization}`,
    text: lines.join("\n"),
  };
}
