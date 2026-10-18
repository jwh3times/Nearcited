import {
  analyzeObservation,
  defaultTuning,
  type Location,
  type TrackedQuery,
} from "@nearcited/shared";
import { describe, expect, it, vi } from "vitest";
import { createDataForSeoProviders } from "../src/providers/dataforseo";
import type { CallUsage } from "../src/providers/types";

/**
 * Responses in the shape DataForSEO's live SERP endpoints document for Google's results page,
 * Local Finder and AI Mode (docs.dataforseo.com, read 2026-10-17). The structure and field names
 * are theirs; the businesses, the text and the costs are invented.
 */
function envelope(items: unknown[] | null, status_code = 20000, status_message = "Ok.") {
  return {
    version: "0.1.20261001",
    status_code: 20000,
    status_message: "Ok.",
    time: "1.2 sec.",
    cost: 0.001,
    tasks_count: 1,
    tasks_error: status_code === 20000 ? 0 : 1,
    tasks: [
      {
        id: "10171200-1234-0139-0000-2f2b1a1c0d0e",
        status_code,
        status_message,
        time: "1.1 sec.",
        cost: status_code === 20000 ? 0.001 : 0,
        result_count: items ? 1 : 0,
        path: ["v3", "serp", "google", "organic", "live", "advanced"],
        data: {},
        result:
          items === null
            ? null
            : [
                {
                  keyword: "pizza near me",
                  type: "organic",
                  se_domain: "google.com",
                  location_code: null,
                  language_code: "en",
                  check_url: "https://www.google.com/search?q=pizza+near+me",
                  datetime: "2026-10-17 12:00:00 +00:00",
                  item_types: [...new Set(items.map((item) => (item as { type: string }).type))],
                  se_results_count: 1000,
                  items_count: items.length,
                  items,
                },
              ],
      },
    ],
  };
}

const organic = (rank: number, domain: string, website_name: string | null) => ({
  type: "organic",
  rank_group: rank,
  rank_absolute: rank + 1,
  page: 1,
  position: "left",
  domain,
  title: `${website_name ?? domain}: pizza near you`,
  url: `https://${domain}/pizza`,
  website_name,
  description: "Pizza.",
});

const overview = {
  type: "ai_overview",
  rank_group: 1,
  rank_absolute: 1,
  position: "left",
  asynchronous_ai_overview: true,
  markdown: "For pizza near you, **Tony's Slice House** and **Joe's Pizza** are well reviewed.",
  items: [
    {
      type: "ai_overview_element",
      title: null,
      text: "For pizza near you, Tony's Slice House and Joe's Pizza are well reviewed.",
      markdown: "For pizza near you, **Tony's Slice House** and **Joe's Pizza** are well reviewed.",
      references: [
        {
          type: "ai_overview_reference",
          source: "Joe's Pizza",
          domain: "joespizza.example",
          url: "https://joespizza.example/menu",
          title: "Menu",
          text: null,
        },
      ],
    },
  ],
  references: [
    {
      type: "ai_overview_reference",
      source: "Yelp",
      domain: "yelp.example",
      url: "https://yelp.example/raleigh-pizza",
      title: "The best pizza in Raleigh",
      text: null,
    },
  ],
};

const resultsPage = (withOverview: boolean) =>
  envelope([
    ...(withOverview ? [overview] : []),
    organic(1, "yelp.example", "Yelp"),
    organic(2, "joespizza.example", "Joe's Pizza"),
    organic(3, "tonys.example", null),
  ]);

const place = (rank: number, title: string, domain: string | null, is_paid = false) => ({
  type: "local_pack",
  rank_group: rank,
  rank_absolute: rank,
  position: "left",
  title,
  description: "Pizza restaurant",
  domain,
  phone: "+1 919-555-0100",
  url: domain ? `https://${domain}/` : null,
  is_paid,
  rating: { rating_type: "Max5", value: 4.6, votes_count: 210, rating_max: null },
  cid: `${rank}0000000000000000000`,
});

const localFinder = envelope([
  place(1, "Ad Pizza", "adpizza.example", true),
  place(1, "Tony's Slice House", "tonys.example"),
  place(2, "Joe's Pizza", "joespizza.example"),
  place(3, "Capital Slice", null),
]);

const aiMode = envelope([
  {
    type: "ai_overview",
    rank_group: 1,
    rank_absolute: 1,
    position: "left",
    markdown: "Try **Capital Slice** downtown, or Joe's Pizza on Main Street.",
    items: [
      {
        type: "ai_overview_element",
        text: "Try Capital Slice downtown, or Joe's Pizza on Main Street.",
        markdown: "Try **Capital Slice** downtown, or Joe's Pizza on Main Street.",
        references: [
          {
            type: "ai_overview_reference",
            source: "Raleigh Eats",
            domain: "raleigheats.example",
            url: "https://raleigheats.example/slices",
            title: "Slices",
            text: null,
          },
        ],
      },
    ],
    references: [],
  },
]);

