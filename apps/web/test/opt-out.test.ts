import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../src/lib/api";
import { optOutPage } from "../src/lib/opt-out";

describe("the opt-out page", () => {
  it("asks for one click before anything is recorded", () => {
    const page = optOutPage("idle", null);
    expect(page.heading).toBe("Stop these review requests?");
    expect(page.body).toMatch(/every one of its locations/);
    expect(page.button).toBe("Stop these emails");
  });

  it("says it is working while the click is sent, with nothing more to click", () => {
    expect(optOutPage("pending", null)).toMatchObject({ button: null });
  });

  it("says no location of the business will ask again once it is done", () => {
    const page = optOutPage("success", null);
    expect(page.heading).toBe("You won't be asked again");
    expect(page.body).toMatch(
      /won't email you to ask for a review again, from any of its locations/,
    );
    expect(page.button).toBeNull();
  });

  it("says a link it does not know does not work, and offers nothing to retry", () => {
    const page = optOutPage(
      "error",
      new ApiRequestError(404, "not_found", "This link does not work."),
    );
    expect(page.heading).toBe("This link does not work");
    expect(page.button).toBeNull();
  });

  it("offers to try again when anything else went wrong", () => {
    const page = optOutPage("error", new Error("Failed to fetch"));
    expect(page.heading).toBe("That didn't go through");
    expect(page.button).toBe("Try again");
  });
});
