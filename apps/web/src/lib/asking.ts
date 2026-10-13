import type { Asking, Location, Task } from "@nearcited/shared";
import { sentLink } from "./listings";

/**
 * What a task hands its owner to ask customers with is made from, or null where it hands over
 * nothing: a task that asks for no listing, which is every task for a site that forbids asking or
 * whose kind is not known, and one whose listing nobody has given yet.
 */
export function asking(
  task: Pick<Task, "listing">,
  location: Pick<Location, "name">,
): Asking | null {
  if (!task.listing) return null;
  const link = sentLink(task.listing);
  return link === null ? null : { business: location.name, site: task.listing.site, link };
}

/** What stands round the request, to the owner. The request itself is the shared rule's. */
export const REQUEST_WORDS = {
  about: "A request to send your customers, by text or by email:",
  /** The two things a site that lets a business ask holds it to. */
  terms:
    "Send it yourself, to every customer and not only the happy ones, and offer nothing in return.",
  copy: "Copy the request",
} as const;
