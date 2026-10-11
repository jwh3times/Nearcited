import type { SourceKind } from "./schemas";

/**
 * Well-known sites by kind (`docs/adr/0010-the-product-drafts-and-the-owner-acts.md`).
 *
 * The kind decides what a task asks of an owner, so a site goes on this list only when its rules
 * are known. `reviews` is for a platform that lets a business ask its customers for reviews;
 * putting one there that forbids it would have the product tell owners to break its terms. A
 * site that is not here is `unknown`, and nobody is told to ask for reviews on it.
 *
 * A subdomain takes its parent's kind unless it is listed itself.
 */
const KINDS: Record<Exclude<SourceKind, "unknown">, readonly string[]> = {
  reviews: [
    "angi.com",
    "avvo.com",
    "bbb.org",
    "capterra.com",
    "clutch.co",
    "facebook.com",
    "g2.com",
    "goodfirms.co",
    "google.com",
    "homeadvisor.com",
    "houzz.com",
    "thumbtack.com",
    "tripadvisor.com",
    "trustpilot.com",
    "upcity.com",
    "zillow.com",
  ],
  reviews_unasked: ["yelp.com"],
  directory: [
    "bing.com",
    "chamberofcommerce.com",
    "foursquare.com",
    "homes.com",
    "linkedin.com",
    "manta.com",
    "mapquest.com",
    "nextdoor.com",
    "realtor.com",
    "superpages.com",
    "yellowpages.com",
  ],
  editorial: ["usnews.com"],
};

const BY_HOST = new Map<string, SourceKind>(
  Object.entries(KINDS).flatMap(([kind, hosts]) =>
    hosts.map((host) => [host, kind as SourceKind] as const),
  ),
);

/** The kind of the site at `host`, by its own name first and then each parent's. */
export function sourceKind(host: string): SourceKind {
  const labels = host.toLowerCase().split(".");
  for (let start = 0; start < labels.length - 1; start += 1) {
    const kind = BY_HOST.get(labels.slice(start).join("."));
    if (kind) return kind;
  }
  return "unknown";
}
