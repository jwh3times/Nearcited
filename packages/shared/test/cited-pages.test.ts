import { describe, expect, it } from "vitest";
import {
  analyzeCitedPage,
  type CitedBusiness,
  type CitedPageSnapshot,
  citedPageLines,
  citedPagesToRead,
} from "../src/cited-pages";
import type { SourceSummary } from "../src/schemas";

const joes: CitedBusiness = {
  name: "Joe's Pizza",
  phone: "+19195550100",
  address_line: "123 Main St",
  postal_code: "27601",
  country_code: "US",
};

const page = (html: string, change: Partial<CitedPageSnapshot> = {}): CitedPageSnapshot => ({
  host: "yellowpages.com",
  url: "https://www.yellowpages.com/raleigh-nc/mip/joes-pizza-1",
  status: 200,
  html,
  not_read: null,
  ...change,
});

const jsonLd = (data: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

const listing = (details: string) =>
  `<html><head><title>Joe's Pizza - Raleigh, NC</title></head><body>
  <h1>Joe's Pizza</h1><p>${details}</p><h2>Hours</h2><p>Open daily 11am to 10pm.</p></body></html>`;

const read = (html: string, business: CitedBusiness = joes) =>
  analyzeCitedPage(page(html), business);

describe("analyzeCitedPage", () => {
  it("compares nothing on a page that does not name the business", () => {
    const result = read(
      "<html><title>Best pizza in Raleigh</title><h2>Mario's</h2><p>(919) 555-0199</p></html>",
    );
    expect(result).toMatchObject({ names_business: false, phone: null, address: null });
    expect(citedPageLines(result, joes)).toEqual(["This page does not name Joe's Pizza."]);
  });

  it("finds the business's phone and address on its own listing", () => {
    const result = read(listing("123 Main St, Raleigh, NC 27601. Call (919) 555-0100."));
    expect(result).toMatchObject({
      not_read: null,
      names_business: true,
      phone: { found: "matches", shown: null },
      address: "matches",
    });
    expect(citedPageLines(result, joes)).toEqual([
      "The page names Joe's Pizza.",
      "It shows your phone number.",
      "It shows your street number and postal code.",
    ]);
  });

  it("quotes a phone number that differs", () => {
    const result = read(listing("123 Main St, Raleigh, NC 27601. Call (919) 555-0199."));
    expect(result.phone).toEqual({ found: "differs", shown: "+19195550199" });
    expect(citedPageLines(result, joes)).toContain(
      "It shows (919) 555-0199, not the phone number on file.",
    );
  });

  it("says so when the page shows no number for the business", () => {
    const result = read(listing("123 Main St, Raleigh, NC 27601."));
    expect(result.phone).toEqual({ found: "not_found", shown: null });
    expect(citedPageLines(result, joes)).toContain("It shows no phone number for Joe's Pizza.");
  });

  it("quotes the page's number when there is no phone on file", () => {
    const result = read(listing("Call (919) 555-0100."), { ...joes, phone: null });
    expect(result.phone).toEqual({ found: "none_on_file", shown: "+19195550100" });
    expect(citedPageLines(result, { ...joes, phone: null })).toContain(
      "It shows (919) 555-0100; there is no phone on file.",
    );
    const none = read(listing("Thin crust."), { ...joes, phone: null });
    expect(none.phone).toEqual({ found: "none_on_file", shown: null });
    expect(citedPageLines(none, { ...joes, phone: null })).toContain(
      "No phone on file to compare.",
    );
  });

  it("finds the business under the page's own spelling of its name", () => {
    const curly = read(
      "<html><body><p>Joe\u2019s Pizza, 123 Main St, Raleigh 27601. (919) 555-0100</p></body></html>",
    );
    expect(curly).toMatchObject({ phone: { found: "matches" }, address: "matches" });
    const anded = read(
      "<html><body><p>Fish &amp; Chips Co. Call (919) 555-0100</p></body></html>",
      { ...joes, name: "Fish and Chips" },
    );
    expect(anded.phone?.found).toBe("matches");
  });

  it("does not take a neighbour's number on a list page for the business's", () => {
    const list = `<html><title>Best pizza in Raleigh</title><body>
      <h2>1. Mario's Pizzeria</h2><p>456 Oak Ave, Raleigh 27603. (919) 555-0199</p>
      <h2>2. Joe's Pizza</h2><p>Thin crust downtown.</p>
      <h2>3. Slice House</h2><p>789 Elm St, Raleigh 27601. (919) 555-0177</p></body></html>`;
    const result = read(list);
    expect(result).toMatchObject({
      names_business: true,
      phone: { found: "not_found", shown: null },
      address: "not_found",
    });
  });

  it("reads the business's own entry on a list page", () => {
    const list = `<html><title>Best pizza in Raleigh</title><body>
      <h2>1. Mario's Pizzeria</h2><p>456 Oak Ave, Raleigh 27603. (919) 555-0199</p>
      <h2>2. Joe's Pizza</h2><p>123 Main St, Raleigh 27601. (919) 555-0100</p></body></html>`;
    expect(read(list)).toMatchObject({ phone: { found: "matches" }, address: "matches" });
  });

  it("ignores a number far below the business's name", () => {
    const filler = "Thin crust pies and calzones. ".repeat(30);
    const result = read(listing(`${filler} Our partner: (919) 555-0199`));
    expect(result.phone?.found).toBe("not_found");
  });

  it("reads structured details first, as exact fields", () => {
    const html = `<html><title>Joe's Pizza</title>${jsonLd({
      "@type": "Restaurant",
      name: "Joe's Pizza",
      telephone: "+1-919-555-0199",
      address: { streetAddress: "123 Main St", postalCode: "27601" },
    })}<body><h1>Joe's Pizza</h1><p>Call (919) 555-0100</p></body></html>`;
    expect(read(html)).toMatchObject({
      phone: { found: "differs", shown: "+19195550199" },
      address: "matches",
    });
  });

  it("does not take structured details for another business as the business's", () => {
    const html = `<html><title>Joe's Pizza</title>${jsonLd({
      "@type": "Restaurant",
      name: "Mario's Pizzeria",
      telephone: "+1-919-555-0199",
    })}<body><h1>Joe's Pizza</h1><p>Call (919) 555-0100</p></body></html>`;
    expect(read(html).phone?.found).toBe("matches");
  });

  it("matches the address loosely and never calls it wrong", () => {
    const moved = read(listing("500 Elm St, Raleigh, NC 27605. Call (919) 555-0100."));
    expect(moved.address).toBe("not_found");
    expect(citedPageLines(moved, joes)).toContain(
      "It does not show your street number and postal code.",
    );
    const zipPlusFour = read(listing("123 Main Street, Raleigh NC 27601-1234."));
    expect(zipPlusFour.address).toBe("matches");
    // A number inside a phone number is not a street number.
    const inPhone = read(listing("Call 919-123-0100, Raleigh 27601."), {
      ...joes,
      address_line: "123 Main St",
    });
    expect(inPhone.address).toBe("not_found");
  });

  it("compares whichever of the street number and postal code are on file", () => {
    const html = listing("123 Main St, Raleigh.");
    const street = read(html, { ...joes, postal_code: null });
    expect(street.address).toBe("matches");
    expect(citedPageLines(street, { ...joes, postal_code: null })).toContain(
      "It shows your street number.",
    );
    expect(read(html, { ...joes, address_line: "Main Street" }).address).toBe("not_found");
    const none = read(html, { ...joes, address_line: null, postal_code: null });
    expect(none.address).toBe("none_on_file");
    expect(citedPageLines(none, { ...joes, address_line: null, postal_code: null })).toContain(
      "No address on file to compare.",
    );
    // An address on file with nothing in it to look for is said to be so, not to be missing.
    const unnumbered = { ...joes, address_line: "Main Street", postal_code: null };
    expect(read(html, unnumbered).address).toBe("none_on_file");
    expect(citedPageLines(read(html, unnumbered), unnumbered)).toContain(
      "The address on file has no street number or postal code to compare.",
    );
  });

  it("says why a page was not read, and compares nothing", () => {
    const cases = [
      ["shut_out", null, "The site's robots.txt asks NearcitedBot not to read this page."],
      ["robots_unreadable", null, "The site's robots.txt could not be read, so the page was not."],
      ["unreachable", 404, "The page answered with an error (404)."],
      ["unreachable", null, "The page did not answer."],
      ["not_html", 200, "The page is not a web page."],
      ["left_site", 301, "The page redirects off yellowpages.com, so it was not read."],
      [
        "over_budget",
        null,
        "The latest scan used up its requests for reading pages before it reached this one.",
      ],
    ] as const;
    for (const [reason, status, line] of cases) {
      const result = analyzeCitedPage(page("", { html: null, not_read: reason, status }), joes);
      expect(result).toMatchObject({
        not_read: reason,
        status,
        names_business: null,
        phone: null,
        address: null,
      });
      expect(citedPageLines(result, joes)).toEqual([line]);
    }
  });
});

describe("citedPagesToRead", () => {
  const source = (host: string, answers: number, urls = [`https://${host}/joes`]) =>
    ({ host, answers, named: 0, own: false, urls }) as SourceSummary;

  it("reads the directory tasks' most cited pages, most cited first, at most three", () => {
    const recommendations = [
      "source:yelp.com",
      "source:yellowpages.com",
      "source:manta.com",
      "source:bing.com",
      "source:mapquest.com",
      "absent:chatgpt",
    ].map((rule) => ({ rule }));
    const sources = [
      source("yelp.com", 9),
      source("manta.com", 3),
      source("yellowpages.com", 5, ["https://yellowpages.com/a", "https://yellowpages.com/b"]),
      source("bing.com", 3),
      source("mapquest.com", 2),
    ];
    // Yelp is a review site, not a directory, so its task asks for reviews and is not read.
    expect(citedPagesToRead(recommendations, sources, new Set())).toEqual([
      { host: "yellowpages.com", url: "https://yellowpages.com/a" },
      { host: "bing.com", url: "https://bing.com/joes" },
      { host: "manta.com", url: "https://manta.com/joes" },
    ]);
  });

  it("never reads the page of a task a member dismissed, or one with no page cited", () => {
    const recommendations = [{ rule: "source:yellowpages.com" }, { rule: "source:manta.com" }];
    const sources = [source("yellowpages.com", 5), source("manta.com", 3, [])];
    expect(citedPagesToRead(recommendations, sources, new Set(["yellowpages.com"]))).toEqual([]);
  });
});
