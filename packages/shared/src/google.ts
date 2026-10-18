import type { Location, Organization, Surface } from "./schemas";

/**
 * Google results: what a Google keyword shows on Google's map pack, its organic results, its AI
 * Overview and AI Mode, bought from a data vendor and checked from the location's own point
 * (issue #219, `docs/adr/0023-google-results-are-bought-and-checked-from-one-point.md`).
 */

/** The allowance that says a plan includes Google results. A key of `ALLOWANCE_KINDS`. */
export const GOOGLE_RESULTS_ALLOWANCE = "google_results";

/** The surfaces a Google keyword is checked on, which the allowance covers. */
export const GOOGLE_SURFACES = [
  "google_local_pack",
  "google_organic",
  "google_ai_overview",
  "google_ai_mode",
] as const satisfies readonly Surface[];

/**
 * The surfaces an organization's scans may check: the assistants it is checked on, and the
 * Google surfaces where its allowances include Google results. Null means every surface that is
 * set up, as for an organization with no plan.
 */
export function coveredSurfaces(
  organization: Pick<Organization, "surfaces" | "allowances">,
): Surface[] | null {
  if (organization.surfaces === null) return null;
  const google = GOOGLE_RESULTS_ALLOWANCE in organization.allowances ? GOOGLE_SURFACES : [];
  return [...organization.surfaces.filter((surface) => !isGoogle(surface)), ...google];
}

/** True for a surface of Google's own. */
export function isGoogle(surface: Surface): boolean {
  return (GOOGLE_SURFACES as readonly Surface[]).includes(surface);
}

type Where = Pick<Location, "address_line" | "city" | "region" | "postal_code" | "country_code">;

/** What is looked up to find a location's point, and whether it is a street address or a city. */
export interface PointQuery {
  query: string;
  source: "address" | "city";
}

/** The street address when the location has one, and its city when it has none. */
export function pointQuery(location: Where): PointQuery {
  const street = location.address_line?.trim();
  const region = location.region?.trim();
  const town = [location.city.trim(), region].filter(Boolean).join(", ");
  if (street) {
    const postal = location.postal_code?.trim();
    return {
      query: `${street}, ${postal ? `${town} ${postal}` : town}, ${location.country_code}`,
      source: "address",
    };
  }
  return { query: `${town}, ${location.country_code}`, source: "city" };
}

/** True when the location's point was not found from what it holds now. */
export function needsPoint(location: Where & Pick<Location, "geocoded_from">): boolean {
  return location.geocoded_from !== pointQuery(location).query;
}
