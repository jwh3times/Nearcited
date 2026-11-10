import {
  OPT_OUT_SHOWN,
  RECEIPT_DROPS,
  REVIEW_FORM_SHOWN,
  REVIEW_REQUESTS_BARS,
} from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import { barNote, droppedNote, senderNote, wordingFor } from "../src/lib/review-requests";

describe("the review requests card", () => {
  it("says why they cannot be turned on, for every reason there is", () => {
    for (const bar of REVIEW_REQUESTS_BARS) expect(barNote(bar), bar).not.toBe("");
    expect(barNote("no_time_zone")).toMatch(/time zone/);
  });

  it("shows the wording a customer is sent, with where their own links go, before it is approved", () => {
    const email = wordingFor({ name: "Joe's Pizza" }, { site: "bbb.org" });
    expect(email.sender).toBe("Joe's Pizza");
    expect(email.body).toContain("Would you leave a review on BBB?");
    expect(email.body).toContain("Nearcited sends this email for Joe's Pizza.");
    expect(email.body.endsWith(OPT_OUT_SHOWN)).toBe(true);
    // Each customer's own link goes to the review form by way of the question (issue #148).
    expect(email.body).toContain(REVIEW_FORM_SHOWN);
  });

  it("says why receipts were dropped, for every reason there is, counted", () => {
    for (const reason of RECEIPT_DROPS.filter((kept) => kept !== "allowance_used")) {
      expect(droppedNote(reason, 1), reason).toMatch(/^1 receipt dropped: /);
      expect(droppedNote(reason, 3), reason).toMatch(/^3 receipts dropped: /);
    }
    expect(droppedNote("several_customers", 2)).toMatch(/more than one customer/);
    // A customer kept and then not asked, rather than a receipt dropped as it came in.
    expect(droppedNote("allowance_used", 1)).toBe(
      "1 customer not asked: this month's allowance was used.",
    );
    expect(droppedNote("allowance_used", 3)).toBe(
      "3 customers not asked: this month's allowance was used.",
    );
  });

  it("says where each sender stands", () => {
    expect(senderNote("waiting")).toBe("Waiting for a yes");
    expect(senderNote("declined")).toMatch(/dropped/);
  });
});
