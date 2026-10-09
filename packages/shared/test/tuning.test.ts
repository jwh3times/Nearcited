import { describe, expect, it } from "vitest";
import { positionWeight, visibilityScore } from "../src/scoring";
import {
  defaultTuning,
  rateFor,
  renderPrompt,
  resolveTuning,
  TuningSchema,
  usageCost,
} from "../src/tuning";

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

  it("requires a ChatGPT model and a known effort", () => {
    const chatgpt = (change: object) => ({
      ...defaultTuning,
      chatgpt: { ...defaultTuning.chatgpt, ...change },
    });
    expect(TuningSchema.safeParse(chatgpt({ model: " " })).success).toBe(false);
    expect(TuningSchema.safeParse(chatgpt({ effort: "extreme" })).success).toBe(false);
    expect(TuningSchema.safeParse(chatgpt({ effort: undefined })).success).toBe(false);
    expect(TuningSchema.safeParse(chatgpt({ effort: "high" })).success).toBe(true);
    const { chatgpt: _chatgpt, ...withoutChatGpt } = defaultTuning;
    expect(TuningSchema.safeParse(withoutChatGpt).success).toBe(false);
  });

  it("requires a Claude model, a known effort and a whole number of searches", () => {
    const claude = (change: object) => ({
      ...defaultTuning,
      claude: { ...defaultTuning.claude, ...change },
    });
    expect(TuningSchema.safeParse(claude({ model: "" })).success).toBe(false);
    expect(TuningSchema.safeParse(claude({ effort: "extreme" })).success).toBe(false);
    expect(TuningSchema.safeParse(claude({ max_searches: 0 })).success).toBe(false);
    expect(TuningSchema.safeParse(claude({ max_searches: 1.5 })).success).toBe(false);
    expect(TuningSchema.safeParse(claude({ effort: "high", max_searches: 3 })).success).toBe(true);
    const { claude: _claude, ...withoutClaude } = defaultTuning;
    expect(TuningSchema.safeParse(withoutClaude).success).toBe(false);
  });
});

describe("rates", () => {
  const rate = {
    input_per_million: 2,
    cached_input_per_million: 0.5,
    output_per_million: 10,
    per_thousand_searches: 10,
  };
  const rates = { "model-a": rate, "model-a-mini": { ...rate, input_per_million: 1 } };
  const usage = {
    surface: "chatgpt" as const,
    model: "model-a",
    calls: 3,
    input_tokens: 500_000,
    cached_input_tokens: 200_000,
    output_tokens: 100_000,
    searches: 4,
  };

  it("prices nothing by default", () => {
    expect(defaultTuning.rates).toEqual({});
  });

  it("requires every price, and none below zero", () => {
    const withRates = (change: object) => ({
      ...defaultTuning,
      rates: { "model-a": { ...rate, ...change } },
    });
    expect(TuningSchema.safeParse(withRates({})).success).toBe(true);
    expect(TuningSchema.safeParse(withRates({ output_per_million: -1 })).success).toBe(false);
    expect(TuningSchema.safeParse(withRates({ per_thousand_searches: undefined })).success).toBe(
      false,
    );
    const { rates: _rates, ...withoutRates } = defaultTuning;
    expect(TuningSchema.safeParse(withoutRates).success).toBe(false);
  });

  it("finds a model by its name", () => {
    expect(rateFor(rates, "model-a")).toEqual(rate);
    expect(rateFor(rates, "model-b")).toBeNull();
  });

  it("finds a dated snapshot by the longest name it starts with", () => {
    expect(rateFor(rates, "model-a-2026-08-01")).toEqual(rate);
    expect(rateFor(rates, "model-a-mini-2026-08-01")?.input_per_million).toBe(1);
    expect(rateFor(rates, "model-abc")).toBeNull();
  });

  it("costs tokens by the million and searches by the thousand", () => {
    // 0.5 x $2 + 0.2 x $0.50 + 0.1 x $10 + 4 x $0.01
    expect(usageCost(rates, usage)).toBeCloseTo(2.14, 10);
  });

  it("gives no cost for a model without a rate", () => {
    expect(usageCost(rates, { ...usage, model: "model-b" })).toBeNull();
    expect(usageCost({}, usage)).toBeNull();
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
