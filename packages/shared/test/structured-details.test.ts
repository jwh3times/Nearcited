import { describe, expect, it } from "vitest";
import { analyzeSite } from "../src/site";
import {
  type BlockLocation,
  buildBusinessBlock,
  needsBusinessBlock,
} from "../src/structured-details";

const full: BlockLocation = {
  name: "Joe's Pizza",
  website: "https://joespizza.example",
  phone: "+19195550100",
  address_line: "12 Main St",
  city: "Raleigh",
  region: "NC",
  postal_code: "27601",
  country_code: "US",
};
const bare: BlockLocation = {
  ...full,
  website: null,
  phone: null,
  address_line: null,
  region: null,
  postal_code: null,
};

/** A page that says who and where the business is, with `extra` somewhere in it. */
const page = (extra: string) => ({
  url: "https://joespizza.example/",
  status: 200,
  html: `<html><head><title>Joe's Pizza</title>${extra}</head><body><p>${"Joe's Pizza makes pizza in Raleigh. ".repeat(12)}</p></body></html>`,
  robots_txt: null,
  noindex_header: false,
});
const passes = (html: string) =>
  analyzeSite(page(html), { name: "Joe's Pizza", city: "Raleigh" }).checks.find(
    (check) => check.id === "structured_data",
  )?.passed;

describe("buildBusinessBlock", () => {
  it("states what the location holds, as a local business with a postal address", () => {
    expect(buildBusinessBlock(full).data).toEqual({
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: "Joe's Pizza",
      url: "https://joespizza.example",
      telephone: "+19195550100",
      address: {
        "@type": "PostalAddress",
        streetAddress: "12 Main St",
        addressLocality: "Raleigh",
        addressRegion: "NC",
        postalCode: "27601",
        addressCountry: "US",
      },
    });
    expect(buildBusinessBlock(full).missing).toEqual([]);
  });

  it("leaves out what is not on file, and says which of it would be worth adding", () => {
    const block = buildBusinessBlock(bare);
    expect(block.data).toEqual({
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: "Joe's Pizza",
      address: { "@type": "PostalAddress", addressLocality: "Raleigh", addressCountry: "US" },
    });
    // A region is not asked for: many places have none.
    expect(block.missing).toEqual(["address_line", "postal_code", "phone"]);
    expect(buildBusinessBlock({ ...bare, phone: "+19195550100" }).missing).toEqual([
      "address_line",
      "postal_code",
    ]);
  });

  it("is a JSON-LD script element holding exactly what it states", () => {
    const { html, data } = buildBusinessBlock(full);
    const [, body] =
      /^<script type="application\/ld\+json">\n([\s\S]*)\n<\/script>$/.exec(html) ?? [];
    expect(JSON.parse(body ?? "")).toEqual(data);
    // Set out to be read, not on one line.
    expect(body).toContain('\n  "name": "Joe\'s Pizza",\n');
  });

  it("cannot be closed early by anything a detail says", () => {
    const name = "Joe's </script><script>alert(1)</script> <!-- Pizza";
    const { html, data } = buildBusinessBlock({ ...full, name });

    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toContain("<!--");
    // And it still says what the location holds, once a browser or a crawler reads the JSON.
    const body = html.slice(html.indexOf("\n"), html.lastIndexOf("\n"));
    expect(JSON.parse(body)).toEqual(data);
    expect((JSON.parse(body) as { name: string }).name).toBe(name);
  });

  it("is what the on-page check looks for, with every detail and with the fewest", () => {
    expect(passes("")).toBe(false);
    expect(passes(buildBusinessBlock(full).html)).toBe(true);
    expect(passes(buildBusinessBlock(bare).html)).toBe(true);
  });
});

describe("needsBusinessBlock", () => {
  const site = (checks: { id: "reachable" | "structured_data"; passed: boolean }[]) => ({
    url: "https://joespizza.example/",
    status: 200,
    checks,
    blocked_crawlers: [],
    words: 120,
  });

  it("is true when the page was read and held no structured business details", () => {
    expect(
      needsBusinessBlock(
        site([
          { id: "reachable", passed: true },
          { id: "structured_data", passed: false },
        ]),
      ),
    ).toBe(true);
  });

  it("is false when the page has them, was never checked, or could not be read", () => {
    expect(needsBusinessBlock(site([{ id: "structured_data", passed: true }]))).toBe(false);
    expect(needsBusinessBlock(null)).toBe(false);
    // A page that leads nowhere has only the one check, and one that proved nothing has none.
    expect(needsBusinessBlock(site([{ id: "reachable", passed: false }]))).toBe(false);
    expect(needsBusinessBlock(site([]))).toBe(false);
  });
});
