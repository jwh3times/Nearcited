import {
  analyzeObservation,
  defaultTuning,
  type Location,
  type TrackedQuery,
} from "@nearcited/shared";
import { describe, expect, it, vi } from "vitest";
import { checkedSurfaces } from "../src/providers";
import { createClaudeProvider, parseClaudeContent } from "../src/providers/claude";
import { createLiveProviders } from "../src/providers/live";

/**
 * Responses in the shape the Messages API really returns for the web_search tool called directly
 * with a JSON output format, checked against live calls on 2026-10-06 (claude-opus-5-5 and
 * claude-sonnet-5-5).
 * The structure and field names are real; the content is invented.
 */
const usage = {
  input_tokens: 22591,
  output_tokens: 1566,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
};

const search = (id: string, query: string) => ({
  type: "server_tool_use",
  id,
  name: "web_search",
  input: { query },
  caller: { type: "direct" },
});

const results = (id: string, urls: string[]) => ({
  type: "web_search_tool_result",
  tool_use_id: id,
  caller: { type: "direct" },
  content: urls.map((url) => ({
    type: "web_search_result",
    url,
    title: "A page",
    encrypted_content: "abc",
    page_age: null,
  })),
});

const text = (answer: unknown) => ({
  type: "text",
  text: typeof answer === "string" ? answer : JSON.stringify(answer),
  citations: null,
});

function message(content: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage,
    ...overrides,
  };
}

const goodAnswer = {
  answer: "For pizza in Raleigh, try Tony's Slice House or Joe's Pizza.",
  businesses: ["Tony's Slice House", "Joe's Pizza"],
  sources: ["https://tonys.example/", "https://joespizza.example/menu"],
};

const searched = [
  search("srvtoolu_1", "best pizza Raleigh NC"),
  results("srvtoolu_1", ["https://tonys.example/", "https://reviews.example/raleigh-pizza"]),
  search("srvtoolu_2", "Joe's Pizza Raleigh"),
  results("srvtoolu_2", ["https://joespizza.example/menu"]),
  { type: "thinking", thinking: "", signature: "sig" },
];

// biome-ignore lint/suspicious/noExplicitAny: fixtures are plain JSON in the API's shape
const blocks = (content: unknown[]) => content as any;

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

const input = { location, query, at: new Date("2026-10-06T00:00:00Z") };

function respondWith(...bodies: Array<{ body: unknown; status?: number }>) {
  const queue = [...bodies];
  return vi.fn<typeof fetch>(async () => {
    const next = queue.shift() ?? bodies[bodies.length - 1];
    return Response.json(next?.body, { status: next?.status ?? 200 });
  });
}

function provider(fetchStub: typeof fetch) {
  return createClaudeProvider({
    apiKey: "test-key",
    tuning: defaultTuning,
    fetch: fetchStub,
  });
}

function sentBody(fetchStub: ReturnType<typeof respondWith>, call = 0) {
  return JSON.parse(String(fetchStub.mock.calls[call]?.[1]?.body));
}

describe("parseClaudeContent", () => {
  it("returns the answer, the businesses in order and the sources", () => {
    expect(parseClaudeContent(blocks([...searched, text(goodAnswer)]))).toEqual({
      kind: "answer",
      text: goodAnswer.answer,
      businesses: ["Tony's Slice House", "Joe's Pizza"],
      cited_urls: ["https://tonys.example/", "https://joespizza.example/menu"],
    });
  });

  it("drops a source the search never returned", () => {
    const invented = {
      ...goodAnswer,
      sources: ["https://made-up.example/", "https://tonys.example/", "https://tonys.example/"],
    };
    const observation = parseClaudeContent(blocks([...searched, text(invented)]));
    expect(observation.kind === "answer" && observation.cited_urls).toEqual([
      "https://tonys.example/",
    ]);
  });

  it("ignores a search that failed and keeps the ones that worked", () => {
    const failed = {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_3",
      content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
    };
    const observation = parseClaudeContent(blocks([...searched, failed, text(goodAnswer)]));
    expect(observation.kind === "answer" && observation.cited_urls).toHaveLength(2);
  });

  it("produces an observation the shared analysis can judge", () => {
    const finding = analyzeObservation(
      parseClaudeContent(blocks([...searched, text(goodAnswer)])),
      location,
    );
    expect(finding).toMatchObject({
      mentioned: true,
      position: 2,
      competitors: ["Tony's Slice House"],
    });
  });

  it("throws when there is no answer text", () => {
    expect(() => parseClaudeContent(blocks(searched))).toThrow(/no answer text/);
  });

  it("throws when the answer is prose instead of JSON", () => {
    expect(() => parseClaudeContent(blocks([text("Try Joe's Pizza.")]))).toThrow(/not the JSON/);
  });

  it("throws when the JSON is the wrong shape", () => {
    expect(() => parseClaudeContent(blocks([text({ answer: "ok", businesses: [] })]))).toThrow(
      /requested shape/,
    );
  });
});

