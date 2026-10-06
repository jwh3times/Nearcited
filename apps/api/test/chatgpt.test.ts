import {
  analyzeObservation,
  defaultTuning,
  type Location,
  type TrackedQuery,
} from "@nearcited/shared";
import { describe, expect, it, vi } from "vitest";
import { createChatGptProvider, parseChatGptResponse } from "../src/providers/chatgpt";
import { createLiveProviders } from "../src/providers/live";

/**
 * Responses in the shape OpenAI documents for the Responses API with the web_search tool and a
 * JSON schema text format. They are written from the documentation, not recorded: check them
 * against a real response the first time a key is used, and correct whatever differs.
 */
const usage = {
  input_tokens: 328,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 356,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 684,
};

function apiResponse(answer: unknown, annotations: unknown[] = []) {
  return {
    id: "resp_test",
    object: "response",
    status: "completed",
    error: null,
    incomplete_details: null,
    model: "gpt-6-astra",
    output: [
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search" } },
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: typeof answer === "string" ? answer : JSON.stringify(answer),
            annotations,
            logprobs: [],
          },
        ],
      },
    ],
    store: false,
    usage,
  };
}

const cite = (url: string, start_index = 0) => ({
  type: "url_citation",
  url,
  title: "A page",
  start_index,
  end_index: start_index + 40,
});

const goodAnswer = {
  answer: "For pizza in Raleigh, try Tony's Slice House or Joe's Pizza.",
  businesses: ["Tony's Slice House", "Joe's Pizza"],
};

const location: Location = {
  id: "b0000000-0000-4000-8000-000000000001",
  organization_id: "c0000000-0000-4000-8000-000000000001",
  name: "Joe's Pizza",
  website: "https://joespizza.example",
  phone: null,
  address_line: null,
  city: "Raleigh",
  region: "NC",
  postal_code: null,
  country_code: "US",
  google_place_id: null,
  primary_category: null,
  scan_frequency: "weekly",
  last_scanned_at: null,
  created_at: "2026-10-01T00:00:00Z",
};

const query: TrackedQuery = {
  id: "d0000000-0000-4000-8000-000000000001",
  location_id: location.id,
  kind: "ai_prompt",
  text: "best pizza",
  is_active: true,
  created_at: "2026-10-01T00:00:00Z",
};

function respondWith(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => Response.json(body, { status }));
}

function provider(fetchStub: typeof fetch, onUsage?: (usage: unknown) => void) {
  return createChatGptProvider({
    apiKey: "test-key",
    tuning: defaultTuning,
    fetch: fetchStub,
    onUsage,
  });
}

const input = { location, query, at: new Date("2026-10-06T00:00:00Z") };

describe("parseChatGptResponse", () => {
  it("returns the answer, the businesses in order and the cited URLs", () => {
    const observation = parseChatGptResponse(
      apiResponse(goodAnswer, [
        cite("https://tonys.example/?utm_source=chatgpt.com", 10),
        cite("https://joespizza.example/menu?utm_source=chatgpt.com", 60),
        cite("https://tonys.example/?utm_source=chatgpt.com", 90),
      ]),
    );
    expect(observation).toEqual({
      kind: "answer",
      text: goodAnswer.answer,
      businesses: ["Tony's Slice House", "Joe's Pizza"],
      cited_urls: ["https://tonys.example/", "https://joespizza.example/menu"],
    });
  });

  it("keeps a page's own query string and only drops OpenAI's tag", () => {
    const observation = parseChatGptResponse(
      apiResponse(goodAnswer, [
        cite("https://maps.example/place?id=42&utm_source=chatgpt.com"),
        cite("https://news.example/story?utm_source=newsletter"),
      ]),
    );
    expect(observation.kind === "answer" && observation.cited_urls).toEqual([
      "https://maps.example/place?id=42",
      "https://news.example/story?utm_source=newsletter",
    ]);
  });

  it("ignores annotations that are not URL citations", () => {
    const observation = parseChatGptResponse(
      apiResponse(goodAnswer, [{ type: "file_citation", file_id: "file_1" }]),
    );
    expect(observation.kind === "answer" && observation.cited_urls).toEqual([]);
  });

  it("produces an observation the shared analysis can judge", () => {
    const finding = analyzeObservation(parseChatGptResponse(apiResponse(goodAnswer)), location);
    expect(finding).toMatchObject({
      mentioned: true,
      position: 2,
      competitors: ["Tony's Slice House"],
    });
  });

  it("accepts an answer that names no business", () => {
    const observation = parseChatGptResponse(
      apiResponse({ answer: "I could not find any.", businesses: [] }),
    );
    expect(observation.kind === "answer" && observation.businesses).toEqual([]);
  });

  it("throws when the response is incomplete, with the reason", () => {
    const incomplete = {
      ...apiResponse(goodAnswer),
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    };
    expect(() => parseChatGptResponse(incomplete)).toThrow(/incomplete, max_output_tokens/);
  });

  it("throws when the model refuses", () => {
    const refused = {
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help." }] }],
    };
    expect(() => parseChatGptResponse(refused)).toThrow(/declined/);
  });

  it("throws when there is no answer text", () => {
    expect(() => parseChatGptResponse({ status: "completed", output: [] })).toThrow(
      /no answer text/,
    );
  });

  it("throws when the answer is prose instead of JSON", () => {
    expect(() => parseChatGptResponse(apiResponse("Try Joe's Pizza."))).toThrow(/not the JSON/);
  });

  it("throws when the JSON is the wrong shape", () => {
    expect(() => parseChatGptResponse(apiResponse({ answer: "ok" }))).toThrow(/requested shape/);
  });
});

