import { asksForReviewLink, type Task, type TaskListing } from "@nearcited/shared";

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

/** Where an owner finds what a task asks for, for a site whose own help says. */
export interface Finding {
  /** What the thing is, for an owner who has not heard of it. */
  about: string;
  steps: readonly string[];
  /** The site's own page with the same steps. */
  help: { label: string; href: string };
}

/** The words a task asks for a site's listing in. */
export interface AskWords {
  label: string;
  placeholder: string;
  hint: string;
  save: string;
  finding: Finding | null;
}

/**
 * Google's own steps to the link it gives a business to ask for reviews with
 * (support.google.com/business/answer/16816815, read on 2026-10-13). The names of what to choose
 * are Google's. An owner is not assumed to know the link exists.
 */
const FROM_GOOGLE: Finding = {
  about:
    "Google gives every business a link that opens its review form. You copy it from your Business Profile:",
  steps: [
    "Sign in to Google with the account that manages your business, and go to business.google.com.",
    "On your Business Profile, choose Read Reviews, then Get more reviews.",
    "Choose Copy beside the link Google shows, and paste it below.",
  ],
  help: {
    label: "Google's own steps",
    href: "https://support.google.com/business/answer/16816815",
  },
};

/**
 * How a task asks for what is kept for `site`. Every site but Google is asked for the address of
 * the business's own page there. Google is asked for the review link it gives, and told where
 * that is.
 */
export function askWords(site: string): AskWords {
  if (asksForReviewLink(site)) {
    return {
      label: "Your review link from Google",
      placeholder: "https://g.page/r/...",
      hint: "It is the link you send customers, so they can write a review.",
      save: "Save the link",
      finding: FROM_GOOGLE,
    };
  }
  return {
    label: `Your listing on ${site}`,
    placeholder: `https://www.${site}/...`,
    hint: `Find your business on ${site}, open its page and copy the address from the top of your browser. Paste it here: it is the link you send customers, so they can write a review.`,
    save: "Save the listing",
    finding: null,
  };
}

/** What a task says of the link it hands back, above it. */
export function keptWords(listing: Pick<TaskListing, "site" | "review_url">): string {
  if (asksForReviewLink(listing.site)) {
    return "Your review link from Google. Send customers this link.";
  }
  return listing.review_url
    ? `Where your customers write a review on ${listing.site}. Send them this link.`
    : `Your listing on ${listing.site}. Send customers this link, and they can write a review from that page.`;
}
