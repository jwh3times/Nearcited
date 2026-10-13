import { describe, expect, it } from "vitest";
import { listingView } from "../src/lib/listings";

const asked = { listing: { site: "bbb.org", url: null, review_url: null } };
const kept = {
  listing: { site: "bbb.org", url: "https://www.bbb.org/profile/joes", review_url: null },
};

describe("what a task shows of the business's listing", () => {
  it("is nothing for a task that asks for none", () => {
    expect(listingView({ listing: null }, false)).toBe("nothing");
    expect(listingView({ listing: null }, true)).toBe("nothing");
  });

  it("is the field to paste it into until a member has given it", () => {
    expect(listingView(asked, false)).toBe("ask");
  });

  it("is the listing once one is kept, for whoever reads the task", () => {
    expect(listingView(kept, false)).toBe("kept");
    expect(listingView(kept, true)).toBe("kept");
  });

  it("asks nothing of the operator, who reads a customer's tasks and gives no listing", () => {
    expect(listingView(asked, true)).toBe("nothing");
  });
});
