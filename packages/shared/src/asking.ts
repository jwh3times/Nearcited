/**
 * What an owner is handed to ask their customers for a review with (issue #128).
 *
 * A task for a review site holds the link a customer is sent. From it a short request is made
 * for the owner to send themselves, from their own address or phone. It is composed by rule,
 * from the business's name, the site's name and the link, and no model writes it. Nothing here
 * sends anything, and nothing about a business's customers is held.
 *
 * The request asks every customer alike and offers nothing in return, which is what a site that
 * lets a business ask for reviews lets it ask for
 * (`docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md`).
 */

/**
 * The name a customer knows each review site by. A customer is asked for a review "on Google",
 * not "on google.com". Every site a task asks for a listing on has one, and a test holds the two
 * lists together.
 */
const SITE_NAMES: Record<string, string> = {
  "angi.com": "Angi",
  "bbb.org": "BBB",
  "capterra.com": "Capterra",
  "g2.com": "G2",
  "google.com": "Google",
  "houzz.com": "Houzz",
  "thumbtack.com": "Thumbtack",
  "tripadvisor.com": "Tripadvisor",
  "trustpilot.com": "Trustpilot",
  "zillow.com": "Zillow",
};

/**
 * What a customer calls `site`, which is the name it is listed under. A site with no name on the
 * table goes by its address, which is never wrong.
 */
export function siteName(site: string): string {
  const name = Object.hasOwn(SITE_NAMES, site) ? SITE_NAMES[site] : undefined;
  return name ?? site;
}

/** What a request is made from. */
export interface Asking {
  /** The business's name, as its location holds it. */
  business: string;
  /** The site the review is asked for on, by the name it is listed under. */
  site: string;
  /** The link a customer is sent: the site's review form, or the business's listing there. */
  link: string;
}

/** A name as it is written out: without the spaces round it, and with one between its words. */
function tidied(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** `sentence` closed with a full stop, unless the name it ends on brought its own: "Joe's Inc." */
function closed(sentence: string): string {
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/**
 * The request an owner sends a customer: short enough for a text and plain enough for an email,
 * with the link on a line of its own so that whatever it is sent with makes it one to tap.
 *
 * It asks for what the customer honestly thought, good or bad. It never asks for a good review,
 * never asks how the visit went before deciding whether to ask, and offers nothing in return.
 */
export function requestToSend({ business, site, link }: Asking): string {
  const thanks = closed(`Thank you for choosing ${tidied(business)}`);
  return `${thanks} Would you leave a review on ${siteName(site)}? Say what you honestly thought, good or bad: it helps other people decide.\n${link}`;
}
