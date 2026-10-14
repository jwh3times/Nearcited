import type { Allowances } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import { BUILDERS, formatDay, LINE_WORDS, lineStanding, visitsOffer } from "../src/lib/visits";

describe("where an organization stands with having visits counted", () => {
  const withVisits: { allowances: Allowances }[] = [
    { allowances: { drafts: 10 } },
    { allowances: { drafts: 30, visits: true } },
  ];
  const without: { allowances: Allowances }[] = [
    { allowances: {} },
    { allowances: { drafts: 30 } },
  ];

  it("is included when its own allowances name visits, whatever is on sale", () => {
    expect(visitsOffer({ visits: true }, undefined)).toBe("included");
    expect(visitsOffer({ drafts: 5, visits: true }, without)).toBe("included");
  });

  it("is on another plan when its own do not and some plan's do", () => {
    expect(visitsOffer({}, withVisits)).toBe("on_another_plan");
    expect(visitsOffer({ drafts: 5 }, withVisits)).toBe("on_another_plan");
  });

  it("is nowhere, and so not spoken of, when no plan has it or none has loaded", () => {
    expect(visitsOffer({}, without)).toBe("nowhere");
    expect(visitsOffer({}, [])).toBe("nowhere");
    expect(visitsOffer({}, undefined)).toBe("nowhere");
    expect(visitsOffer(undefined, withVisits)).toBe("on_another_plan");
  });
});

describe("what the page says of the line", () => {
  it("names the day it last answered, which is a day in UTC wherever the reader is", () => {
    expect(formatDay("2026-10-13")).toMatch(/13/);
    expect(formatDay("2026-10-13")).toMatch(/Oct/i);
    expect(formatDay("2026-01-01")).toMatch(/1/);
    expect(formatDay("2026-01-01")).not.toMatch(/31/);
    expect(lineStanding({ checked_on: "2026-10-13" })).toBe(
      `The line answered from your site on ${formatDay("2026-10-13")}.`,
    );
  });

  it("says so when it has not answered", () => {
    expect(lineStanding({ checked_on: null })).toBe(
      "The line has not answered from your site yet.",
    );
  });
});

describe("the words around the line", () => {
  it("say what is and is not collected, and promise nothing about results", () => {
    expect(LINE_WORDS.about).toMatch(/nothing about any other visitor/);
    expect(LINE_WORDS.about).toMatch(/no cookie/);
    expect(JSON.stringify(LINE_WORDS)).not.toMatch(/guarantee|will (increase|improve|boost)/i);
  });

  it("say where the line goes for the four builders, each in a sentence or two", () => {
    expect(BUILDERS.map((builder) => builder.name)).toEqual([
      "WordPress",
      "Wix",
      "Squarespace",
      "Shopify",
    ]);
    for (const builder of BUILDERS) {
      expect(builder.where, builder.name).toMatch(/paste the line/i);
      expect(builder.where.length, builder.name).toBeLessThan(220);
    }
  });

  it("tell an owner what replacing the key costs before they do it", () => {
    expect(LINE_WORDS.confirm).toMatch(/stops counting until you paste the new one/);
    expect(LINE_WORDS.replacing).toMatch(/counts nothing until you paste the new one/);
  });
});
