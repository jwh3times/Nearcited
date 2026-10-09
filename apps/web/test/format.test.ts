import { describe, expect, it } from "vitest";
import {
  businessKey,
  cadence,
  formatDollars,
  formatMonth,
  listOf,
  plainText,
  sourceLabel,
} from "../src/lib/format";

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

describe("cadence", () => {
  it("follows the plan, and lets a location ask for less", () => {
    expect(cadence(1, "daily")).toBe("daily");
    expect(cadence(2, "daily")).toBe("every 2 days");
    expect(cadence(7, "daily")).toBe("weekly");
    expect(cadence(1, "weekly")).toBe("weekly");
    // A location cannot ask for more than its plan allows.
    expect(cadence(14, "weekly")).toBe("every 14 days");
  });
});

describe("listOf", () => {
  it("joins names the way a sentence would", () => {
    expect(listOf([])).toBe("");
    expect(listOf(["ChatGPT"])).toBe("ChatGPT");
    expect(listOf(["ChatGPT", "Claude"])).toBe("ChatGPT and Claude");
    expect(listOf(["ChatGPT", "Claude", "Perplexity"])).toBe("ChatGPT, Claude and Perplexity");
  });
});

describe("plainText", () => {
  it("drops Markdown emphasis marks and keeps the words", () => {
    expect(plainText("1. **Joe's Pizza** is __the__ pick, 2 * 3")).toBe(
      "1. Joe's Pizza is the pick, 2 * 3",
    );
  });
});

describe("businessKey", () => {
  it("treats a name with and without its legal ending as one business", () => {
    expect(businessKey("Tony's Slice House, LLC")).toBe(businessKey("tony's slice house"));
    expect(businessKey("Oak Realty Inc.")).toBe("oak realty");
    expect(businessKey("Oak Realty, L.L.C.")).toBe("oak realty");
  });

  it("strips only a trailing ending, never a whole or partial word", () => {
    expect(businessKey("Pizza Co")).toBe("pizza");
    expect(businessKey("Inc")).toBe("inc");
    expect(businessKey("Coco")).toBe("coco");
  });
});

describe("formatDollars", () => {
  it("shows dollars to the cent, and never hides a small amount as nothing", () => {
    expect(formatDollars(0)).toBe("$0.00");
    expect(formatDollars(1234.5)).toBe("$1,234.50");
    expect(formatDollars(0.0049)).toBe("under $0.01");
    expect(formatDollars(0.005)).toBe("$0.01");
  });
});

describe("formatMonth", () => {
  it("names a month whatever time zone the reader is in", () => {
    expect(formatMonth("2026-10")).toBe("October 2026");
    expect(formatMonth("2026-01")).toBe("January 2026");
  });
});
