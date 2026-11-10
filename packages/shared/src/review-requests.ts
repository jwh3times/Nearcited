import { requestToSend, siteName } from "./asking";
import { ZONE_DOMAIN } from "./hosted-pages";
import { asksForReviewLink, listingSite, reviewForm } from "./listings";
import type { Listing, ReviewSite, SourceSummary } from "./schemas";
import { listedSite } from "./source-kinds";

/**
 * Review requests: the product asks a location's customers for a review by email, once, from the
 * receipts its owner copies to the location's receipt address (issue #146,
 * `docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md`,
 * `docs/adr/0031-a-customer-contact-is-read-only-by-the-worker.md`).
 *
 * An owner or admin turns them on for one location, which sets the receipt address, the site to
 * ask for, the address replies go to, and approves the wording, which is composed by rule and not
 * edited. Everything here is composed by rule, and no model writes any of it.
 */

/** The allowance a plan includes review requests with. A key of `ALLOWANCE_KINDS`. */
export const REVIEW_REQUESTS_ALLOWANCE = "review_requests";

/**
 * A receipt address, `receipts+<name>@nearcited.com`: a subaddress of the one mailbox receipts
 * arrive at, `receipts@nearcited.com`. Cloudflare Email Routing has no catch-all for a subdomain,
 * so one rule sends that mailbox to the Worker and its subaddressing matches every `+<name>` to
 * the rule (`docs/adr/0032-receipts-arrive-as-subaddresses-of-one-mailbox.md`). The name is the 32
 * lowercase hex characters the database keeps.
 */
const RECEIPT_ADDRESS = new RegExp(
  `^receipts\\+([0-9a-f]{32})@${ZONE_DOMAIN.replaceAll(".", "\\.")}$`,
);

/** A receipt address as it is written, from the name the database keeps for it. */
export function receiptAddress(name: string): string {
  return `receipts+${name}@${ZONE_DOMAIN}`;
}

/**
 * The name the database keeps for a receipt address, read back from the address a message was
 * sent to, or null for an address in any other form, which is nobody's.
 */
export function receiptName(address: string): string | null {
  return RECEIPT_ADDRESS.exec(address.trim().toLowerCase())?.[1] ?? null;
}

/**
 * The kinds of business whose list of customers is confidential, by a word or two their category
 * would carry. Turning review requests on is refused for any of them: a clinic, a law firm or a
 * financial adviser gets no customer sync (ADR 0011). The database holds the same list in
 * `is_confidential_category()`, and a test holds the two together.
 */
export const CONFIDENTIAL_KINDS = [
  // Medical and dental.
  "medical",
  "medicine",
  "doctor",
  "physician",
  "clinic",
  "hospital",
  "health care",
  "healthcare",
  "urgent care",
  "nurse",
  "nursing",
  "pharmacy",
  "pharmacist",
  "surgeon",
  "surgery",
  "pediatrician",
  "pediatric",
  "dermatologist",
  "cardiologist",
  "gynecologist",
  "obstetrician",
  "fertility",
  "optometrist",
  "ophthalmologist",
  "chiropractor",
  "chiropractic",
  "physiotherapist",
  "physiotherapy",
  "physical therapist",
  "physical therapy",
  "dentist",
  "dental",
  "orthodontist",
  "orthodontic",
  "endodontist",
  "periodontist",
  // Mental health.
  "mental health",
  "therapist",
  "therapy",
  "psychotherapist",
  "psychotherapy",
  "psychiatrist",
  "psychiatric",
  "psychologist",
  "psychology",
  "counselor",
  "counsellor",
  "counseling",
  "counselling",
  "rehab",
  "rehabilitation",
  "addiction",
  // Legal.
  "legal",
  "lawyer",
  "attorney",
  "law firm",
  "law office",
  "solicitor",
  // Financial advice.
  "financial advisor",
  "financial adviser",
  "financial advisory",
  "financial planner",
  "financial planning",
  "wealth management",
  "investment advisor",
  "investment adviser",
  "accountant",
  "accounting",
  "tax preparation",
] as const;

/**
 * A whole word or phrase of the list, in any case, and as a plural. It errs toward refusing: a
 * massage therapist, a veterinary clinic or a tree surgeon is refused too, which costs a business
 * a convenience, where letting a confidential list through would cost its customers their privacy.
 */
const CONFIDENTIAL = new RegExp(`\\b(?:${CONFIDENTIAL_KINDS.join("|")})s?\\b`, "i");

/** True when a location's category says its list of customers is confidential. */
export function isConfidentialCategory(category: string | null): boolean {
  return category !== null && CONFIDENTIAL.test(category);
}

