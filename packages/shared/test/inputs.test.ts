import { describe, expect, it } from "vitest";
import { fieldErrors, formatPhone } from "../src/inputs";
import { LocationInputSchema, TrackedQueryInputSchema } from "../src/schemas";

const joes = { name: "Joe's Pizza", city: "Raleigh" };
const errors = (change: Record<string, unknown>) =>
  fieldErrors(LocationInputSchema, { ...joes, ...change });

describe("a location's phone number", () => {
  it("is stored in one form however it was typed", () => {
    for (const typed of ["919-555-0100", "(919) 555-0100", "919.555.0100", "+1 919 555 0100"]) {
      expect(LocationInputSchema.parse({ ...joes, phone: typed }).phone).toBe("+19195550100");
    }
  });

  it("is read as a number in the location's own country", () => {
    const london = { ...joes, country_code: "GB", phone: "020 7946 0958" };
    expect(LocationInputSchema.parse(london).phone).toBe("+442079460958");
  });

  it("is refused when it is not a phone number there", () => {
    expect(errors({ phone: "555-0100" })).toEqual({
      phone: "Enter a full phone number, with the area code",
    });
    expect(errors({ phone: "call us" }).phone).toBeDefined();
    expect(errors({ phone: "020 7946 0958" }).phone).toBeDefined();
  });

  it("may be left blank", () => {
    expect(LocationInputSchema.parse({ ...joes, phone: "  " }).phone).toBeNull();
  });
});

describe("formatPhone", () => {
  it("shows a stored number the way it is written in its country", () => {
    expect(formatPhone("+19195550100", "US")).toBe("(919) 555-0100");
    expect(formatPhone("+442079460958", "GB")).toBe("020 7946 0958");
    // A number from elsewhere keeps its country code.
    expect(formatPhone("+442079460958", "US")).toBe("+44 20 7946 0958");
  });

  it("formats as far as it can while a number is being typed, and leaves the rest alone", () => {
    expect(formatPhone("9195550100", "US")).toBe("(919) 555-0100");
    expect(formatPhone("91955", "US")).toBe("91955");
    expect(formatPhone("", "US")).toBe("");
  });
});

describe("a location's website", () => {
  it("takes an address typed without the scheme", () => {
    expect(LocationInputSchema.parse({ ...joes, website: "joes.example/menu" }).website).toBe(
      "https://joes.example/menu",
    );
    expect(LocationInputSchema.parse({ ...joes, website: "http://joes.example" }).website).toBe(
      "http://joes.example",
    );
  });

  it("is refused when it is not a web address", () => {
    for (const website of [
      "javascript:alert(1)",
      "joes pizza",
      "localhost",
      "ftp://joes.example",
    ]) {
      expect(errors({ website }).website, website).toBe("Enter a web address, like joespizza.com");
    }
  });
});

describe("a location's address fields", () => {
  it("checks the postal code against the country's form where it knows it", () => {
    expect(errors({ postal_code: "27601" })).toEqual({});
    expect(errors({ postal_code: "27601-1234" })).toEqual({});
    expect(errors({ postal_code: "2760" }).postal_code).toBe("Enter a 5-digit ZIP code");
    expect(errors({ country_code: "CA", postal_code: "k1a 0b1" })).toEqual({});
    expect(errors({ country_code: "CA", postal_code: "27601" }).postal_code).toBeDefined();
    // A country whose form is not known here only has to look like a postal code.
    expect(errors({ country_code: "GB", postal_code: "SW1A 1AA" })).toEqual({});
    expect(errors({ country_code: "GB", postal_code: "!!" }).postal_code).toBeDefined();
  });

  it("stores a Canadian postal code in its usual form", () => {
    const parsed = LocationInputSchema.parse({
      ...joes,
      country_code: "ca",
      postal_code: "k1a0b1",
    });
    expect(parsed.postal_code).toBe("K1A 0B1");
  });

  it("refuses a country code that is not a country", () => {
    expect(errors({ country_code: "ZZ" }).country_code).toBe(
      "Use a two-letter country code, like US",
    );
    expect(errors({ country_code: "usa" }).country_code).toBeDefined();
  });

  it("refuses a Google place ID that could not be one", () => {
    expect(errors({ google_place_id: "ChIJN1t_tDeuEmsRUsoyG83frY4" })).toEqual({});
    expect(errors({ google_place_id: "my business" }).google_place_id).toBeDefined();
  });

  it("needs a name and a city with a letter in them", () => {
    expect(errors({ name: "   " }).name).toBe("Name is required");
    expect(errors({ city: "12345" }).city).toBe("Enter the city's name");
  });
});

describe("fieldErrors", () => {
  it("gives one message per field, the first for each", () => {
    expect(fieldErrors(LocationInputSchema, { name: "", city: "", website: "x y" })).toEqual({
      name: "Name is required",
      city: "City is required",
      website: "Enter a web address, like joespizza.com",
    });
    expect(fieldErrors(LocationInputSchema, joes)).toEqual({});
  });

  it("reports the phone and postal code even while another field is wrong", () => {
    expect(
      fieldErrors(LocationInputSchema, {
        name: "",
        city: "Raleigh",
        phone: "12",
        postal_code: "x",
      }),
    ).toEqual({
      name: "Name is required",
      phone: "Enter a full phone number, with the area code",
      postal_code: "Enter a 5-digit ZIP code",
    });
  });
});

describe("a prompt", () => {
  it("has to be something a person could ask", () => {
    const text = (value: string) =>
      fieldErrors(TrackedQueryInputSchema, { kind: "ai_prompt", text: value }).text;
    expect(text("best pizza in Raleigh")).toBeUndefined();
    expect(text("  ")).toBe("Enter a prompt or keyword");
    expect(text("??")).toBe("Use at least three letters");
  });
});