describe("createClaudeProvider", () => {
  it("sends the rendered prompt with direct web search, the location and the answer format", async () => {
    const fetchStub = respondWith({ body: message([...searched, text(goodAnswer)]) });
    await provider(fetchStub).observe(input);

    const [url, init] = fetchStub.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages?beta=true");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe("test-key");
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");

    const body = sentBody(fetchStub);
    expect(body.model).toBe(defaultTuning.claude.model);
    expect(body.messages).toEqual([{ role: "user", content: "best pizza in Raleigh, NC" }]);
    expect(body.fallbacks).toBe("default");
    expect(body.tools).toEqual([
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: defaultTuning.claude.max_searches,
        allowed_callers: ["direct"],
        user_location: { type: "approximate", city: "Raleigh", region: "NC", country: "US" },
      },
    ]);
    expect(body.output_config.effort).toBe(defaultTuning.claude.effort);
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.format.schema.required).toEqual(["answer", "businesses", "sources"]);
    // Thinking is always on for this model, and forcing a tool is rejected: send neither.
    expect(body.thinking).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("uses the surface's own prompt and the model, effort and search cap from the tuning", async () => {
    const fetchStub = respondWith({ body: message([text(goodAnswer)]) });
    const tuned = createClaudeProvider({
      apiKey: "test-key",
      fetch: fetchStub,
      tuning: {
        prompts: { default: "{query}", by_surface: { claude: "Near {city}: {query}" } },
        claude: { model: "some-other-model", effort: "high", max_searches: 4 },
      },
    });
    await tuned.observe(input);
    const body = sentBody(fetchStub);
    expect(body.messages[0].content).toBe("Near Raleigh: best pizza");
    expect(body.model).toBe("some-other-model");
    expect(body.output_config.effort).toBe("high");
    expect(body.tools[0].max_uses).toBe(4);
  });

  it("resumes a paused turn by sending it back, and uses the content of both parts", async () => {
    const paused = message(searched.slice(0, 2), { stop_reason: "pause_turn" });
    const finished = message([...searched.slice(2), text(goodAnswer)]);
    const fetchStub = respondWith({ body: paused }, { body: finished });

    const observation = await provider(fetchStub).observe(input);

    expect(fetchStub).toHaveBeenCalledTimes(2);
    const resumed = sentBody(fetchStub, 1);
    expect(resumed.messages).toHaveLength(2);
    expect(resumed.messages[1].role).toBe("assistant");
    expect(resumed.messages[1].content).toEqual(paused.content);
    // One source came back before the pause and one after.
    expect(observation.kind === "answer" && observation.cited_urls).toEqual(goodAnswer.sources);
  });

  it("gives up when the turn keeps pausing", async () => {
    const fetchStub = respondWith({ body: message(searched, { stop_reason: "pause_turn" }) });
    await expect(provider(fetchStub).observe(input)).rejects.toThrow(/paused the search/);
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it("throws on a refusal, with its category", async () => {
    const refused = message([], {
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: null },
    });
    await expect(provider(respondWith({ body: refused })).observe(input)).rejects.toThrow(
      "Claude declined to answer the prompt (cyber).",
    );
  });

  it("throws when the answer was cut off", async () => {
    const cut = message([text('{"answer": "For pizza')], { stop_reason: "max_tokens" });
    await expect(provider(respondWith({ body: cut })).observe(input)).rejects.toThrow(
      /stop reason: max_tokens/,
    );
  });

  it("tells the caller what the call used, in the form every provider reports it", async () => {
    const used = vi.fn();
    const fetchStub = respondWith({ body: message([text(goodAnswer)]) });
    await provider(fetchStub).observe({ ...input, onUsage: used });
    expect(used).toHaveBeenCalledExactlyOnceWith({
      model: "claude-sonnet-5-5",
      input_tokens: 22591,
      cached_input_tokens: 0,
      output_tokens: 1566,
      searches: 2,
    });
  });

  it("reports what a refused answer used, because it was still charged for", async () => {
    const used = vi.fn();
    const refused = message([], { stop_reason: "refusal" });
    await expect(
      provider(respondWith({ body: refused })).observe({ ...input, onUsage: used }),
    ).rejects.toThrow(/declined/);
    expect(used).toHaveBeenCalledOnce();
  });

  it("throws with the status and Anthropic's message on an error response, without retrying", async () => {
    const fetchStub = respondWith({
      status: 429,
      body: { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
    });
    await expect(provider(fetchStub).observe(input)).rejects.toThrow(
      /Claude request failed \(429\).*Rate limited/,
    );
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("reports a network failure as a connection error", async () => {
    const fetchStub = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(provider(fetchStub).observe(input)).rejects.toThrow(
      /Claude request failed to connect/,
    );
  });
});

describe("createLiveProviders with Claude", () => {
  it("registers Claude only when its key is present, alongside ChatGPT", () => {
    expect(createLiveProviders({ ANTHROPIC_API_KEY: "" }, defaultTuning)).toEqual({});
    const claudeOnly = createLiveProviders({ ANTHROPIC_API_KEY: "key" }, defaultTuning);
    expect(Object.keys(claudeOnly)).toEqual(["claude"]);
    const both = createLiveProviders(
      { OPENAI_API_KEY: "key", ANTHROPIC_API_KEY: "key" },
      defaultTuning,
    );
    expect(Object.keys(both).sort()).toEqual(["chatgpt", "claude"]);
  });

  it("reports the same surfaces a scan would check", () => {
    const live = { PROVIDER_MODE: "live" };
    expect(checkedSurfaces(live)).toEqual([]);
    expect(checkedSurfaces({ ...live, ANTHROPIC_API_KEY: "key" })).toEqual(["claude"]);
    const both = { ...live, OPENAI_API_KEY: "key", ANTHROPIC_API_KEY: "key" };
    expect(checkedSurfaces(both)).toEqual(Object.keys(createLiveProviders(both, defaultTuning)));
    // Sample data covers every surface, whatever keys are set.
    expect(checkedSurfaces({ PROVIDER_MODE: "mock" })).toHaveLength(7);
  });
});