const location: Location = {
  id: "b0000000-0000-4000-8000-000000000001",
  organization_id: "c0000000-0000-4000-8000-000000000001",
  name: "Joe's Pizza",
  website: "https://joespizza.example",
  phone: null,
  address_line: "1 Main St",
  city: "Raleigh",
  region: "NC",
  postal_code: "27601",
  country_code: "US",
  google_place_id: null,
  latitude: 35.7795897,
  longitude: -78.6381787,
  point_source: "address",
  geocoded_from: "1 Main St, Raleigh, NC 27601, US",
  primary_category: null,
  what_we_do: null,
  paused_by_plan: false,
  last_scanned_at: null,
  created_at: "2026-10-01T00:00:00Z",
};

const query: TrackedQuery = {
  id: "d0000000-0000-4000-8000-000000000001",
  location_id: location.id,
  kind: "search_keyword",
  text: "pizza near me",
  is_active: true,
  set_aside_by_plan: false,
  created_at: "2026-10-01T00:00:00Z",
};

const at = new Date("2026-10-17T12:00:00Z");

/** A fake DataForSEO answering each endpoint with its recorded response. */
function vendor(page = resultsPage(true)) {
  return vi.fn<typeof fetch>(async (url) => {
    const path = String(url);
    if (path.endsWith("/serp/google/organic/live/advanced")) return Response.json(page);
    if (path.endsWith("/serp/google/local_finder/live/advanced")) return Response.json(localFinder);
    if (path.endsWith("/serp/google/ai_mode/live/advanced")) return Response.json(aiMode);
    return new Response("not found", { status: 404 });
  });
}

function providers(fetchStub: typeof fetch) {
  return createDataForSeoProviders({
    login: "login@example.com",
    password: "secret",
    tuning: defaultTuning,
    fetch: fetchStub,
  });
}

/** What one surface saw and recorded, for one keyword. */
async function check(
  surface: "google_local_pack" | "google_organic" | "google_ai_overview" | "google_ai_mode",
  fetchStub: typeof fetch = vendor(),
) {
  const used: CallUsage[] = [];
  const provider = providers(fetchStub)[surface];
  if (!provider) throw new Error(`no ${surface} provider`);
  const observation = await provider.observe({
    location,
    query,
    at,
    onUsage: (call) => used.push(call),
  });
  return { observation, used };
}

function sent(fetchStub: ReturnType<typeof vendor>, endpoint: string) {
  const call = fetchStub.mock.calls.find(([url]) => String(url).includes(`/google/${endpoint}/`));
  if (!call) throw new Error(`nothing sent to ${endpoint}`);
  const [url, init] = call;
  return {
    url: String(url),
    headers: new Headers(init?.headers),
    task: (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0],
  };
}

