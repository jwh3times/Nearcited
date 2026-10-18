import {
  formatPhone,
  isGoogle,
  type Location,
  type LocationFormValues,
  needsPoint,
  type QueryKind,
  type Surface,
  type TrackedQuery,
} from "@nearcited/shared";

/** A location as the edit form starts: every field a user may set, blank where none is on file. */
export function locationFormValues(location: Location): Required<LocationFormValues> {
  return {
    name: location.name,
    website: location.website ?? "",
    // Stored with its country code; shown the way it is written in the location's country.
    phone: formatPhone(location.phone ?? "", location.country_code),
    address_line: location.address_line ?? "",
    city: location.city,
    region: location.region ?? "",
    postal_code: location.postal_code ?? "",
    country_code: location.country_code,
    google_place_id: location.google_place_id ?? "",
    primary_category: location.primary_category ?? "",
    what_we_do: location.what_we_do ?? "",
  };
}

/**
 * Where the location's Google results are checked from, in a sentence for its page. The point is
 * found by the worker before a scan's Google checks, so a changed address is checked from the
 * next scan, and it is fixed by fixing the address.
 */
export function googlePointLine(location: Location): string {
  const street = location.address_line?.trim();
  const city = location.city;
  const unplaced = !needsPoint(location) && location.latitude === null;
  if (!street && unplaced) {
    return `${city} couldn't be found on the map, so Google results aren't checked. Check the city.`;
  }
  if (!street) {
    return `Google results are checked from the middle of ${city}. Add the street address to check them from your door.`;
  }
  if (needsPoint(location)) {
    return `Google results will be checked from ${street}, ${city}, from the next scan.`;
  }
  if (location.point_source === "address") {
    return `Google results are checked from ${street}, ${city}.`;
  }
  if (location.point_source === "city") {
    return `${street} couldn't be found on the map, so Google results are checked from the middle of ${city}. Check the street address.`;
  }
  return `Neither ${street} nor ${city} could be found on the map, so Google results aren't checked. Check the address.`;
}

/**
 * The kind the form to add a prompt or keyword starts on: a Google keyword where Google is
 * checked and the location has prompts but no keyword yet, and otherwise a prompt, which is
 * where a new location starts.
 */
export function startingKind(
  surfaces: readonly Surface[],
  queries: readonly Pick<TrackedQuery, "kind" | "is_active">[],
): QueryKind {
  return wantsGoogleKeyword(surfaces, queries) && queries.some((query) => query.is_active)
    ? "search_keyword"
    : "ai_prompt";
}

/** True where Google is checked and the location tracks no Google keyword to check it with. */
export function wantsGoogleKeyword(
  surfaces: readonly Surface[],
  queries: readonly Pick<TrackedQuery, "kind" | "is_active">[],
): boolean {
  return (
    surfaces.some(isGoogle) &&
    !queries.some((query) => query.is_active && query.kind === "search_keyword")
  );
}
