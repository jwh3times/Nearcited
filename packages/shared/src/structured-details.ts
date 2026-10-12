import type { Location, SiteCheck } from "./schemas";

/**
 * Structured business details: the block an owner pastes into their page so that it states who
 * and where the business is in a form a crawler reads without guessing (issue #137).
 *
 * It is composed by rule from what the location holds, and carries no fact nobody gave: a
 * detail that is not on file is left out, never filled in. No model writes any of it. It
 * promises nothing, since the published evidence that such a block changes what an assistant
 * answers is weak. It is the fix for the on-page check that looks for one.
 */

/** The details of a location the block is built from. */
export type BlockLocation = Pick<
  Location,
  "name" | "website" | "phone" | "address_line" | "city" | "region" | "postal_code" | "country_code"
>;

/** The details a location may not hold, which the block carries only when it does. */
export const BLOCK_EXTRAS = ["address_line", "postal_code", "phone"] as const;
export type BlockExtra = (typeof BLOCK_EXTRAS)[number];

/** What each of them is called on the page. */
export const BLOCK_EXTRA_LABELS: Record<BlockExtra, string> = {
  address_line: "street address",
  postal_code: "postal code",
  phone: "phone number",
};

export interface BusinessBlock {
  /** What the block states, as schema.org JSON-LD. */
  data: Record<string, unknown>;
  /** The block as it is pasted into a page: the script element and all. */
  html: string;
  /** The details not on file, which the block would carry if they were. */
  missing: BlockExtra[];
}

/** A copy of `fields` without the ones nothing is held for. */
function held(fields: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string] => !!entry[1]),
  );
}

/**
 * The block for a location. Every location has a name, a city and a country, so there is always
 * something to state. `LocalBusiness` is the type for all of them: a location's category is
 * typed freely, and a narrower type guessed from it would state something nobody said.
 */
export function buildBusinessBlock(location: BlockLocation): BusinessBlock {
  const data = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    ...held({ name: location.name, url: location.website, telephone: location.phone }),
    address: {
      "@type": "PostalAddress",
      ...held({
        streetAddress: location.address_line,
        addressLocality: location.city,
        addressRegion: location.region,
        postalCode: location.postal_code,
        addressCountry: location.country_code,
      }),
    },
  };
  // The block sits inside a script element, which ends at the first "</script" whatever the
  // JSON around it says. No detail can close it once every "<" is written as its escape.
  const json = JSON.stringify(data, null, 2).replaceAll("<", "\\u003c");
  return {
    data,
    html: `<script type="application/ld+json">\n${json}\n</script>`,
    missing: BLOCK_EXTRAS.filter((extra) => !location[extra]),
  };
}

/**
 * Whether the block is the fix for something the on-page check found: the page was read, and no
 * structured business details were on it. A page that could not be read is offered nothing,
 * because nothing is known about it.
 */
export function needsBusinessBlock(site: SiteCheck | null): boolean {
  return site?.checks.some((check) => check.id === "structured_data" && !check.passed) ?? false;
}
