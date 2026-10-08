import { describe, expect, it } from "vitest";
import { neighbour, tabFrom } from "../src/lib/tabs";

describe("tabFrom", () => {
  it("reads the tab from the address, and opens the first for anything else", () => {
    expect(tabFrom("sources")).toBe("sources");
    expect(tabFrom(null)).toBe("overview");
    expect(tabFrom("billing")).toBe("overview");
  });
});

describe("neighbour", () => {
  it("steps to the next tab and wraps at both ends", () => {
    expect(neighbour("overview", 1)).toBe("prompts");
    expect(neighbour("overview", -1)).toBe("settings");
    expect(neighbour("settings", 1)).toBe("overview");
  });
});
