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
 */

/** The most a listing's address may run to. The database holds to the same number. */
export const LISTING_URL_MAX = 500;

/**
 * Google's review form is reached by the place ID a location already holds, so no listing is
 * kept for it.
 */
const BY_PLACE_ID = "google.com";

/**
 * The site a task for `host` asks for a listing on, as the list of known sites names it, or null
 * when it asks for none. Only a site that lets a business ask its customers for reviews: nobody
 * is handed a link to send customers to one that forbids it, or to one whose rules are not known.
 */
export function listingSite(host: string): string | null {
  const site = listedSite(host);
  if (site === null || site === BY_PLACE_ID) return null;
  return sourceKind(site) === "reviews" ? site : null;
}

/** An address as it is kept, or the sentence that says why it was not taken. */
export type ReadListing = { url: string } | { problem: string };

/**
 * Reads what a member pasted as the business's listing on `site`. It is kept as the address a
 * browser would follow, without the part after `#`, which names a place on the page.
 */
export function readListing(site: string, pasted: string): ReadListing {
  const whole = { problem: "Paste the whole address of your listing, starting with https://." };
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
  if (address.hostname !== site && !address.hostname.endsWith(`.${site}`)) {
    return { problem: `That address is not on ${site}. Paste the address of your own page there.` };
  }
  if (address.pathname.replace(/\/+$/, "") === "" && address.search === "") {
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
 * What a task for `host` holds of the business's listing there. Null when the task asks for
 * none.
 */
export function taskListing(host: string, listings: readonly Listing[]): TaskListing | null {
  const site = listingSite(host);
  if (site === null) return null;
  return { site, url: listings.find((listing) => listing.site === site)?.url ?? null };
}
