import { describe, expect, it } from "vitest";
import { LISTING_URL_MAX, listingSite, readListing } from "../src/listings";
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

  it("is not Google, whose review form is reached by the place ID a location holds", () => {
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
