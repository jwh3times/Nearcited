import { describe, expect, it } from "vitest";
import { LISTING_URL_MAX, listingSite, readListing, reviewForm } from "../src/listings";
import { listedSite } from "../src/source-kinds";

describe("the name a site goes by on the list", () => {
  it("is its own, or the parent's it is listed under", () => {
    expect(listedSite("bbb.org")).toBe("bbb.org");
    expect(listedSite("www.BBB.org")).toBe("bbb.org");
    expect(listedSite("travel.usnews.com")).toBe("usnews.com");
  });

  it("is nothing for a site that is not listed, or one that only ends the same way", () => {
    expect(listedSite("somewhere.example")).toBeNull();
    expect(listedSite("notbbb.org")).toBeNull();
    expect(listedSite("org")).toBeNull();
  });
});

describe("which sites a task asks for a listing on", () => {
  it("is one that lets a business ask its customers for reviews", () => {
    expect(listingSite("bbb.org")).toBe("bbb.org");
    expect(listingSite("www.tripadvisor.com")).toBe("tripadvisor.com");
  });

  it("is never one that forbids asking, a directory, a page somebody wrote or a site not known", () => {
    for (const host of ["yelp.com", "yellowpages.com", "usnews.com", "somewhere.example"]) {
      expect(listingSite(host), host).toBeNull();
    }
  });

  it("is not Google, which is to be reached by the place ID a location holds", () => {
    expect(listingSite("google.com")).toBeNull();
    expect(listingSite("maps.google.com")).toBeNull();
  });
});

describe("reading a pasted listing", () => {
  const PAGE = "https://www.bbb.org/us/nc/raleigh/profile/pizza/joes-pizza-0593-1234";

  it("keeps the address of a page on the site, and on a subdomain of it", () => {
    expect(readListing("bbb.org", PAGE)).toEqual({ url: PAGE });
    expect(readListing("bbb.org", "https://bbb.org/profile/joes")).toEqual({
      url: "https://bbb.org/profile/joes",
    });
  });

  it("takes an address as it is usually copied: with spaces round it, or without its start", () => {
    expect(readListing("bbb.org", `  ${PAGE}\n`)).toEqual({ url: PAGE });
    expect(readListing("bbb.org", "www.bbb.org/profile/joes")).toEqual({
      url: "https://www.bbb.org/profile/joes",
    });
    expect(readListing("bbb.org", "http://www.bbb.org/profile/joes")).toEqual({
      url: "https://www.bbb.org/profile/joes",
    });
    expect(readListing("bbb.org", "HTTPS://WWW.BBB.ORG/profile/Joes")).toEqual({
      url: "https://www.bbb.org/profile/Joes",
    });
  });

  it("keeps what picks the page out and drops the place on it", () => {
    expect(readListing("houzz.com", "https://www.houzz.com/pro?id=42#reviews")).toEqual({
      url: "https://www.houzz.com/pro?id=42",
    });
  });

  it("refuses what is not an address a browser would follow over https", () => {
    for (const pasted of [
      "",
      "Joe's Pizza on BBB",
      "javascript:alert(1)//bbb.org/x",
      "ftp://www.bbb.org/profile/joes",
      "data:text/html,bbb.org",
      "https://user:secret@www.bbb.org/profile/joes",
    ]) {
      expect(readListing("bbb.org", pasted), pasted).toEqual({
        problem: "Paste the whole address of your listing, starting with https://.",
      });
    }
  });

  it("refuses an address on another site, however much it looks like this one", () => {
    for (const pasted of [
      "https://www.yelp.com/biz/joes-pizza",
      "https://notbbb.org/profile/joes",
      "https://bbb.org.example.com/profile/joes",
      "https://example.com/bbb.org/profile/joes",
      "https://bbb.org@example.com/profile/joes",
    ]) {
      const read = readListing("bbb.org", pasted);
      expect("problem" in read, pasted).toBe(true);
      expect("url" in read, pasted).toBe(false);
    }
    expect(readListing("bbb.org", "https://www.yelp.com/biz/joes-pizza")).toEqual({
      problem: "That address is not on bbb.org. Paste the address of your own page there.",
    });
  });

  it("refuses the site's front page, which is nobody's listing", () => {
    for (const pasted of ["https://www.bbb.org", "https://www.bbb.org/", "bbb.org", "bbb.org//"]) {
      expect(readListing("bbb.org", pasted), pasted).toEqual({
        problem: "That is the front page of bbb.org. Paste the address of your own page there.",
      });
    }
  });

  it("refuses an address too long to keep", () => {
    const most = `https://bbb.org/${"a".repeat(LISTING_URL_MAX - "https://bbb.org/".length)}`;
    expect(readListing("bbb.org", most)).toEqual({ url: most });
    expect(readListing("bbb.org", `${most}a`)).toEqual({
      problem: `Paste an address of ${LISTING_URL_MAX} characters or fewer.`,
    });
  });
});

