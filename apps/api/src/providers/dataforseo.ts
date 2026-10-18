import {
  GOOGLE_SURFACES,
  type GoogleTuning,
  type Location,
  type Observation,
  type RankedEntry,
} from "@nearcited/shared";
import type { CallUsage, ObserveInput, ProviderRegistry, SurfaceProvider } from "./types";

/**
 * Google's map pack, organic results, AI Overview and AI Mode, bought from DataForSEO's live SERP
 * endpoints (`docs/adr/0023-google-results-are-bought-and-checked-from-one-point.md`). Google has
 * no interface for any of them, so this is results as DataForSEO read them off Google, checked
 * from the location's own point because results change from street to street.
 *
 * One keyword is three calls: Google's results page, read for the organic results and for the AI
 * Overview loaded in full; Local Finder, read as the map pack; and AI Mode. The organic results
 * and the AI Overview come from the same page, which is asked once and read by both.
 *
 * The provider only fetches. What a result means is decided by `analyzeObservation`.
 */

const API = "https://api.dataforseo.com/v3/serp/google";
const TIMEOUT_MS = 60_000;
const OK = 20000;
/** DataForSEO's answer when Google showed nothing for the keyword. */
const NO_RESULTS = 40102;
/** The language results are asked in. */
const LANGUAGE = "en";

export interface DataForSeoOptions {
  login: string;
  password: string;
  tuning: { google: GoogleTuning };
  /** Replaceable in tests. */
  fetch?: typeof fetch;
}

interface Item {
  type?: string;
  rank_group?: number;
  title?: string | null;
  domain?: string | null;
  url?: string | null;
  website_name?: string | null;
  is_paid?: boolean | null;
  items?: Item[] | null;
  text?: string | null;
  references?: { url?: string | null }[] | null;
}

interface Result {
  items?: Item[] | null;
  items_count?: number | null;
}

interface Envelope {
  status_code?: number;
  status_message?: string;
  tasks?: { status_code?: number; status_message?: string; result?: Result[] | null }[] | null;
}

/** The calls a keyword is checked with, by the endpoint each goes to. */
const ENDPOINTS = {
  page: { path: "organic", name: "Google's results page" },
  map: { path: "local_finder", name: "the map results" },
  ai_mode: { path: "ai_mode", name: "AI Mode" },
} as const;
type Endpoint = keyof typeof ENDPOINTS;

/** One call's usage: DataForSEO charges by the request, so it is counted as searches. */
function searches(model: string, count: number): CallUsage {
  return { model, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, searches: count };
}

/** Where a check is made from. Coordinates take at most seven decimal places. */
function point(location: Location): string {
  if (location.latitude === null || location.longitude === null) {
    throw new Error(`Location ${location.id} has no point to check Google from.`);
  }
  const round = (degrees: number) => Number(degrees.toFixed(7));
  return `${round(location.latitude)},${round(location.longitude)}`;
}

function byRank(items: readonly Item[], type: string): Item[] {
  return items
    .filter((item) => item.type === type && item.is_paid !== true)
    .sort((a, b) => (a.rank_group ?? 0) - (b.rank_group ?? 0));
}

/** An AI Overview, or AI Mode's answer, as a written answer with the pages it links to. */
function answerOf(item: Item | undefined): Observation {
  if (!item) return { kind: "answer", text: "", businesses: [], cited_urls: [] };
  const parts = item.items ?? [];
  const references = [
    ...(item.references ?? []),
    ...parts.flatMap((part) => part.references ?? []),
  ];
  return {
    kind: "answer",
    text: parts
      .map((part) => part.text?.trim())
      .filter(Boolean)
      .join("\n\n"),
    // An overview names businesses in its text and nowhere else; `analyzeObservation` reads it.
    businesses: [],
    cited_urls: [...new Set(references.flatMap((reference) => reference.url ?? []))],
  };
}

