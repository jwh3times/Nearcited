import {
  type Location,
  OPT_OUT_SHOWN,
  type ReviewRequestEmail,
  type ReviewRequestsBar,
  type ReviewSite,
  reviewRequestEmail,
} from "@nearcited/shared";

/** Where a location's review requests are kept in the page's cache. */
export const reviewRequestsKey = (locationId: string) => ["review-requests", locationId];

/** What the card says, kept together so the tests and the page agree. */
export const REVIEW_WORDS = {
  title: "Review requests",
  about:
    "Nearcited can ask each of your customers for a review by email, once, the morning after the job. It learns who they are from the receipts or invoices your own tool already sends: you add one address of this location's as a copy on them.",
  confirm: "My customer list is not confidential, and my customers expect to hear from me.",
  site: "Site to ask for",
  siteHint: "The one your answers cited most is chosen to start with.",
  replyTo: "Replies go to",
  replyHint: "A customer who replies to the request writes to this address.",
  wording: "What each customer is sent",
  wordingNote:
    "The wording is written for you from the business's name and the site, and is sent as it stands: it asks every customer alike, for whatever they thought, and offers nothing in return.",
  turnOn: "Approve the wording and turn on",
  turningOn: "Turning on",
  onlyManagers: "Only your organization's owner or an admin can turn review requests on.",
  receipt:
    "Add this address as a copy (CC or BCC) on the receipts or invoices your own tool sends:",
  copyAddress: "Copy the address",
  newAddress: "Make a new address",
  newAddressNote: "The old address stops working at once, so change it in your own tool too.",
  turnOff: "Turn off",
  turnOffAsk: "Turn off review requests for this location? Its receipt address stops working.",
  turningOff: "Being turned off.",
  paused: "Your plan no longer includes review requests, so nothing is sent.",
  turnedOn: (by: string | null, day: string) =>
    `Turned on${by ? ` by ${by}` : ""} on ${day}, approving this wording.`,
} as const;

/** Why review requests cannot be turned on, as the card says it. */
export function barNote(bar: ReviewRequestsBar): string {
  switch (bar) {
    case "not_included":
      return "Your plan does not include review requests.";
    case "no_time_zone":
      return "Set this location's time zone above first: a request is sent at a time of its day.";
    case "confidential":
      return "Review requests are not offered to a business whose list of customers is confidential, such as a clinic, a law firm or a financial adviser.";
    case "no_site":
      return "Add this location's listing on Google, BBB or Trustpilot first, from a review task, so there is a review form to send customers to.";
  }
}

/** The email a customer would be sent for `site`, as an owner reads it before approving it. */
export function wordingFor(
  location: Pick<Location, "name">,
  site: Pick<ReviewSite, "site" | "link">,
): ReviewRequestEmail {
  return reviewRequestEmail({
    business: location.name,
    site: site.site,
    link: site.link,
    optOut: OPT_OUT_SHOWN,
  });
}
