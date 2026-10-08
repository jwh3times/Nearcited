import { formatPhone, type Location, type LocationFormValues } from "@nearcited/shared";

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
    scan_frequency: location.scan_frequency,
  };
}
