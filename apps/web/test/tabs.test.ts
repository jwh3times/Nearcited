import { describe, expect, it } from "vitest";
import { neighbour, tabFrom, tabsFor } from "../src/lib/tabs";

describe("tabFrom", () => {
  it("reads the tab from the address, and opens the first for anything else", () => {
    expect(tabFrom("sources")).toBe("sources");
    expect(tabFrom(null)).toBe("overview");
    expect(tabFrom("billing")).toBe("overview");
  });

  it("opens the first tab when the one named is not shown", () => {
    expect(tabFrom("actions", tabsFor(false))).toBe("overview");
    expect(tabFrom("actions", tabsFor(true))).toBe("actions");
  });
});

describe("tabsFor", () => {
  it("shows Actions only for a location that has one", () => {
    expect(tabsFor(false)).not.toContain("actions");
    expect(tabsFor(true).slice(0, 3)).toEqual(["overview", "actions", "prompts"]);
  });
});

describe("neighbour", () => {
  it("steps to the next tab and wraps at both ends", () => {
    expect(neighbour("overview", 1, tabsFor(false))).toBe("prompts");
    expect(neighbour("overview", 1, tabsFor(true))).toBe("actions");
    expect(neighbour("overview", -1)).toBe("settings");
    expect(neighbour("settings", 1)).toBe("overview");
  });
});
