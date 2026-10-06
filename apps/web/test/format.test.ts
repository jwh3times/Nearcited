import { describe, expect, it } from "vitest";
import { sourceLabel } from "../src/lib/format";

describe("sourceLabel", () => {
  it("shows the site a cited page is on", () => {
    expect(sourceLabel("https://www.joespizza.example/menu?x=1")).toBe("joespizza.example");
    expect(sourceLabel("http://reviews.example")).toBe("reviews.example");
  });

  it("refuses anything that is not a web link", () => {
    expect(sourceLabel("javascript:alert(1)")).toBeNull();
    expect(sourceLabel("data:text/html,hi")).toBeNull();
    expect(sourceLabel("not a url")).toBeNull();
    expect(sourceLabel("")).toBeNull();
  });
});
