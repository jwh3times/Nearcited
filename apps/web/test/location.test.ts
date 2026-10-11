import { type Location, LocationInputSchema } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import { locationFormValues } from "../src/lib/location";

const location: Location = {
  id: "c0000000-0000-4000-8000-000000000003",
  organization_id: "d0000000-0000-4000-8000-000000000004",
  name: "Joe's Pizza",
  website: "https://joes.example",
  phone: null,
  address_line: "12 Fayetteville St",
  city: "Raleigh",
  region: null,
  postal_code: "27601",
  country_code: "US",
  google_place_id: null,
  primary_category: "Pizza restaurant",
  paused_by_plan: false,
  last_scanned_at: "2026-10-07T09:00:00.000Z",
  created_at: "2026-10-04T00:00:00.000Z",
};

describe("locationFormValues", () => {
  it("fills the edit form with everything a user may set, blank where nothing is on file", () => {
    expect(locationFormValues(location)).toEqual({
      name: "Joe's Pizza",
      website: "https://joes.example",
      phone: "",
      address_line: "12 Fayetteville St",
      city: "Raleigh",
      region: "",
      postal_code: "27601",
      country_code: "US",
      google_place_id: "",
      primary_category: "Pizza restaurant",
    });
  });

  it("shows a stored phone number the way it is written, and saves it back as it was", () => {
    const withPhone = { ...location, phone: "+19195550100" };
    expect(locationFormValues(withPhone).phone).toBe("(919) 555-0100");
    expect(LocationInputSchema.parse(locationFormValues(withPhone)).phone).toBe("+19195550100");
  });

  it("saves back unchanged as the location it was read from", () => {
    expect({ ...location, ...LocationInputSchema.parse(locationFormValues(location)) }).toEqual(
      location,
    );
  });
});
