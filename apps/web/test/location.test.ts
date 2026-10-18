import { type Location, LocationInputSchema } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import {
  googlePointLine,
  locationFormValues,
  startingKind,
  wantsGoogleKeyword,
} from "../src/lib/location";

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
  latitude: null,
  longitude: null,
  point_source: null,
  geocoded_from: null,
  primary_category: "Pizza restaurant",
  what_we_do: null,
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
      what_we_do: "",
    });
  });

  it("shows a stored phone number the way it is written, and saves it back as it was", () => {
    const withPhone = { ...location, phone: "+19195550100" };
    expect(locationFormValues(withPhone).phone).toBe("(919) 555-0100");
    expect(LocationInputSchema.parse(locationFormValues(withPhone)).phone).toBe("+19195550100");
  });

  it("carries what the business says it does, so saving the form keeps it", () => {
    const said = { ...location, what_we_do: "Wood-fired pizza, family-run since 1998." };
    expect(locationFormValues(said).what_we_do).toBe(said.what_we_do);
    expect(LocationInputSchema.parse(locationFormValues(said)).what_we_do).toBe(said.what_we_do);
  });

  it("saves back unchanged as the location it was read from", () => {
    expect({ ...location, ...LocationInputSchema.parse(locationFormValues(location)) }).toEqual(
      location,
    );
  });
});

describe("googlePointLine", () => {
  const found = {
    ...location,
    latitude: 35.7795897,
    longitude: -78.6381787,
    point_source: "address" as const,
    geocoded_from: "12 Fayetteville St, Raleigh 27601, US",
  };

  it("says Google is checked from the street address it was found at", () => {
    expect(googlePointLine(found)).toBe(
      "Google results are checked from 12 Fayetteville St, Raleigh.",
    );
  });

  it("says a new address is checked from the next scan", () => {
    expect(googlePointLine({ ...found, address_line: "9 Oak Ave" })).toBe(
      "Google results will be checked from 9 Oak Ave, Raleigh, from the next scan.",
    );
  });

  it("asks for the street address when the city is all there is", () => {
    const city = { ...location, address_line: null, postal_code: null };
    const message =
      "Google results are checked from the middle of Raleigh. Add the street address to check them from your door.";
    expect(googlePointLine(city)).toBe(message);
    expect(
      googlePointLine({
        ...city,
        latitude: 35.77,
        longitude: -78.63,
        point_source: "city",
        geocoded_from: "Raleigh, US",
      }),
    ).toBe(message);
  });

  it("says when the street address could not be found, and that the city is used", () => {
    expect(googlePointLine({ ...found, latitude: 35.77, point_source: "city" })).toBe(
      "12 Fayetteville St couldn't be found on the map, so Google results are checked from the middle of Raleigh. Check the street address.",
    );
  });

  it("says when the city could not be found, with no street address to look for", () => {
    expect(
      googlePointLine({
        ...location,
        address_line: null,
        postal_code: null,
        geocoded_from: "Raleigh, US",
      }),
    ).toBe(
      "Raleigh couldn't be found on the map, so Google results aren't checked. Check the city.",
    );
  });

  it("says when the location could not be placed at all", () => {
    expect(
      googlePointLine({
        ...found,
        latitude: null,
        longitude: null,
        point_source: null,
      }),
    ).toBe(
      "Neither 12 Fayetteville St nor Raleigh could be found on the map, so Google results aren't checked. Check the address.",
    );
  });
});

describe("wantsGoogleKeyword", () => {
  const keyword = { kind: "search_keyword" as const, is_active: true };
  const prompt = { kind: "ai_prompt" as const, is_active: true };

  it("is true where Google is checked and the location has no Google keyword", () => {
    expect(wantsGoogleKeyword(["chatgpt", "google_local_pack"], [prompt])).toBe(true);
    expect(
      wantsGoogleKeyword(
        ["chatgpt", "google_local_pack"],
        [prompt, { ...keyword, is_active: false }],
      ),
    ).toBe(true);
  });

  it("is false with a Google keyword, or where Google is not checked", () => {
    expect(wantsGoogleKeyword(["chatgpt", "google_local_pack"], [prompt, keyword])).toBe(false);
    expect(wantsGoogleKeyword(["chatgpt"], [prompt])).toBe(false);
  });
});

describe("startingKind", () => {
  const google = ["chatgpt", "google_local_pack"] as const;
  const prompt = { kind: "ai_prompt" as const, is_active: true };

  it("starts a new location on a prompt, whatever is checked", () => {
    expect(startingKind(google, [])).toBe("ai_prompt");
    expect(startingKind(google, [{ ...prompt, is_active: false }])).toBe("ai_prompt");
  });

  it("starts on a keyword where Google is checked and the location has prompts but no keyword", () => {
    expect(startingKind(google, [prompt])).toBe("search_keyword");
    expect(startingKind(google, [prompt, { kind: "search_keyword", is_active: true }])).toBe(
      "ai_prompt",
    );
    expect(startingKind(["chatgpt"], [prompt])).toBe("ai_prompt");
  });
});
