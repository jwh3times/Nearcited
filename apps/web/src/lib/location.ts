import type { Location, LocationFormValues, ScanFrequency } from "@nearcited/shared";

/** How a location's scan frequency reads in the edit form. The plan sets the fastest pace. */
export const SCAN_FREQUENCY_LABELS: Record<ScanFrequency, string> = {
  daily: "As often as the plan allows",
  weekly: "Weekly at most",
  off: "Paused",
};

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