describe("the DataForSEO provider", () => {
  it("is one provider for each Google surface", () => {
    expect(Object.keys(providers(vendor())).sort()).toEqual([
      "google_ai_mode",
      "google_ai_overview",
      "google_local_pack",
      "google_organic",
    ]);
  });

  it("asks Google's results page from the location's point, with the AI Overview loaded", async () => {
    const fetchStub = vendor();
    await check("google_organic", fetchStub);
    const { url, headers, task } = sent(fetchStub, "organic");
    expect(url).toBe("https://api.dataforseo.com/v3/serp/google/organic/live/advanced");
    expect(headers.get("authorization")).toBe(`Basic ${btoa("login@example.com:secret")}`);
    expect(task).toEqual({
      keyword: "pizza near me",
      location_coordinate: "35.7795897,-78.6381787,1000",
      language_code: "en",
      depth: 10,
      load_async_ai_overview: true,
    });
  });

  it("reads the organic results as a ranking, by site", async () => {
    const { observation, used } = await check("google_organic");
    expect(observation).toEqual({
      kind: "ranking",
      entries: [
        { name: "Yelp", website: "https://yelp.example/pizza", place_id: null },
        { name: "Joe's Pizza", website: "https://joespizza.example/pizza", place_id: null },
        { name: "tonys.example", website: "https://tonys.example/pizza", place_id: null },
      ],
    });
    expect(analyzeObservation(observation, location, "google_organic")).toMatchObject({
      mentioned: true,
      position: 2,
    });
    expect(used).toEqual([search("dataforseo/organic", 1)]);
  });

  it("reads the AI Overview from the same page, as an answer with the sites it cites", async () => {
    const fetchStub = vendor();
    const results = providers(fetchStub);
    const [overviewSeen, organicSeen] = await Promise.all([
      results.google_ai_overview?.observe({ location, query, at }),
      results.google_organic?.observe({ location, query, at }),
    ]);
    // One page, asked once, read for both.
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(organicSeen?.kind).toBe("ranking");
    expect(overviewSeen).toEqual({
      kind: "answer",
      text: "For pizza near you, Tony's Slice House and Joe's Pizza are well reviewed.",
      businesses: [],
      cited_urls: ["https://yelp.example/raleigh-pizza", "https://joespizza.example/menu"],
    });
    expect(
      analyzeObservation(overviewSeen as never, location, "google_ai_overview").mentioned,
    ).toBe(true);
  });

  it("records the AI Overview as a search only when there was one", async () => {
    expect((await check("google_ai_overview")).used).toEqual([search("dataforseo/ai-overview", 1)]);

    const without = await check("google_ai_overview", vendor(resultsPage(false)));
    expect(without.observation).toEqual({
      kind: "answer",
      text: "",
      businesses: [],
      cited_urls: [],
    });
    expect(analyzeObservation(without.observation, location, "google_ai_overview").mentioned).toBe(
      false,
    );
    expect(without.used).toEqual([]);
  });

  it("asks the map results from the location's point, at the tuning's zoom and depth", async () => {
    const fetchStub = vendor();
    await check("google_local_pack", fetchStub);
    expect(sent(fetchStub, "local_finder").task).toEqual({
      keyword: "pizza near me",
      location_coordinate: "35.7795897,-78.6381787,14z",
      language_code: "en",
      depth: 20,
    });
  });

  it("reads the map results as a ranking of places, leaving out the ads", async () => {
    const { observation, used } = await check("google_local_pack");
    expect(observation).toEqual({
      kind: "ranking",
      entries: [
        { name: "Tony's Slice House", website: "https://tonys.example/", place_id: null },
        { name: "Joe's Pizza", website: "https://joespizza.example/", place_id: null },
        { name: "Capital Slice", website: null, place_id: null },
      ],
    });
    expect(analyzeObservation(observation, location, "google_local_pack")).toMatchObject({
      mentioned: true,
      position: 2,
      competitors: ["Tony's Slice House", "Capital Slice"],
    });
    // Four results, all within the first ten: one page is charged, the rest of the depth refunded.
    expect(used).toEqual([search("dataforseo/local-finder", 1)]);
  });

  it("asks AI Mode from the location's point and reads its answer and sources", async () => {
    const fetchStub = vendor();
    const { observation, used } = await check("google_ai_mode", fetchStub);
    expect(sent(fetchStub, "ai_mode").task).toEqual({
      keyword: "pizza near me",
      location_coordinate: "35.7795897,-78.6381787,14z",
      language_code: "en",
    });
    expect(observation).toEqual({
      kind: "answer",
      text: "Try Capital Slice downtown, or Joe's Pizza on Main Street.",
      businesses: [],
      cited_urls: ["https://raleigheats.example/slices"],
    });
    expect(analyzeObservation(observation, location, "google_ai_mode")).toMatchObject({
      mentioned: true,
    });
    expect(used).toEqual([search("dataforseo/ai-mode", 1)]);
  });

  it("reads no results as an empty list", async () => {
    const none = envelope(null, 40102, "No Search Results.");
    const { observation, used } = await check(
      "google_local_pack",
      vi.fn<typeof fetch>(async () => Response.json(none)),
    );
    expect(observation).toEqual({ kind: "ranking", entries: [] });
    expect(used).toEqual([search("dataforseo/local-finder", 1)]);
  });

  it("fails on an error from DataForSEO, saying what it said", async () => {
    const refused = envelope(null, 40501, "Invalid Field: 'location_coordinate'.");
    await expect(
      check(
        "google_ai_mode",
        vi.fn<typeof fetch>(async () => Response.json(refused)),
      ),
    ).rejects.toThrow("DataForSEO AI Mode failed (40501): Invalid Field: 'location_coordinate'.");
    await expect(
      check(
        "google_organic",
        vi.fn<typeof fetch>(async () => new Response("Unauthorized", { status: 401 })),
      ),
    ).rejects.toThrow("DataForSEO Google's results page failed (HTTP 401)");
  });

  it("will not check a location that has no point", async () => {
    const fetchStub = vendor();
    const provider = providers(fetchStub).google_local_pack;
    await expect(
      provider?.observe({
        location: { ...location, latitude: null, longitude: null, point_source: null },
        query,
        at,
      }),
    ).rejects.toThrow("has no point to check Google from");
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

function search(model: string, searches: number): CallUsage {
  return { model, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, searches };
}
