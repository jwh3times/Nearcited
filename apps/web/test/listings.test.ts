import { describe, expect, it } from "vitest";
import { askWords, keptWords, listingView } from "../src/lib/listings";

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

describe("how a task asks for the listing", () => {
  it("asks for the address of the business's own page, and says how to copy one", () => {
    const words = askWords("bbb.org");
    expect(words.label).toBe("Your listing on bbb.org");
    expect(words.save).toBe("Save the listing");
    expect(words.placeholder).toBe("https://www.bbb.org/...");
    expect(words.hint).toContain("Find your business on bbb.org");
    expect(words.hint).toContain("copy the address from the top of your browser");
    expect(words.finding).toBeNull();
  });

  it("asks Google for the review link it gives, and says where that is to an owner who has not heard of it", () => {
    const words = askWords("google.com");
    expect(words.label).toBe("Your review link from Google");
    expect(words.save).toBe("Save the link");
    // Never the address of a page: that is what an owner would copy by mistake.
    expect(`${words.label} ${words.hint}`).not.toMatch(/listing|address/i);
    expect(words.finding?.about).toContain("a link that opens its review form");
    // Google's own steps, by the names its help gives them.
    expect(words.finding?.steps).toEqual([
      expect.stringContaining("business.google.com"),
      expect.stringContaining("choose Read Reviews, then Get more reviews"),
      expect.stringContaining("Choose Copy"),
    ]);
    expect(words.finding?.help.href).toBe("https://support.google.com/business/answer/16816815");
  });
});

describe("what a task says of the link it hands back", () => {
  it("says it is the review form where one was made from the listing", () => {
    expect(keptWords({ site: "bbb.org", review_url: "https://www.bbb.org/x/leave-a-review" })).toBe(
      "Where your customers write a review on bbb.org. Send them this link.",
    );
  });

  it("says it is the listing where no form address is known", () => {
    expect(keptWords({ site: "angi.com", review_url: null })).toBe(
      "Your listing on angi.com. Send customers this link, and they can write a review from that page.",
    );
  });

  it("says it is the link Google gave, and calls it nobody's listing", () => {
    expect(keptWords({ site: "google.com", review_url: null })).toBe(
      "Your review link from Google. Send customers this link.",
    );
  });
});
