import { describe, expect, it } from "vitest";
import { suggestPrompts } from "../src/lib/onboarding";

describe("suggestPrompts", () => {
  it("writes the questions a customer would ask, from what the business is and where", () => {
    const prompts = suggestPrompts(" Pizza Restaurant ", "Raleigh");
    expect(prompts[0]).toBe("Who is the best pizza restaurant in Raleigh?");
    expect(prompts).toHaveLength(6);
    expect(new Set(prompts).size).toBe(6);
    for (const prompt of prompts) {
      expect(prompt).toContain("pizza restaurant");
      expect(prompt).toContain("Raleigh");
    }
  });

  it("suggests nothing until it knows both", () => {
    expect(suggestPrompts("", "Raleigh")).toEqual([]);
    expect(suggestPrompts("plumber", "  ")).toEqual([]);
  });
});
