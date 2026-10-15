import {
  type Action,
  EDITABLE_ACTION_KINDS,
  type LocationActions,
  pageParts,
  pageSlug,
} from "@nearcited/shared";
import { api } from "./api";

/** How often the page asks again while the worker is carrying something out. */
const WAITING_MS = 2000;

/**
 * A location's actions. While one is approved and not yet carried out it is asked for again
 * every couple of seconds, since the worker does that on its own time.
 */
export const actionsQuery = (locationId: string) => ({
  queryKey: ["actions", locationId],
  queryFn: () => api.locationActions(locationId),
  refetchInterval: (query: { state: { data?: LocationActions } }) =>
    query.state.data?.record.some((action) => action.status === "approved") ? WAITING_MS : false,
});

/** Whether a location has anything to show on its Actions tab: waiting, or done before. */
export const hasActions = (found: LocationActions | undefined): boolean =>
  found !== undefined && found.waiting.length + found.record.length > 0;

/** The text an action puts there: what was approved, which is the proposal unless it was changed. */
export const actionText = (action: Action): string | null =>
  action.approved_text ?? action.proposed_text;

/** Who wrote what an action would say, as the page says it. */
export const writtenBy = (action: Action): string =>
  action.written_by === "model"
    ? "Written by a model"
    : "Composed by rule from this location's details";

/**
 * Where an action stands, in a sentence for the record: what became of it, who answered, and
 * when. `day` writes a date the way the page does.
 */
export function actionState(action: Action, day: (iso: string) => string): string {
  const approver = action.approved_by_email ?? "someone who has left";
  const approved = action.takes_back
    ? `Asked for by ${approver}.`
    : `Approved by ${approver}${action.approved_text ? ", who changed the text" : ""}.`;
  switch (action.status) {
    case "proposed":
      return `Waiting for a yes until ${day(action.lapses_at)}.`;
    case "approved":
      return `${approved} Being carried out.`;
    case "done":
      return `Done${action.done_at ? ` on ${day(action.done_at)}` : ""}. ${approved}`;
    case "failed":
      return `Failed${action.failed_at ? ` on ${day(action.failed_at)}` : ""}: ${action.failure ?? "it could not be done"} ${approved}`;
    case "declined":
      return `Declined by ${action.declined_by_email ?? "someone who has left"}${
        action.declined_at ? ` on ${day(action.declined_at)}` : ""
      }${action.decline_reason ? `: ${action.decline_reason}` : "."}`;
    case "lapsed":
      if (action.lapse_reason !== "out_of_date") {
        return `Lapsed${action.lapsed_at ? ` on ${day(action.lapsed_at)}` : ""}: nobody answered in fourteen days.`;
      }
      // Dropped before it lapsed: there was nothing left to check what was there against.
      return droppedFirst(action)
        ? `Not done: what it would have replaced could no longer be kept, so it could not be checked.${action.approved_at ? ` ${approved}` : ""}`
        : `Not done: what it would have replaced had changed since it was proposed. ${approved}`;
  }
}

const droppedFirst = (action: Action): boolean =>
  action.seen_dropped_at !== null &&
  action.lapsed_at !== null &&
  Date.parse(action.seen_dropped_at) <= Date.parse(action.lapsed_at);

/**
 * What an action replaced, for the record. Null when it read nothing to replace. Once that may
 * be kept no longer it is dropped, and the record says so in its place.
 */
export function whatItReplaced(action: Action, day: (iso: string) => string): string | null {
  if (action.seen_dropped_at !== null) {
    return `No longer kept. It was dropped on ${day(action.seen_dropped_at)}.`;
  }
  if (action.seen === null) return null;
  return action.seen.text ?? "Nothing";
}

/** Whether a member may change what an action would put there before saying yes. */
export const editable = (action: Pick<Action, "kind">): boolean =>
  EDITABLE_ACTION_KINDS.includes(action.kind);

/** Whether what an action puts there is markup, shown as it is written rather than as prose. */
export const isMarkup = (action: Pick<Action, "kind">): boolean =>
  action.kind === "wordpress_details";

/** What the page asks before taking an action back. */
export const TAKE_BACK_QUESTION =
  "Take this back? Nearcited will put back what was there before, as long as nobody has changed it since. Your organization's owners are told, as for anything else Nearcited does.";

/** Whether what an action puts there is a page's copy: prose of some length, laid out in blocks. */
export const isPage = (action: Pick<Action, "kind">): boolean => action.kind === "wordpress_page";

/** Where a page's copy is published on the site: the address its title makes. */
export const pageAddress = (copy: string): string => `/${pageSlug(pageParts(copy).title)}/`;
