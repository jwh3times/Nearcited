import { describe, expect, it } from "vitest";
import type { Recommendation } from "../src/schemas";
import { analyzeSite } from "../src/site";
import {
  type BlockLocation,
  buildBusinessBlock,
  buildDetailsFix,
  citedCount,
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

/** An answer that cited the business's own site, or somebody else's. */
const answer = (own: boolean) => ({
  mentioned: own,
  cited_urls: [own ? "https://www.joespizza.example/menu" : "https://www.yelp.com/biz/x"],
});

describe("citedCount", () => {
  it("counts the answers that cited the business's own website, once each", () => {
    const answers = [
      answer(true),
      answer(false),
      {
        mentioned: true,
        cited_urls: ["https://joespizza.example/", "https://joespizza.example/a"],
      },
    ];
    expect(citedCount(answers, "https://joespizza.example")).toEqual({ answers: 3, cited: 2 });
  });

  it("counts none where no website is on file, or nothing came in", () => {
    expect(citedCount([answer(true)], null)).toEqual({ answers: 1, cited: 0 });
    expect(citedCount([], "https://joespizza.example")).toEqual({ answers: 0, cited: 0 });
  });
});

describe("buildDetailsFix", () => {
  const recommendation = (change: Partial<Recommendation> = {}): Recommendation => ({
    id: "00000000-0000-4000-8000-0000000000d1",
    location_id: "00000000-0000-4000-8000-0000000000b1",
    scan_id: null,
    rule: "site:structured_data",
    title: "Your home page has no structured business details",
    detail: "Detail",
    status: "open",
    acted_at: null,
    acted_by_action: null,
    created_at: "2026-10-01T00:00:00Z",
    ...change,
  });
  const website = "https://joespizza.example";
  const fixFor = (
    recommendations: Recommendation[],
    evidence: Parameters<typeof buildDetailsFix>[0]["evidence"] = new Map(),
  ) => buildDetailsFix({ recommendations, website, evidence });

  it("is nothing where the check never found the details missing, or the finding was dismissed", () => {
    expect(fixFor([])).toBeNull();
    expect(fixFor([recommendation({ rule: "site:names_city" })])).toBeNull();
    expect(fixFor([recommendation({ status: "dismissed" })])).toBeNull();
  });

  it("stands unmarked, with nothing to compare, until a member says the block is on the page", () => {
    expect(fixFor([recommendation()])).toEqual({
      id: "00000000-0000-4000-8000-0000000000d1",
      acted_at: null,
      acted_by_action: null,
      checked_since: false,
      before: null,
      since: null,
    });
  });

  it("sets what the answers did before the mark beside what they have done since", () => {
    const marked = recommendation({ acted_at: "2026-10-05T09:00:00Z", status: "done" });
    const evidence = new Map([
      [
        marked.id,
        {
          before: [answer(false), answer(false), answer(true)],
          since: [answer(true), answer(true)],
          scans_since: 1,
        },
      ],
    ]);
    expect(fixFor([marked], evidence)).toEqual({
      id: marked.id,
      acted_at: "2026-10-05T09:00:00Z",
      acted_by_action: null,
      checked_since: true,
      before: { answers: 3, cited: 1 },
      since: { answers: 2, cited: 2 },
    });
  });

  it("says no scan has looked since while none has finished", () => {
    const marked = recommendation({ acted_at: "2026-10-05T09:00:00Z" });
    const evidence = new Map([[marked.id, { before: [answer(false)], since: [], scans_since: 0 }]]);
    expect(fixFor([marked], evidence)).toMatchObject({
      checked_since: false,
      since: { answers: 0, cited: 0 },
    });
  });
});