/**
 * The link a customer is sent for a listing: on Google the review link the owner gave, and on a
 * site whose form address is known, the form. Null where there is no form to send anyone to.
 */
function askingLink(listing: Pick<Listing, "site" | "url">): string | null {
  if (listingSite(listing.site) !== listing.site) return null;
  return asksForReviewLink(listing.site) ? listing.url : reviewForm(listing.site, listing.url);
}

/**
 * The sites a location's review requests may ask for: a review site that lets a business ask,
 * where the location has a listing with a review form. The one the answers cited most comes
 * first, and is what is chosen unless an owner chooses another; sites cited alike go by name.
 */
export function qualifyingSites(
  listings: readonly Listing[],
  sources: readonly SourceSummary[],
): ReviewSite[] {
  const citations = (site: string) =>
    sources
      .filter((source) => listedSite(source.host) === site)
      .reduce((sum, source) => sum + source.answers, 0);
  return listings
    .flatMap((listing) => {
      const link = askingLink(listing);
      return link === null
        ? []
        : [
            {
              site: listing.site,
              name: siteName(listing.site),
              link,
              cited: citations(listing.site),
            },
          ];
    })
    .sort((a, b) => b.cited - a.cited || a.site.localeCompare(b.site));
}

/** What a review request email is made from. */
export interface ReviewRequestFor {
  /** The business's name, as its location holds it. */
  business: string;
  /** The site the review is asked for on, as the list of known sites names it. */
  site: string;
  /** The review form the customer is sent to. */
  link: string;
  /** Where one click opts the customer out. */
  optOut: string;
}

/** A review request as it is sent: from the business by name, with its subject and its text. */
export interface ReviewRequestEmail {
  sender: string;
  subject: string;
  body: string;
}

/** A name as it is written out: without the spaces round it, and with one between its words. */
const tidied = (name: string): string => name.trim().replace(/\s+/g, " ");

/**
 * The email a customer is sent: the request an owner would send themselves (`requestToSend`), then
 * a line saying who sends it for the business and where a reply goes, then the way to hear no
 * more. An owner or admin reads it once and approves it as it stands: nobody edits it.
 */
export function reviewRequestEmail({
  business,
  site,
  link,
  optOut,
}: ReviewRequestFor): ReviewRequestEmail {
  const name = tidied(business);
  return {
    sender: name,
    subject: `Would you review ${name} on ${siteName(site)}?`,
    body: [
      requestToSend({ business: name, site, link }),
      "",
      `Nearcited sends this email for ${name}. If you reply, your reply goes to ${name}.`,
      "",
      `To get no more emails like this from ${name}: ${optOut}`,
    ].join("\n"),
  };
}

/** What a member is shown in place of the link to opt out, which each email has its own of. */
export const OPT_OUT_SHOWN = "[a link to opt out, which works with one click]";

/**
 * What a member is shown in place of the link to the review form. Each email has its own, through
 * the product, which asks "How did you find us?" on the way
 * (`docs/adr/0033-a-found-answer-is-counted-on-the-way-to-the-review-form.md`).
 */
export const REVIEW_FORM_SHOWN =
  '[a link to the review form, asking "How did you find us?" on the way]';

/** The email a location's customers are sent, as approved, and the review form it leads to. */
export interface ApprovedWording extends ReviewRequestEmail {
  /** The review form each customer's own link leads to. */
  form: string;
}

/**
 * The email a location's customers are sent, as its owner approved it and a member approves each
 * request: with `REVIEW_FORM_SHOWN` and `OPT_OUT_SHOWN` where each customer's own links go. Null
 * where the location has no review form on the site chosen, so there is nothing to ask for.
 */
export function approvedWording(
  business: string,
  site: string,
  listings: readonly Pick<Listing, "site" | "url">[],
): ApprovedWording | null {
  const listing = listings.find((candidate) => candidate.site === site);
  const form = listing ? askingLink(listing) : null;
  if (form === null) return null;
  const email = reviewRequestEmail({
    business,
    site,
    link: REVIEW_FORM_SHOWN,
    optOut: OPT_OUT_SHOWN,
  });
  return { ...email, form };
}

/**
 * The email one customer is sent: the approved wording with their own link to the review form and
 * to opt out where the member was shown `REVIEW_FORM_SHOWN` and `OPT_OUT_SHOWN`.
 */
export const withLinks = (wording: string, links: { form: string; optOut: string }): string =>
  wording.replace(REVIEW_FORM_SHOWN, links.form).replace(OPT_OUT_SHOWN, links.optOut);