describe("createChatGptProvider", () => {
  it("sends the rendered prompt with web search, the location and the answer format", async () => {
    const fetchStub = respondWith(apiResponse(goodAnswer));
    await provider(fetchStub).observe(input);

    const [url, init] = fetchStub.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(defaultTuning.chatgpt.model);
    expect(body.input).toBe("best pizza in Raleigh, NC");
    expect(body.tools).toEqual([
      {
        type: "web_search",
        user_location: { type: "approximate", city: "Raleigh", region: "NC", country: "US" },
      },
    ]);
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(body.text.format.schema.required).toEqual(["answer", "businesses"]);
    expect(body.text.format.schema.additionalProperties).toBe(false);
    expect(body.store).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the surface's own prompt and the model from the tuning", async () => {
    const fetchStub = respondWith(apiResponse(goodAnswer));
    const tuned = createChatGptProvider({
      apiKey: "test-key",
      fetch: fetchStub,
      tuning: {
        prompts: { default: "{query}", by_surface: { chatgpt: "Near {city}: {query}" } },
        chatgpt: { model: "some-other-model" },
      },
    });
    await tuned.observe(input);
    const body = JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body));
    expect(body.input).toBe("Near Raleigh: best pizza");
    expect(body.model).toBe("some-other-model");
  });

  it("reports usage for a successful call", async () => {
    const onUsage = vi.fn();
    await provider(respondWith(apiResponse(goodAnswer)), onUsage).observe(input);
    expect(onUsage).toHaveBeenCalledWith(usage);
  });

  it("throws with the status and OpenAI's message on an error response", async () => {
    const fetchStub = respondWith(
      { error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit" } },
      429,
    );
    await expect(provider(fetchStub).observe(input)).rejects.toThrow(
      "ChatGPT request failed (429): Rate limit reached",
    );
  });

  it("throws on an error response with no readable body", async () => {
    const fetchStub = vi.fn<typeof fetch>(
      async () => new Response("<html>bad gateway</html>", { status: 502 }),
    );
    await expect(provider(fetchStub).observe(input)).rejects.toThrow(
      "ChatGPT request failed (502)",
    );
  });

  it("lets a network failure or timeout propagate", async () => {
    const fetchStub = vi.fn<typeof fetch>(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    await expect(provider(fetchStub).observe(input)).rejects.toThrow(/timed out/);
  });
});

describe("createLiveProviders", () => {
  it("registers ChatGPT only when its key is present", () => {
    expect(createLiveProviders({}, defaultTuning)).toEqual({});
    expect(createLiveProviders({ OPENAI_API_KEY: "" }, defaultTuning)).toEqual({});
    const registry = createLiveProviders({ OPENAI_API_KEY: "key" }, defaultTuning);
    expect(Object.keys(registry)).toEqual(["chatgpt"]);
    expect(registry.chatgpt?.surface).toBe("chatgpt");
  });
});
