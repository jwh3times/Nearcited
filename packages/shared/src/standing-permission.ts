import type { ActionKind } from "./schemas";

/**
 * Standing permission: an owner's or admin's yes in advance to every action of one kind, for the
 * whole organization (`docs/adr/0025-standing-permission-is-checked-where-an-action-is-approved-and-carried-out.md`).
 */

/** The allowance a plan includes standing permission with. A key of `ALLOWANCE_KINDS`. */
export const STANDING_PERMISSION_ALLOWANCE = "standing_permission";

/**
 * How many actions of a kind a member must have approved as proposed, and seen carried out and
 * not taken back, before standing permission for the kind is offered. The database counts them
 * in `standing_permission_count()`.
 */
export const STANDING_PERMISSION_AFTER = 3;

/** What each kind of action does, as a sentence goes on after "Nearcited may …". */
export const ACTION_KIND_DOING: Record<ActionKind, string> = {
  sample: "set the opening line of a sample listing",
  wordpress_details: "add or update the business details on your home page",
  wordpress_page: "publish pages on your WordPress site",
  hosted_page: "publish pages on your answer subdomain",
};
