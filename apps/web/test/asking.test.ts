import { requestToSend } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import { asking, REQUEST_WORDS } from "../src/lib/asking";

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
