import { describe, expect, it } from "vitest";
import { positionWeight, visibilityScore } from "../src/scoring";
import { defaultTuning, renderPrompt, resolveTuning, TuningSchema } from "../src/tuning";

describe("defaultTuning", () => {
  it("satisfies its own schema", () => {
    expect(TuningSchema.parse(defaultTuning)).toEqual(defaultTuning);
  });
});

describe("TuningSchema", () => {
  it("rejects weights that reward a lower rank more than a higher one", () => {
    const upsideDown = {
      ...defaultTuning,
      score: { ...defaultTuning.score, beyond: 0.9 },
    };
    expect(TuningSchema.safeParse(upsideDown).success).toBe(false);
  });

  it("rejects position steps that are out of order", () => {
    const shuffled = {
      ...defaultTuning,
      score: {
        ...defaultTuning.score,
        by_position: [
          { through: 3, weight: 1 },
          { through: 1, weight: 0.5 },
        ],
      },
    };
    expect(TuningSchema.safeParse(shuffled).success).toBe(false);
  });

  it("rejects a prompt template that drops the query", () => {
    const noQuery = { ...defaultTuning, prompts: { default: "Best places in {city}" } };
    expect(TuningSchema.safeParse(noQuery).success).toBe(false);
  });

  it("requires a ChatGPT model", () => {
    expect(TuningSchema.safeParse({ ...defaultTuning, chatgpt: { model: " " } }).success).toBe(
      false,
    );
    const { chatgpt: _chatgpt, ...withoutChatGpt } = defaultTuning;
    expect(TuningSchema.safeParse(withoutChatGpt).success).toBe(false);
  });
});

describe("resolveTuning", () => {
  it("uses the defaults when the bundle says there is no private file", () => {
    expect(resolveTuning({ source: "default" })).toEqual({
      source: "default",
      tuning: defaultTuning,
    });
  });

  it("uses a valid private file", () => {
    const tuning = { ...defaultTuning, score: { ...defaultTuning.score, unranked: 0.4 } };
    const active = resolveTuning({ source: "private", tuning });
    expect(active.source).toBe("private");
    expect(active.tuning.score.unranked).toBe(0.4);
  });

  it("throws on an invalid private file instead of falling back", () => {
    expect(() => resolveTuning({ source: "private", tuning: { score: {} } })).toThrow();
    expect(() => resolveTuning({})).toThrow();
    expect(() => resolveTuning(null)).toThrow();
  });
});

describe("scoring with tuning", () => {
  const flat = {
    unranked: 0.5,
    by_position: [{ through: 3, weight: 1 }],
    beyond: 0.25,
  };

  it("reads each position from the weights it is given", () => {
    expect(positionWeight(null, flat)).toBe(0.5);
    expect(positionWeight(1, flat)).toBe(1);
    expect(positionWeight(3, flat)).toBe(1);
    expect(positionWeight(4, flat)).toBe(0.25);
  });

  it("scores with the weights it is given", () => {
    expect(visibilityScore([{ mentioned: true, position: 4 }], flat)).toBe(25);
  });
});

describe("renderPrompt", () => {
  const values = { query: "best emergency plumber", city: "Asheville", region: "NC" };

  it("fills the default template", () => {
    expect(renderPrompt(defaultTuning.prompts, "chatgpt", values)).toBe(
      "best emergency plumber in Asheville, NC",
    );
  });

  it("prefers a surface's own template", () => {
    const prompts = { default: "{query}", by_surface: { claude: "Near {city}: {query}" } };
    expect(renderPrompt(prompts, "claude", values)).toBe("Near Asheville: best emergency plumber");
    expect(renderPrompt(prompts, "gemini", values)).toBe("best emergency plumber");
  });

  it("leaves no dangling comma when the location has no region", () => {
    expect(renderPrompt(defaultTuning.prompts, "chatgpt", { ...values, region: null })).toBe(
      "best emergency plumber in Asheville",
    );
  });

  it("leaves an unknown placeholder as written", () => {
    const prompts = { default: "{query} {mood}", by_surface: {} };
    expect(renderPrompt(prompts, "chatgpt", values)).toBe("best emergency plumber {mood}");
  });
});
