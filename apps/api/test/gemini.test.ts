import {
  analyzeObservation,
  defaultTuning,
  type Location,
  type TrackedQuery,
} from "@nearcited/shared";
import { describe, expect, it, vi } from "vitest";
import { createGeminiProvider, parseGeminiInteraction } from "../src/providers/gemini";
import { createLiveProviders } from "../src/providers/live";

/**
 * Responses in the shape Google documents for the Interactions API with the google_search tool
 * and a JSON response format. They are written from the documentation, not recorded: replace
 * them with a recorded response the first time a real key is used.
 */
function interaction(answer: unknown, annotations: unknown[] = []) {
  return {
    id: "v1_test",
    object: "interaction",
    model: "gemini-3.8-flash",
    status: "completed",
    steps: [
      { type: "thought", signature: "abc" },
      { type: "google_search_call", arguments: { queries: ["best pizza raleigh nc"] } },
      {
        type: "google_search_result",
        call_id: "search_001",
        result: [{ search_suggestions: "<div/>" }],
      },
      {
        type: "model_output",
        content: [
          {
            type: "text",
            text: typeof answer === "string" ? answer : JSON.stringify(answer),
            annotations,
          },
        ],
      },
    ],
    usage: { total_input_tokens: 120, total_output_tokens: 240 },
  };
}

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
  return createGeminiProvider({
    apiKey: "test-key",
    tuning: defaultTuning,
    fetch: fetchStub,
    onUsage,
  });
}

describe("parseGeminiInteraction", () => {
  it("returns the answer, the businesses in order and the cited URLs", () => {
    const observation = parseGeminiInteraction(
      interaction(goodAnswer, [
        { type: "url_citation", url: "https://joespizza.example/menu", title: "Joe's Pizza" },
        { type: "url_citation", url: "https://tonys.example", title: "tonys.example" },
        { type: "url_citation", url: "https://joespizza.example/menu", title: "Joe's Pizza" },
      ]),
    );
    expect(observation).toEqual({
      kind: "answer",
      text: goodAnswer.answer,
      businesses: ["Tony's Slice House", "Joe's Pizza"],
      cited_urls: ["https://joespizza.example/menu", "https://tonys.example"],
    });
  });

  it("uses the site named in the title when the citation is a Google redirect", () => {
    const observation = parseGeminiInteraction(
      interaction(goodAnswer, [
        {
          type: "url_citation",
          url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc",
          title: "JoesPizza.example",
        },
      ]),
    );
    expect(observation.kind === "answer" && observation.cited_urls).toEqual([
      "https://joespizza.example",
    ]);
  });

  it("produces an observation the shared analysis can judge", () => {
    const finding = analyzeObservation(parseGeminiInteraction(interaction(goodAnswer)), location);
    expect(finding).toMatchObject({
      mentioned: true,
      position: 2,
      competitors: ["Tony's Slice House"],
    });
  });

  it("accepts an answer that names no business", () => {
    const observation = parseGeminiInteraction(
      interaction({ answer: "I could not find any.", businesses: [] }),
    );
    expect(observation.kind === "answer" && observation.businesses).toEqual([]);
  });

  it("throws when the request did not complete", () => {
    expect(() => parseGeminiInteraction({ ...interaction(goodAnswer), status: "failed" })).toThrow(
      /status: failed/,
    );
  });

  it("throws when there is no answer text", () => {
    expect(() => parseGeminiInteraction({ status: "completed", steps: [] })).toThrow(
      /no answer text/,
    );
  });

  it("throws when the answer is prose instead of JSON", () => {
    expect(() => parseGeminiInteraction(interaction("Try Joe's Pizza."))).toThrow(/not the JSON/);
  });

  it("throws when the JSON is the wrong shape", () => {
    expect(() => parseGeminiInteraction(interaction({ answer: "ok" }))).toThrow(/requested shape/);
  });
});

describe("createGeminiProvider", () => {
  it("sends the rendered prompt with search grounding and the response schema", async () => {
    const fetchStub = respondWith(interaction(goodAnswer));
    await provider(fetchStub).observe({ location, query, at: new Date() });

    const [url, init] = fetchStub.mock.calls[0] ?? [];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("test-key");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(defaultTuning.gemini.model);
    expect(body.input).toBe("best pizza in Raleigh, NC");
    expect(body.tools).toEqual([{ type: "google_search" }]);
    expect(body.response_format.mime_type).toBe("application/json");
    expect(body.response_format.schema.required).toEqual(["answer", "businesses"]);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the surface's own prompt and the model from the tuning", async () => {
    const fetchStub = respondWith(interaction(goodAnswer));
    const tuned = createGeminiProvider({
      apiKey: "test-key",
      fetch: fetchStub,
      tuning: {
        prompts: { default: "{query}", by_surface: { gemini: "Near {city}: {query}" } },
        gemini: { model: "some-other-model" },
      },
    });
    await tuned.observe({ location, query, at: new Date() });
    const body = JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body));
    expect(body.input).toBe("Near Raleigh: best pizza");
    expect(body.model).toBe("some-other-model");
  });

  it("reports usage for a successful call", async () => {
    const onUsage = vi.fn();
    await provider(respondWith(interaction(goodAnswer)), onUsage).observe({
      location,
      query,
      at: new Date(),
    });
    expect(onUsage).toHaveBeenCalledWith({ total_input_tokens: 120, total_output_tokens: 240 });
  });

  it("throws with the status and Google's message on an error response", async () => {
    const fetchStub = respondWith(
      { error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } },
      429,
    );
    await expect(provider(fetchStub).observe({ location, query, at: new Date() })).rejects.toThrow(
      "Gemini request failed (429): Quota exceeded",
    );
  });

  it("throws on an error response with no readable body", async () => {
    const fetchStub = vi.fn<typeof fetch>(
      async () => new Response("<html>bad gateway</html>", { status: 502 }),
    );
    await expect(provider(fetchStub).observe({ location, query, at: new Date() })).rejects.toThrow(
      "Gemini request failed (502)",
    );
  });

  it("lets a network failure or timeout propagate", async () => {
    const fetchStub = vi.fn<typeof fetch>(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    await expect(provider(fetchStub).observe({ location, query, at: new Date() })).rejects.toThrow(
      /timed out/,
    );
  });
});

describe("createLiveProviders", () => {
  it("registers Gemini only when its key is present", () => {
    expect(createLiveProviders({}, defaultTuning)).toEqual({});
    expect(createLiveProviders({ GEMINI_API_KEY: "" }, defaultTuning)).toEqual({});
    const registry = createLiveProviders({ GEMINI_API_KEY: "key" }, defaultTuning);
    expect(Object.keys(registry)).toEqual(["gemini"]);
    expect(registry.gemini?.surface).toBe("gemini");
  });
});
