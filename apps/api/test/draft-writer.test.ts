import {
  type ActiveTuning,
  type DraftGiven,
  type DraftsTuning,
  defaultTuning,
  factsNobodyGave,
} from "@nearcited/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createClaudeDraftWriter,
  createLiveDraftWriter,
  liveDraftKinds,
  setOut,
} from "../src/drafts/claude";
import type { CallUsage } from "../src/providers/types";

/**
 * A response in the shape the Messages API really returns for a request with no tools, checked
 * against a live call on 2026-10-12 (claude-sonnet-5-5). The structure and field names are real;
 * the content is invented.
 */
const usage = {
  input_tokens: 170,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  output_tokens: 303,
  output_tokens_details: { thinking_tokens: 0 },
  service_tier: "standard",
  inference_geo: "global",
};

const text = (said: string) => ({ type: "text", text: said, citations: null });

function message(content: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-sonnet-5-5",
    id: "msg_test",
    type: "message",
    role: "assistant",
    content,
    container: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage,
    ...overrides,
  };
}

const NOTE =
  "Hello,\n\nI run Joe's Pizza in Raleigh, NC. We have made wood-fired pizza since 1998.\n\nThank you.";

const given: DraftGiven = {
  name: "Joe's Pizza",
  city: "Raleigh",
  region: "NC",
  category: null,
  website: "https://joespizza.example",
  what_we_do: "Wood-fired pizza and fresh pasta, family-run since 1998.",
  host: "travel.usnews.com",
  url: null,
};

const tuning: DraftsTuning = {
  model: "claude-sonnet-5-5",
  effort: "low",
  max_tokens: 1000,
  instructions: { note: "Write a note to the author of the page." },
};

function respondWith(...bodies: Array<{ body: unknown; status?: number }>) {
  const queue = [...bodies];
  return vi.fn<typeof fetch>(async () => {
    const next = queue.shift() ?? bodies[bodies.length - 1];
    return Response.json(next?.body, { status: next?.status ?? 200 });
  });
}

const writer = (fetchStub: typeof fetch, change: Partial<DraftsTuning> = {}) =>
  createClaudeDraftWriter({
    apiKey: "test-key",
    tuning: { ...tuning, ...change },
    fetch: fetchStub,
  });

function sentBody(fetchStub: ReturnType<typeof respondWith>) {
  return JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body));
}

describe("what a model is told about the business", () => {
  it("is everything a draft is written from, set out one detail to a line", () => {
    expect(setOut({ ...given, category: "Pizza restaurant", url: "https://x.example/guide" })).toBe(
      [
        "Business name: Joe's Pizza",
        "City: Raleigh",
        "State or region: NC",
        "Category: Pizza restaurant",
        "Website: https://joespizza.example",
        "What the business does, in its owner's words: Wood-fired pizza and fresh pasta, family-run since 1998.",
        "The site: travel.usnews.com",
        "The page: https://x.example/guide",
      ].join("\n"),
    );
  });

  it("says a detail is not on file, so the model is not left to fill a blank", () => {
    const lines = setOut(given).split("\n");
    expect(lines).toContain("Category: not on file");
    expect(lines).toContain("The page: not on file");
  });

  it("adds nothing the check would not count as given", () => {
    // Everything checkable in what the model is sent is something the draft may say back.
    expect(
      factsNobodyGave(setOut({ ...given, url: "https://x.example/guide-2026" }), {
        ...given,
        url: "https://x.example/guide-2026",
      }),
    ).toEqual([]);
  });
});

