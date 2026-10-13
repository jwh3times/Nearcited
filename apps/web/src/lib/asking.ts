import { type Asking, type Location, siteName, type Task } from "@nearcited/shared";
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

/**
 * How the code is drawn, wherever it is drawn: on the task, on the card and in the picture to
 * download.
 */
export const CODE = {
  /** How much of a code may be lost to a crease or a smudge and still be read: about a seventh. */
  level: "M",
  /** The clear space a reader needs round a code, counted in the code's own squares. */
  margin: 4,
  /** Black on white whatever the theme: a reader may not manage a light code on a dark ground. */
  dark: "#000000",
  light: "#ffffff",
  /** How many pixels across the picture to download is, before the screen's own scale. */
  picture: 1024,
} as const;

/** What stands round the code, to the owner. */
export const CODE_WORDS = {
  about:
    "The same link as a QR code. A customer points their phone's camera at it and the link opens.",
  print: "Print a card",
  download: "Download the code",
  /** What the card page says above the card. */
  card: "Print the card, cut it out, and hand one to every customer or leave it where they pay. Offer nothing in return for a review.",
  /** What the card page says where there is no link to make a card from. */
  none: "There is no card to print for this site. A card is made from the link a review task keeps, so give the task its link first.",
} as const;

/** What a screen reader says the code is. */
export const codeTitle = (link: string) => `QR code that opens ${link}`;

/** The address of the page with the card for `site`, inside the account being shown. */
export function cardPath(base: string, locationId: string, site: string): string {
  return `${base}/locations/${locationId}/review-card/${encodeURIComponent(site)}`;
}

/**
 * What the card for `site` is made from: the same as the request on that site's task. Null where
 * no task of the location holds a link for the site, which is where the task offers no card.
 */
export function cardFor(
  tasks: readonly Pick<Task, "listing">[],
  location: Pick<Location, "name">,
  site: string,
): Asking | null {
  const task = tasks.find((candidate) => candidate.listing?.site === site);
  return task ? asking(task, location) : null;
}

/** The name the picture of the code is saved under: "joes-pizza-google-review-code.png". */
export function codeFileName({ business, site }: Pick<Asking, "business" | "site">): string {
  const words = `${business} ${siteName(site)}`
    .normalize("NFKD")
    // The marks a letter was written with, and the apostrophe in a name like Joe's.
    .replace(/[\u0300-\u036f'’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${words}-review-code.png`;
}
