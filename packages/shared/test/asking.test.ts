import { describe, expect, it } from "vitest";
import { cardWords, requestToSend, siteName } from "../src/asking";
import { listingSite } from "../src/listings";
import { sitesOfKind } from "../src/source-kinds";

const LINK = "https://g.page/r/CZx1AbCdEfGhEAE/review";

describe("the name a customer knows a site by", () => {
  it("is its name, not its address", () => {
    expect(siteName("google.com")).toBe("Google");
    expect(siteName("bbb.org")).toBe("BBB");
    expect(siteName("tripadvisor.com")).toBe("Tripadvisor");
  });

  it("is there for every site a task asks for a listing on", () => {
    const asked = sitesOfKind("reviews");
    expect(asked.length).toBeGreaterThan(0);
    for (const site of asked) {
      expect(listingSite(site), site).toBe(site);
      expect(siteName(site), site).not.toBe(site);
      expect(siteName(site), site).not.toMatch(/\.|^$/);
    }
  });

  it("is the address for a site with no name on the table, and for nothing an object carries", () => {
    expect(siteName("somewhere.example")).toBe("somewhere.example");
    expect(siteName("constructor")).toBe("constructor");
  });
});

describe("the request an owner sends a customer", () => {
  const request = requestToSend({ business: "Joe's Pizza", site: "google.com", link: LINK });

  it("thanks them, asks for a review on the site by its name, and ends on the link alone", () => {
    expect(request).toBe(
      `Thank you for choosing Joe's Pizza. Would you leave a review on Google? Say what you honestly thought, good or bad: it helps other people decide.\n${LINK}`,
    );
  });

  it("carries the link it was given and no other, on the last line", () => {
    const lines = request.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(LINK);
    expect(lines[0]).not.toMatch(/https?:|www\./);
  });

  it("asks for what the customer thought, good or bad, and never for a good review", () => {
    expect(request).toContain("good or bad");
    expect(request).not.toMatch(
      /\b(?:5|five)[- ]stars?\b|positive|great review|if you (?:liked|enjoyed|were happy)/i,
    );
  });

  it("offers nothing in return", () => {
    expect(request).not.toMatch(
      /discount|coupon|free\b|gift|reward|prize|entry|enter(?:ed)? to win|% off|\$\d|in return|in exchange/i,
    );
  });

  it("names the site a task is for, whichever it is", () => {
    const elsewhere = requestToSend({
      business: "Joe's Pizza",
      site: "bbb.org",
      link: "https://www.bbb.org/us/nc/raleigh/profile/pizza/joes-pizza-0593-1234/leave-a-review",
    });
    expect(elsewhere).toContain("Would you leave a review on BBB?");
    expect(elsewhere).not.toContain("Google");
  });

  it("does not close a name twice that brings its own full stop", () => {
    const first = (business: string) =>
      requestToSend({ business, site: "google.com", link: LINK }).split(" Would you")[0];
    expect(first("Joe's Pizza Inc.")).toBe("Thank you for choosing Joe's Pizza Inc.");
    expect(first("Wow!")).toBe("Thank you for choosing Wow!");
    expect(first("Joe's Pizza")).toBe("Thank you for choosing Joe's Pizza.");
  });

  it("writes the name out tidily however it was typed", () => {
    expect(requestToSend({ business: "  Joe's   Pizza ", site: "google.com", link: LINK })).toBe(
      request,
    );
  });
});

describe("the words on the card an owner prints", () => {
  const words = cardWords({ business: "Joe's Pizza", site: "google.com" });

  it("is headed by the business, asks for a review on the site by its name, and says how", () => {
    expect(words).toEqual({
      heading: "Joe's Pizza",
      ask: "How did we do? Leave a review on Google.",
      how: "Point your phone's camera at the code.",
    });
  });

  it("names the site a task is for, whichever it is", () => {
    expect(cardWords({ business: "Joe's Pizza", site: "trustpilot.com" }).ask).toBe(
      "How did we do? Leave a review on Trustpilot.",
    );
  });

  it("asks for no good review and offers nothing in return", () => {
    const all = `${words.heading} ${words.ask} ${words.how}`;
    expect(all).not.toMatch(/\b(?:5|five)[- ]stars?\b|positive|great review|loved/i);
    expect(all).not.toMatch(/discount|coupon|free\b|gift|reward|prize|win\b|% off|\$\d/i);
  });

  it("writes the name out tidily however it was typed", () => {
    expect(cardWords({ business: "  Joe's   Pizza ", site: "google.com" }).heading).toBe(
      "Joe's Pizza",
    );
  });
});
