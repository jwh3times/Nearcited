import { requestToSend } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import {
  asking,
  CODE,
  CODE_WORDS,
  cardFor,
  cardPath,
  codeFileName,
  REQUEST_WORDS,
} from "../src/lib/asking";

const location = { name: "Joe's Pizza" };
const PAGE = "https://www.bbb.org/us/nc/raleigh/profile/pizza/joes-pizza-0593-1234";

describe("what a task hands its owner to ask customers with", () => {
  it("is nothing for a task that asks for no listing, as on a site that forbids asking", () => {
    expect(asking({ listing: null }, location)).toBeNull();
  });

  it("is nothing until a listing is kept, since there is no link to send", () => {
    expect(
      asking({ listing: { site: "bbb.org", url: null, review_url: null } }, location),
    ).toBeNull();
  });

  it("is made from the review form where its address is known, and never the listing beside it", () => {
    const form = `${PAGE}/leave-a-review`;
    expect(asking({ listing: { site: "bbb.org", url: PAGE, review_url: form } }, location)).toEqual(
      { business: "Joe's Pizza", site: "bbb.org", link: form },
    );
  });

  it("is made from the listing where no form address is known", () => {
    const listing = "https://www.angi.com/companylist/us/nc/raleigh/joes-pizza-reviews-1234.htm";
    expect(
      asking({ listing: { site: "angi.com", url: listing, review_url: null } }, location),
    ).toEqual({ business: "Joe's Pizza", site: "angi.com", link: listing });
  });

  it("makes a request that names the business and ends on the link the task shows", () => {
    const link = "https://g.page/r/CZx1AbCdEfGhEAE/review";
    const given = asking(
      { listing: { site: "google.com", url: link, review_url: null } },
      location,
    );
    expect(given).not.toBeNull();
    const request = requestToSend(given ?? { business: "", site: "", link: "" });
    expect(request).toContain("Thank you for choosing Joe's Pizza.");
    expect(request).toContain("a review on Google?");
    expect(request.endsWith(`\n${link}`)).toBe(true);
  });
});

describe("what the owner is told beside the request", () => {
  it("says who sends it, that every customer is asked, and that nothing is offered", () => {
    expect(REQUEST_WORDS.terms).toContain("Send it yourself");
    expect(REQUEST_WORDS.terms).toContain("every customer and not only the happy ones");
    expect(REQUEST_WORDS.terms).toContain("offer nothing in return");
  });
});

describe("how the code is drawn", () => {
  it("is black on white with clear space round it, whatever the theme", () => {
    expect(CODE.dark).toBe("#000000");
    expect(CODE.light).toBe("#ffffff");
    // The space the code's own standard asks for.
    expect(CODE.margin).toBe(4);
  });

  it("tells the owner to hand the card to every customer and to offer nothing", () => {
    expect(CODE_WORDS.card).toContain("every customer");
    expect(CODE_WORDS.card).toContain("Offer nothing in return");
  });
});

describe("where the card for a site is", () => {
  it("is under the location, in one's own account", () => {
    expect(cardPath("", "loc-1", "google.com")).toBe("/locations/loc-1/review-card/google.com");
  });

  it("stays inside a customer's account while the operator reads it", () => {
    expect(cardPath("/operator/o/org-1", "loc-1", "bbb.org")).toBe(
      "/operator/o/org-1/locations/loc-1/review-card/bbb.org",
    );
  });
});

describe("what the card for a site is made from", () => {
  const link = "https://g.page/r/CZx1AbCdEfGhEAE/review";
  const tasks = [
    { listing: null },
    { listing: { site: "bbb.org", url: null, review_url: null } },
    { listing: { site: "google.com", url: link, review_url: null } },
  ];

  it("is what the request on that site's task is made from", () => {
    expect(cardFor(tasks, location, "google.com")).toEqual({
      business: "Joe's Pizza",
      site: "google.com",
      link,
    });
  });

  it("is nothing for a site whose task holds no link yet", () => {
    expect(cardFor(tasks, location, "bbb.org")).toBeNull();
  });

  it("is nothing for a site no task asks for a listing on, whatever the address says", () => {
    expect(cardFor(tasks, location, "yelp.com")).toBeNull();
    expect(cardFor(tasks, location, "")).toBeNull();
    expect(cardFor([], location, "google.com")).toBeNull();
  });
});

describe("the name the picture of the code is saved under", () => {
  it("is the business and the site, in letters a file name can hold", () => {
    expect(codeFileName({ business: "Joe's Pizza", site: "google.com" })).toBe(
      "joes-pizza-google-review-code.png",
    );
    expect(codeFileName({ business: "  Café  Zoë & Sons, Inc. ", site: "bbb.org" })).toBe(
      "cafe-zoe-sons-inc-bbb-review-code.png",
    );
  });

  it("still names the site where the business's name has no such letters", () => {
    expect(codeFileName({ business: "寿司", site: "tripadvisor.com" })).toBe(
      "tripadvisor-review-code.png",
    );
  });
});
