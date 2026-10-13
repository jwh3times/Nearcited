import type { Task } from "@nearcited/shared";

/**
 * What a task shows of the business's listing on its site:
 *
 *   nothing  the task asks for none, or none was given and the reader may only read
 *   ask      the field to paste its address into
 *   kept     the listing, to copy and send to customers
 */
export type ListingView = "nothing" | "ask" | "kept";

export function listingView(task: Pick<Task, "listing">, readOnly: boolean): ListingView {
  if (!task.listing) return "nothing";
  if (task.listing.url) return "kept";
  return readOnly ? "nothing" : "ask";
}
