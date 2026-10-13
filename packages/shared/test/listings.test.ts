import { describe, expect, it } from "vitest";
import {
  asksForReviewLink,
  LISTING_URL_MAX,
  listingSite,
  readListing,
  reviewForm,
} from "../src/listings";
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

  it("is Google too, under its one name", () => {
    expect(listingSite("google.com")).toBe("google.com");
    expect(listingSite("maps.google.com")).toBe("google.com");
  });
});

describe("which sites are asked for the link they give, not for a page", () => {
  it("is Google and no other", () => {
    expect(asksForReviewLink("google.com")).toBe(true);
    for (const site of ["bbb.org", "trustpilot.com", "g.page", "www.google.com", "yelp.com"]) {
      expect(asksForReviewLink(site), site).toBe(false);
    }
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

describe("reading the review link Google gives a business", () => {
  const LINK = "https://g.page/r/CZx1AbCdEfGhEAE/review";
  const NOT_THE_LINK =
    "That does not look like the review link Google gives you. On your Business Profile, choose Read Reviews, then Get more reviews, and copy the link shown there.";

  it("keeps the link, which is not on the name Google is listed by", () => {
    expect(readListing("google.com", LINK)).toEqual({ url: LINK });
    expect(readListing("google.com", `  ${LINK.replace("https://", "")}\n`)).toEqual({ url: LINK });
    expect(readListing("google.com", LINK.replace("https://", "http://"))).toEqual({ url: LINK });
  });

  it("keeps another address of Google's that a customer can open", () => {
    for (const pasted of [
      "https://search.google.com/local/writereview?placeid=ChIJ0000000000000000000000000",
      "https://www.google.com/maps/place/Joes+Pizza/@35.77,-78.63,17z",
      "https://maps.google.com/?cid=1234567890",
    ]) {
      expect(readListing("google.com", pasted), pasted).toEqual({ url: pasted });
    }
  });

  it("refuses what an owner copies from the top of the browser while managing the profile", () => {
    for (const pasted of [
      // The search a profile is managed from.
      "https://www.google.com/search?q=Joe%27s+Pizza+Raleigh&authuser=0",
      "google.com/search?q=joes+pizza",
      "https://www.google.com/search/?q=joes+pizza",
      // The pages only its owner can open.
      "https://business.google.com/dashboard/l/01234567890123456789",
      "https://business.google.com/reviews",
    ]) {
      expect(readListing("google.com", pasted), pasted).toEqual({ problem: NOT_THE_LINK });
    }
  });

  it("refuses a front page and an address that is not Google's, and says where the link is", () => {
    for (const pasted of [
      "https://www.google.com",
      "google.com/",
      "https://g.page",
      "https://www.yelp.com/biz/joes-pizza",
      "https://g.page.example.com/r/CZx1AbCdEfGhEAE/review",
      "https://notg.page/r/CZx1AbCdEfGhEAE/review",
      "https://google.com.example.com/maps/place/joes",
      "https://example.com/g.page/r/CZx1AbCdEfGhEAE/review",
      // A site that asks for a page takes a page on itself: bbb.org is not Google.
      "https://www.bbb.org/us/nc/raleigh/profile/pizza/joes-pizza-0593-1234",
    ]) {
      expect(readListing("google.com", pasted), pasted).toEqual({ problem: NOT_THE_LINK });
    }
  });

  it("refuses what is not an address a browser would follow over https", () => {
    for (const pasted of ["", "my review link", "javascript:alert(1)//g.page/r/x/review"]) {
      expect(readListing("google.com", pasted), pasted).toEqual({
        problem: "Paste the whole link, starting with https://.",
      });
    }
  });

  it("is taken on Google only: g.page is no other site's", () => {
    expect("problem" in readListing("bbb.org", LINK)).toBe(true);
    expect("problem" in readListing("trustpilot.com", LINK)).toBe(true);
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
      // Already the link Google gave, so nothing is made from it.
      "google.com",
      // Not sites a listing is kept for at all.
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
