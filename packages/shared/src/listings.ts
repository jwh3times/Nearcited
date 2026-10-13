import type { Listing, TaskListing } from "./schemas";
import { listedSite, sourceKind } from "./source-kinds";

/**
 * Listings: where a business is on a site, as its owner gave it (issue #127).
 *
 * A task for a review site hands over the page an assistant read, which is often a list or
 * somebody else's page. A listing is the business's own page there, which is what a customer has
 * to be sent to. A member pastes its address once and it is kept for the location and the site.
 *
 * The product never looks for a listing and never opens one. All that is checked of an address
 * is its shape: that it is a link over https, to that site, and to a page of it.
 *
 * Google is asked for a different thing. See `asksForReviewLink`.
 */

/** The most a listing's address may run to. The database holds to the same number. */
export const LISTING_URL_MAX = 500;

/**
 * Google gives a business the link to its own review form, so that link is what a member is
 * asked for there, in place of the address of a page. It is kept as a listing is, nothing is
 * made from it, and it is what a customer is sent.
 *
 * Google's help says where a business copies it, and those are the steps an owner is shown
 * (support.google.com/business/answer/16816815, read on 2026-10-13): go to the Business Profile,
 * select Read Reviews and then Get more reviews, and select Copy. The address is not built from
 * the place ID a location holds: see `REVIEW_FORMS`.
 */
const GIVES_ITS_LINK = "google.com";

/** True when what `site` is asked for is the link it gives a business to ask for reviews with. */
export function asksForReviewLink(site: string): boolean {
  return site === GIVES_ITS_LINK;
}

/** What is said of an address on Google that is not that link. It says where the link is. */
const NOT_THE_LINK =
  "That does not look like the review link Google gives you. On your Business Profile, choose Read Reviews, then Get more reviews, and copy the link shown there.";

/**
 * Whether an address on Google's names is one a customer could be sent.
 *
 * Google's help does not show what the link looks like. Every account of it that could be found
 * puts it on g.page, so that name is taken as well as google.com. Two addresses are turned
 * away, because they are what an owner who copies the top of the browser is holding, and a
 * customer can do nothing with either: the search a profile is managed from, and the pages only
 * its owner can open.
 */
function fromGoogle(address: URL): boolean {
  const on = (name: string) => address.hostname === name || address.hostname.endsWith(`.${name}`);
  if (on("g.page")) return true;
  if (!on("google.com") || on("business.google.com")) return false;
  return !/^\/search\/?$/.test(address.pathname);
}

/**
 * The site a task for `host` asks for a listing on, as the list of known sites names it, or null
 * when it asks for none. Only a site that lets a business ask its customers for reviews: nobody
 * is handed a link to send customers to one that forbids it, or to one whose rules are not known.
 */
export function listingSite(host: string): string | null {
  const site = listedSite(host);
  return site !== null && sourceKind(site) === "reviews" ? site : null;
}

/** An address as it is kept, or the sentence that says why it was not taken. */
export type ReadListing = { url: string } | { problem: string };

/**
 * Reads what a member pasted as the business's listing on `site`, or on Google as the review
 * link it gave. It is kept as the address a browser would follow, without the part after `#`,
 * which names a place on the page.
 */
export function readListing(site: string, pasted: string): ReadListing {
  const link = asksForReviewLink(site);
  const whole = {
    problem: link
      ? "Paste the whole link, starting with https://."
      : "Paste the whole address of your listing, starting with https://.",
  };
  const text = pasted.trim();
  let address: URL;
  try {
    // An address copied without its start is taken as the one a browser would open.
    address = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return whole;
  }
  if (address.protocol === "http:") address.protocol = "https:";
  if (address.protocol !== "https:" || address.username !== "" || address.password !== "") {
    return whole;
  }
  const front = address.pathname.replace(/\/+$/, "") === "" && address.search === "";
  if (link) {
    if (front || !fromGoogle(address)) return { problem: NOT_THE_LINK };
  } else if (address.hostname !== site && !address.hostname.endsWith(`.${site}`)) {
    return { problem: `That address is not on ${site}. Paste the address of your own page there.` };
  } else if (front) {
    return {
      problem: `That is the front page of ${site}. Paste the address of your own page there.`,
    };
  }
  address.hash = "";
  if (address.href.length > LISTING_URL_MAX) {
    return { problem: `Paste an address of ${LISTING_URL_MAX} characters or fewer.` };
  }
  return { url: address.href };
}

/**
 * Where a customer writes a review, for the sites whose form address is known, made from the
 * address of a business's listing there.
 *
 * A site is here only when its own pages showed the address. One that was guessed would send a
 * business's customers to a page that is not there, so a site that is not here gets no form
 * address: its task shows the listing, and the customer finds the way to the form from it. Each
 * entry says what was read and when. A listing whose address is not of the shape that was read
 * gets none either.
 *
 * google.com is left out on purpose: what a member gives there is already the link to the form
 * (`asksForReviewLink`), so there is nothing to make. Nor is one built from the place ID a
 * location holds. The address in common use for that,
 * search.google.com/local/writereview?placeid=<place ID>, answered on 2026-10-13 by asking for a
 * sign-in, and no page of Google's that could be read says it is the form's address: its help
 * says to copy the link from the Business Profile.
 */
const REVIEW_FORMS: Record<string, (listing: URL) => string | null> = {
  // Read on 2026-10-13. A profile's address with /leave-a-review after it is a page titled
  // "Leave a review for <business> | BBB", and bbb.org's advice to businesses
  // (bbb.org/all/customer-reviews/value-of-reviews) is to link to the profile or to the Leave a
  // Review page. The profile read was in the United States:
  // /us/<state>/<city>/profile/<category>/<name and number>.
  "bbb.org": (listing) => {
    const profile = /^\/us\/[a-z]{2}\/[^/]+\/profile\/[^/]+\/[^/]+/.exec(listing.pathname);
    return profile ? `${listing.origin}${profile[0]}/leave-a-review` : null;
  },
  // Read on 2026-10-13. A company's page is /review/<name>, and /evaluate/<name> is a page
  // headed "Rate <company>".
  "trustpilot.com": (listing) => {
    const company = /^\/(?:review|evaluate)\/([^/]+)\/?$/.exec(listing.pathname);
    return company ? `${listing.origin}/evaluate/${company[1]}` : null;
  },
};

/**
 * Where a customer writes a review of the business whose listing on `site` is at `listing`.
 * Null where the site's form address is not known, or cannot be made from this listing.
 */
export function reviewForm(site: string, listing: string): string | null {
  const form = Object.hasOwn(REVIEW_FORMS, site) ? REVIEW_FORMS[site] : undefined;
  if (!form) return null;
  try {
    return form(new URL(listing));
  } catch {
    return null;
  }
}

/**
 * What a task for `host` holds of the business's listing there. Null when the task asks for
 * none.
 */
export function taskListing(host: string, listings: readonly Listing[]): TaskListing | null {
  const site = listingSite(host);
  if (site === null) return null;
  const url = listings.find((listing) => listing.site === site)?.url ?? null;
  return { site, url, review_url: url === null ? null : reviewForm(site, url) };
}
