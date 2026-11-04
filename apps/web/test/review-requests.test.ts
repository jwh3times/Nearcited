import { OPT_OUT_SHOWN, REVIEW_REQUESTS_BARS } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import { barNote, wordingFor } from "../src/lib/review-requests";

describe("the review requests card", () => {
  it("says why they cannot be turned on, for every reason there is", () => {
    for (const bar of REVIEW_REQUESTS_BARS) expect(barNote(bar), bar).not.toBe("");
    expect(barNote("no_time_zone")).toMatch(/time zone/);
  });

  it("shows the wording a customer is sent, with the opt-out line, before it is approved", () => {
    const email = wordingFor(
      { name: "Joe's Pizza" },
      {
        site: "bbb.org",
        link: "https://www.bbb.org/us/nc/raleigh/profile/pizza/joes/leave-a-review",
      },
    );
    expect(email.sender).toBe("Joe's Pizza");
    expect(email.body).toContain("Would you leave a review on BBB?");
    expect(email.body).toContain("Nearcited sends this email for Joe's Pizza.");
    expect(email.body.endsWith(OPT_OUT_SHOWN)).toBe(true);
  });
});