export function createDataForSeoProviders(options: DataForSeoOptions): ProviderRegistry {
  const doFetch = options.fetch ?? fetch;
  const authorization = `Basic ${btoa(`${options.login}:${options.password}`)}`;
  const google = options.tuning.google;

  async function ask(endpoint: Endpoint, task: Record<string, unknown>): Promise<Result> {
    const { path, name } = ENDPOINTS[endpoint];
    let response: Response;
    try {
      response = await doFetch(`${API}/${path}/live/advanced`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify([task]),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`DataForSEO ${name} failed to connect: ${reason}`);
    }
    if (!response.ok) throw new Error(`DataForSEO ${name} failed (HTTP ${response.status}).`);
    const body = (await response.json()) as Envelope;
    const done = body.tasks?.[0];
    const code = done?.status_code ?? body.status_code;
    if (code === NO_RESULTS) return { items: [], items_count: 0 };
    if (code !== OK || !done) {
      const said = done?.status_message ?? body.status_message ?? "no reason given";
      throw new Error(`DataForSEO ${name} failed (${code}): ${said}`);
    }
    return done.result?.[0] ?? { items: [], items_count: 0 };
  }

  // Google's results page for one check, shared by the organic results and the AI Overview: a
  // scan asks both for the same keyword at the same moment, and it is one call for the two.
  const pages = new Map<string, { page: Promise<Result>; readers: number }>();
  function resultsPage({ location, query, at }: ObserveInput): Promise<Result> {
    const key = `${location.id}|${query.id}|${at.toISOString()}`;
    let shared = pages.get(key);
    if (!shared) {
      const page = ask("page", {
        keyword: query.text,
        location_coordinate: `${point(location)},${google.radius_m}`,
        language_code: LANGUAGE,
        depth: google.organic_depth,
        load_async_ai_overview: true,
      });
      shared = { page, readers: 0 };
      pages.set(key, shared);
    }
    // Two read it, and then it is forgotten.
    shared.readers += 1;
    if (shared.readers >= 2) pages.delete(key);
    return shared.page;
  }

  const providers: Record<(typeof GOOGLE_SURFACES)[number], SurfaceProvider["observe"]> = {
    async google_organic(input) {
      const page = await resultsPage(input);
      input.onUsage?.(searches("dataforseo/organic", google.organic_depth / 10));
      const entries: RankedEntry[] = byRank(page.items ?? [], "organic").map((item) => ({
        name: item.website_name?.trim() || item.domain || item.title || "",
        website: item.url ?? null,
        place_id: null,
      }));
      return { kind: "ranking", entries };
    },

    async google_ai_overview(input) {
      const page = await resultsPage(input);
      const shown = (page.items ?? []).find((item) => item.type === "ai_overview");
      // Loading the overview is charged only when there was one to load.
      if (shown) input.onUsage?.(searches("dataforseo/ai-overview", 1));
      return answerOf(shown);
    },

    async google_local_pack({ location, query, onUsage }) {
      const map = await ask("map", {
        keyword: query.text,
        location_coordinate: `${point(location)},${google.zoom}z`,
        language_code: LANGUAGE,
        depth: google.map_depth,
      });
      // Charged for each ten results it returned, the rest of the depth refunded.
      onUsage?.(
        searches("dataforseo/local-finder", Math.max(1, Math.ceil((map.items_count ?? 0) / 10))),
      );
      const entries: RankedEntry[] = byRank(map.items ?? [], "local_pack").map((item) => ({
        name: item.title ?? "",
        website: item.url ?? null,
        place_id: null,
      }));
      return { kind: "ranking", entries };
    },

    async google_ai_mode({ location, query, onUsage }) {
      const answered = await ask("ai_mode", {
        keyword: query.text,
        location_coordinate: `${point(location)},${google.zoom}z`,
        language_code: LANGUAGE,
      });
      onUsage?.(searches("dataforseo/ai-mode", 1));
      return answerOf((answered.items ?? []).find((item) => item.type === "ai_overview"));
    },
  };

  // In the order the surfaces are listed everywhere else.
  return Object.fromEntries(
    GOOGLE_SURFACES.map((surface) => [surface, { surface, observe: providers[surface] }]),
  );
}
