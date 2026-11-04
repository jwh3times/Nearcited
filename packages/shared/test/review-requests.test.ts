import { describe, expect, it } from "vitest";
import {
  CONFIDENTIAL_KINDS,
  isConfidentialCategory,
  qualifyingSites,
  receiptAddress,
  reviewRequestEmail,
} from "../src/review-requests";
import type { Listing, SourceSummary } from "../src/schemas";

const listing = (site: string, url: string): Listing => ({
  location_id: "00000000-0000-4000-8000-000000000001",
  site,
  url,
  set_by_email: null,
  set_at: "2026-11-01T00:00:00.000Z",
});
const cited = (host: string, answers: number): SourceSummary => ({
  host,
  answers,
  named: 0,
  own: false,
  urls: [],
});

const GOOGLE = listing("google.com", "https://g.page/r/joes-pizza/review");
const BBB = listing(
  "bbb.org",
  "https://www.bbb.org/us/nc/raleigh/profile/pizza/joes-pizza-0593-1234",
);
const TRUSTPILOT = listing("trustpilot.com", "https://www.trustpilot.com/review/joespizza.com");

describe("the sites a review request may ask for", () => {
  it("are the review sites the location has a listing on with a form, most cited first", () => {
    const sites = qualifyingSites(
      [GOOGLE, BBB, TRUSTPILOT],
      [cited("www.bbb.org", 2), cited("maps.google.com", 3), cited("google.com", 4)],
    );
    expect(sites.map((site) => [site.site, site.cited])).toEqual([
      ["google.com", 7],
      ["bbb.org", 2],
      ["trustpilot.com", 0],
    ]);
    expect(sites[0]).toEqual({
      site: "google.com",
      name: "Google",
      link: "https://g.page/r/joes-pizza/review",
      cited: 7,
    });
    expect(sites[1]?.link).toBe(
      "https://www.bbb.org/us/nc/raleigh/profile/pizza/joes-pizza-0593-1234/leave-a-review",
    );
    expect(sites[2]?.link).toBe("https://www.trustpilot.com/evaluate/joespizza.com");
  });

  it("leave out a listing with no review form, and a site that does not let a business ask", () => {
    const yelp = listing("yelp.com", "https://www.yelp.com/biz/joes-pizza-raleigh");
    const otherBbb = listing("bbb.org", "https://www.bbb.org/ca/on/toronto/profile/joes");
    const houzz = listing("houzz.com", "https://www.houzz.com/professionals/joes");
    expect(qualifyingSites([yelp, otherBbb, houzz], [cited("houzz.com", 9)])).toEqual([]);
  });

  it("are listed by name where none was cited", () => {
    expect(qualifyingSites([TRUSTPILOT, BBB], []).map((site) => site.site)).toEqual([
      "bbb.org",
      "trustpilot.com",
    ]);
  });
});

describe("a confidential kind of business", () => {
  it("is told by its category", () => {
    for (const category of [
      "Dentist",
      "Pediatric dental clinic",
      "Family law attorney",
      "Law firm",
      "Mental health counseling",
      "Psychotherapist",
      "Financial advisor",
      "Accountants",
      "Urgent care",
    ]) {
      expect(isConfidentialCategory(category), category).toBe(true);
    }
  });

  it("is not a business whose category only looks like one", () => {
    for (const category of [
      "Pizza restaurant",
      "Lawn care service",
      "Plumber",
      "Health food store",
      "Dog groomer",
      null,
      "",
    ]) {
      expect(isConfidentialCategory(category), String(category)).toBe(false);
    }
  });

  it("matches every kind on the list, written as it is listed", () => {
    for (const kind of CONFIDENTIAL_KINDS) expect(isConfidentialCategory(kind), kind).toBe(true);
  });
});

describe("a receipt address", () => {
  it("is the location's own name at the product's receiving domain", () => {
    expect(receiptAddress("0123456789abcdef0123456789abcdef")).toBe(
      "0123456789abcdef0123456789abcdef@receipts.nearcited.com",
    );
  });
});

describe("the email a review request is", () => {
  const email = reviewRequestEmail({
    business: "  Joe's   Pizza ",
    site: "google.com",
    link: "https://g.page/r/joes-pizza/review",
    optOut: "https://nearcited.com/opt-out/abc",
  });

  it("comes from the business by name", () => {
    expect(email.sender).toBe("Joe's Pizza");
    expect(email.subject).toBe("Would you review Joe's Pizza on Google?");
  });

  it("is the request to send, then who sends it and how to hear no more", () => {
    expect(email.body).toBe(
      [
        "Thank you for choosing Joe's Pizza. Would you leave a review on Google? Say what you honestly thought, good or bad: it helps other people decide.",
        "https://g.page/r/joes-pizza/review",
        "",
        "Nearcited sends this email for Joe's Pizza. If you reply, your reply goes to Joe's Pizza.",
        "",
        "To get no more emails like this from Joe's Pizza: https://nearcited.com/opt-out/abc",
      ].join("\n"),
    );
  });
});
