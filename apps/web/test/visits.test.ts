import type { Allowances } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import {
  assistantName,
  BUILDERS,
  COUNT_WORDS,
  formatDay,
  LINE_WORDS,
  lineStanding,
  visitsOf,
  visitsOffer,
  visitsShown,
} from "../src/lib/visits";

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

describe("a location's visits as its page lays them out", () => {
  const days = [
    { day: "2026-10-11", assistant: "claude", count: 2 },
    { day: "2026-10-13", assistant: "perplexity", count: 1 },
    { day: "2026-10-13", assistant: "chatgpt", count: 4 },
    { day: "2026-10-12", assistant: "chatgpt", count: 1000 },
    { day: "2026-10-12", assistant: "gemini", count: 2 },
  ];

  it("adds them up by assistant, the one with the most first, and in all", () => {
    const shown = visitsShown({ days });
    expect(shown.total).toBe(1009);
    expect(shown.assistants).toEqual([
      { assistant: "chatgpt", name: "ChatGPT", count: 1004 },
      { assistant: "claude", name: "Claude", count: 2 },
      { assistant: "gemini", name: "Gemini", count: 2 },
      { assistant: "perplexity", name: "Perplexity", count: 1 },
    ]);
  });

  it("lists the days newest first, each with who its visits came from", () => {
    expect(visitsShown({ days }).days).toEqual([
      { day: "2026-10-13", count: 5, from: "ChatGPT 4, Perplexity 1", full: false },
      { day: "2026-10-12", count: 1002, from: "ChatGPT 1,000, Gemini 2", full: true },
      { day: "2026-10-11", count: 2, from: "Claude 2", full: false },
    ]);
  });

  it("marks a day only once it has reached the most counted in a day", () => {
    const at = (count: number) =>
      visitsShown({ days: [{ day: "2026-10-13", assistant: "chatgpt", count }] }).days[0]?.full;
    expect(at(999)).toBe(false);
    expect(at(1000)).toBe(true);
  });

  it("is nothing where nothing was reported", () => {
    expect(visitsShown({ days: [] })).toEqual({ total: 0, assistants: [], days: [] });
  });

  it("names an assistant this build does not know by what the database calls it", () => {
    expect(assistantName("chatgpt")).toBe("ChatGPT");
    expect(assistantName("newcomer")).toBe("newcomer");
    expect(
      visitsShown({ days: [{ day: "2026-10-13", assistant: "newcomer", count: 3 }] }).days[0]?.from,
    ).toBe("newcomer 3");
  });
});

describe("the words around the counts", () => {
  it("say how many, in the singular for one", () => {
    expect(visitsOf(1)).toBe("1 visit");
    expect(visitsOf(1177)).toBe("1,177 visits");
    expect(COUNT_WORDS.some(1)).toBe(
      "Your site reported 1 visit from assistants in the last 30 days.",
    );
    expect(COUNT_WORDS.none).toBe(
      "Your site has reported no visit from an assistant in the last 30 days.",
    );
  });

  it("say what the count leaves out and that it can be padded, and claim no cause", () => {
    expect(COUNT_WORDS.floor).toMatch(/at least this many/);
    for (const left of ["AI Overviews", "AI Mode", "Copilot inside Bing", "block the line"]) {
      expect(COUNT_WORDS.floor, left).toContain(left);
    }
    expect(COUNT_WORDS.padded).toMatch(/made-up visits/);
    expect(COUNT_WORDS.padded).toMatch(/nothing else here is worked out from it/);
    expect(JSON.stringify(COUNT_WORDS)).not.toMatch(/because of|thanks to|caused|sent you/i);
  });

  it("say what the most counted in a day is, as the database holds it", () => {
    expect(COUNT_WORDS.full).toBe(
      "1,000 is the most counted in a day, so this day may have had more.",
    );
  });
});