describe("the Claude draft writer", () => {
  it("sends the kind's instructions and the details, to the model it is set to, with no tools", async () => {
    const fetchStub = respondWith({ body: message([text(NOTE)]) });
    await writer(fetchStub).write({ kind: "note", given });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const body = sentBody(fetchStub);
    expect(body).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 1000,
      output_config: { effort: "low" },
      system: "Write a note to the author of the page.",
      messages: [{ role: "user", content: setOut(given) }],
    });
    // It writes from what it is given and looks nothing up.
    expect(body.tools).toBeUndefined();
    expect(String(fetchStub.mock.calls[0]?.[0])).toContain("/v1/messages");
  });

  it("sends the instructions for the kind it is asked for", async () => {
    const instructions = { note: "Write a note.", listing: "Write a description." };
    const fetchStub = respondWith({ body: message([text("Joe's Pizza is in Raleigh.")]) });
    await writer(fetchStub, { instructions }).write({ kind: "listing", given });
    expect(sentBody(fetchStub).system).toBe("Write a description.");
    expect(writer(fetchStub, { instructions }).kinds).toEqual(["note", "listing"]);
  });

  it("returns the text it was given back, whole", async () => {
    const fetchStub = respondWith({ body: message([text(NOTE)]) });
    expect(await writer(fetchStub).write({ kind: "note", given })).toBe(NOTE);
  });

  it("joins the text it wrote and leaves out what is not text", async () => {
    const fetchStub = respondWith({
      body: message([
        { type: "thinking", thinking: "", signature: "sig" },
        text("Hello,\n\n"),
        text("I run Joe's Pizza."),
      ]),
    });
    expect(await writer(fetchStub).write({ kind: "note", given })).toBe(
      "Hello,\n\nI run Joe's Pizza.",
    );
  });

  it("says which model it is and which kinds it has instructions for", () => {
    const made = writer(respondWith({ body: message([]) }));
    expect(made.model).toBe("claude-sonnet-5-5");
    expect(made.kinds).toEqual(["note"]);
    expect(writer(respondWith({ body: message([]) }), { instructions: {} }).kinds).toEqual([]);
  });

  it("reports what the call used, as the model that answered counted it", async () => {
    const used: CallUsage[] = [];
    const fetchStub = respondWith({
      body: message([text(NOTE)], {
        model: "claude-sonnet-5-5-20261001",
        usage: { ...usage, cache_creation_input_tokens: 30, cache_read_input_tokens: 12 },
      }),
    });
    await writer(fetchStub).write({ kind: "note", given }, (call) => used.push(call));
    expect(used).toEqual([
      {
        model: "claude-sonnet-5-5-20261001",
        input_tokens: 200,
        cached_input_tokens: 12,
        output_tokens: 303,
        searches: 0,
      },
    ]);
  });

  it("reports a call that was charged and came to nothing, and then fails", async () => {
    for (const [overrides, said] of [
      [{ stop_reason: "refusal" }, /declined to write/],
      [{ stop_reason: "max_tokens" }, /did not finish the draft \(stop reason: max_tokens\)/],
    ] as const) {
      const used: CallUsage[] = [];
      const fetchStub = respondWith({ body: message([text("Hello, I")], overrides) });
      await expect(
        writer(fetchStub).write({ kind: "note", given }, (call) => used.push(call)),
      ).rejects.toThrow(said);
      expect(used).toHaveLength(1);
    }
  });

  it("fails with the API's own message, and reports nothing, when the request is refused", async () => {
    const used: CallUsage[] = [];
    const fetchStub = respondWith({
      status: 429,
      body: { type: "error", error: { type: "rate_limit_error", message: "Slow down." } },
    });
    await expect(
      writer(fetchStub).write({ kind: "note", given }, (call) => used.push(call)),
    ).rejects.toThrow(/Claude request failed \(429\)/);
    // Asked once: a draft that fails is not counted, and its reader asks again.
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(used).toEqual([]);
  });

  it("asks nothing for a kind it has no instructions for", async () => {
    const fetchStub = respondWith({ body: message([text(NOTE)]) });
    await expect(
      writer(fetchStub, { instructions: {} }).write({ kind: "note", given }),
    ).rejects.toThrow(/no instructions for a note draft/);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("what a build can write on real data", () => {
  const privately = (drafts: DraftsTuning | undefined): ActiveTuning => ({
    source: "private",
    tuning: { ...defaultTuning, drafts },
  });
  const key = { ANTHROPIC_API_KEY: "test-key" };

  it("is the kinds its private tuning has instructions for", () => {
    expect(liveDraftKinds(privately(tuning))).toEqual(["note"]);
    expect(liveDraftKinds(privately({ ...tuning, instructions: {} }))).toEqual([]);
    expect(liveDraftKinds(privately(undefined))).toEqual([]);
  });

  it("is nothing on the default tuning, whose instructions are a placeholder", () => {
    expect(defaultTuning.drafts?.instructions.note).toBeTruthy();
    expect(liveDraftKinds({ source: "default", tuning: defaultTuning })).toEqual([]);
    expect(
      createLiveDraftWriter(key, { source: "default", tuning: defaultTuning }),
    ).toBeUndefined();
  });

  it("needs a key as well as the instructions", () => {
    expect(createLiveDraftWriter({}, privately(tuning))).toBeUndefined();
    expect(createLiveDraftWriter(key, privately(undefined))).toBeUndefined();
    expect(createLiveDraftWriter(key, privately({ ...tuning, instructions: {} }))).toBeUndefined();
    expect(createLiveDraftWriter(key, privately(tuning))).toMatchObject({
      model: "claude-sonnet-5-5",
      kinds: ["note"],
    });
  });
});