describe("where a customer writes a review", () => {
  const PROFILE = "https://www.bbb.org/us/nc/raleigh/profile/pizza/joes-pizza-0593-1234";

  it("is the profile's own review page on bbb.org, whichever page of the profile was pasted", () => {
    expect(reviewForm("bbb.org", PROFILE)).toBe(`${PROFILE}/leave-a-review`);
    for (const pasted of [
      `${PROFILE}/`,
      `${PROFILE}/customer-reviews`,
      `${PROFILE}/customer-reviews?page=2`,
      `${PROFILE}/leave-a-review`,
      `${PROFILE}/complaints`,
    ]) {
      expect(reviewForm("bbb.org", pasted), pasted).toBe(`${PROFILE}/leave-a-review`);
    }
  });

  it("is the company's rating page on trustpilot.com, on the part of the site it was pasted from", () => {
    expect(
      reviewForm("trustpilot.com", "https://www.trustpilot.com/review/joespizza.example"),
    ).toBe("https://www.trustpilot.com/evaluate/joespizza.example");
    expect(
      reviewForm("trustpilot.com", "https://uk.trustpilot.com/review/joespizza.example?stars=5"),
    ).toBe("https://uk.trustpilot.com/evaluate/joespizza.example");
    // The form's own address is the form.
    expect(
      reviewForm("trustpilot.com", "https://www.trustpilot.com/evaluate/joespizza.example"),
    ).toBe("https://www.trustpilot.com/evaluate/joespizza.example");
  });

  it("is not made from a listing whose address is not of the shape that was read", () => {
    for (const [site, listing] of [
      // Not a profile: a search, a category, a profile in a country that was not read.
      ["bbb.org", "https://www.bbb.org/search?find_text=pizza"],
      ["bbb.org", "https://www.bbb.org/us/nc/raleigh/category/pizza"],
      ["bbb.org", "https://www.bbb.org/us/nc/raleigh/profile/pizza"],
      ["bbb.org", "https://www.bbb.org/ca/on/toronto/profile/pizza/joes-pizza-0107-1234"],
      ["trustpilot.com", "https://www.trustpilot.com/categories/restaurants_bars"],
      ["trustpilot.com", "https://www.trustpilot.com/review/joespizza.example/transparency"],
      ["trustpilot.com", "https://www.trustpilot.com/review/"],
      ["bbb.org", "not an address"],
    ] as const) {
      expect(reviewForm(site, listing), listing).toBeNull();
    }
  });

  it("is not known for any other site, so none is guessed", () => {
    for (const site of [
      "angi.com",
      "capterra.com",
      "g2.com",
      "houzz.com",
      "thumbtack.com",
      "tripadvisor.com",
      "zillow.com",
      // Not sites a listing is kept for at all.
      "google.com",
      "yelp.com",
      "somewhere.example",
      // Not names a careless lookup should find.
      "constructor",
      "toString",
      "__proto__",
    ]) {
      expect(
        reviewForm(site, `https://www.${site}/us/nc/raleigh/profile/pizza/joes-1`),
        site,
      ).toBeNull();
    }
  });

  it("stays on the site the listing is on", () => {
    for (const [site, listing] of [
      ["bbb.org", "https://www.bbb.org/us/nc/raleigh/profile/pizza/joes-pizza-0593-1234"],
      ["trustpilot.com", "https://www.trustpilot.com/review/joespizza.example"],
    ] as const) {
      const form = new URL(reviewForm(site, listing) ?? "");
      expect(form.protocol).toBe("https:");
      expect(form.host).toBe(new URL(listing).host);
    }
  });
});
