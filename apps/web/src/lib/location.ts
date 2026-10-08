import type { Location, LocationFormValues } from "@nearcited/shared";

/** A location as the edit form starts: every field a user may set, blank where none is on file. */
export function locationFormValues(location: Location): Required<LocationFormValues> {
  return {
    name: location.name,
    website: location.website ?? "",
    phone: location.phone ?? "",
    address_line: location.address_line ?? "",
    city: location.city,
    region: location.region ?? "",
    postal_code: location.postal_code ?? "",
    country_code: location.country_code,
    google_place_id: location.google_place_id ?? "",
    primary_category: location.primary_category ?? "",
    scan_frequency: location.scan_frequency,
  };
}
