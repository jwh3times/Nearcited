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
 * A response in the shape the Responses API really returns for the web_search tool with a strict
 * JSON schema format, checked against live calls on 2026-10-06 (model gpt-6.1-sol). The
 * structure and field names are real; the content is invented.
 */
const usage = {
  input_tokens: 20977,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 638,
  output_tokens_details: { reasoning_tokens: 187 },
  total_tokens: 21615,
};
const tool_usage = { web_search: { num_requests: 2 } };

function apiResponse(answer: unknown, annotations: unknown[] = []) {
  const search = (id: string, query: string) => ({
    id,
    type: "web_search_call",
    status: "completed",
    action: { type: "search", query, queries: [query] },
  });
  return {
    id: "resp_test",
    object: "response",
    status: "completed",
    error: null,
    incomplete_details: null,
    model: "gpt-6.1-sol",
    service_tier: "default",
    store: false,
    output: [
      search("ws_1", "best pizza Raleigh NC"),
      search("ws_2", "Raleigh pizza reviews"),
      { id: "rs_1", type: "reasoning", content: [], encrypted_content: null, summary: [] },
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
    tools: [
      {
        type: "web_search",
        search_context_size: "medium",
        user_location: { type: "approximate", city: "Raleigh", country: "US", region: "NC" },
      },
    ],
    usage,
    tool_usage,
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

function provider(fetchStub: typeof fetch) {
  return createChatGptProvider({
    apiKey: "test-key",
    tuning: defaultTuning,
    fetch: fetchStub,
  });
}

const input = { location, query, at: new Date("2026-10-06T00:00:00Z") };

describe("parseChatGptResponse", () => {
  it("returns the answer, the businesses in order and the cited URLs", () => {
    const observation = parseChatGptResponse(
      apiResponse(goodAnswer, [
        cite("https://tonys.example/?utm_source=openai", 10),
        cite("https://joespizza.example/menu", 60),
        cite("https://tonys.example/?utm_source=openai", 90),
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

  it("uses the surface's own prompt, and the model and effort from the tuning", async () => {
    const fetchStub = respondWith(apiResponse(goodAnswer));
    const tuned = createChatGptProvider({
      apiKey: "test-key",
      fetch: fetchStub,
      tuning: {
        prompts: { default: "{query}", by_surface: { chatgpt: "Near {city}: {query}" } },
        chatgpt: { model: "some-other-model", effort: "high" },
      },
    });
    await tuned.observe(input);
    const body = JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body));
    expect(body.input).toBe("Near Raleigh: best pizza");
    expect(body.model).toBe("some-other-model");
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("tells the caller what the call used, in the form every provider reports it", async () => {
    const used = vi.fn();
    await provider(respondWith(apiResponse(goodAnswer))).observe({ ...input, onUsage: used });
    expect(used).toHaveBeenCalledExactlyOnceWith({
      model: "gpt-6.1-sol",
      input_tokens: 20977,
      cached_input_tokens: 0,
      output_tokens: 638,
      searches: 2,
    });
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
