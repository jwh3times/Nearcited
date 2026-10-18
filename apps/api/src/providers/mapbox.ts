import type { PointQuery } from "@nearcited/shared";
import type { CallUsage } from "./types";

/**
 * Finds the point a location's Google results are checked from, with Mapbox's forward geocoding
 * (`docs/adr/0023-google-results-are-bought-and-checked-from-one-point.md`). It asks for
 * permanent results, the kind Mapbox's terms let us keep: the point is kept on the location and
 * looked up again only when its address changes.
 */

const API = "https://api.mapbox.com/search/geocode/v6/forward";
const TIMEOUT_MS = 15_000;
/** The model name the lookup's usage is recorded under, priced from the tuning's rates. */
export const GEOCODE_MODEL = "mapbox/geocode-permanent";

export interface Point {
  latitude: number;
  longitude: number;
}

/**
 * The point for a street address or a city, or null when there is none it is sure of. Throws
 * when Mapbox could not be asked, so the scan is retried rather than kept without a point.
 */
export type Geocoder = (
  where: PointQuery & { country_code: string },
  onUsage?: (usage: CallUsage) => void,
) => Promise<Point | null>;

interface Feature {
  properties?: {
    feature_type?: string;
    coordinates?: { latitude?: number; longitude?: number };
    match_code?: { confidence?: string };
  };
}

export interface MapboxOptions {
  token: string;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
}

export function createMapboxGeocoder(options: MapboxOptions): Geocoder {
  const doFetch = options.fetch ?? fetch;
  return async ({ query, source, country_code }, onUsage) => {
    const params = new URLSearchParams({
      q: query,
      access_token: options.token,
      permanent: "true",
      autocomplete: "false",
      limit: "1",
      country: country_code.toLowerCase(),
      types: source === "address" ? "address" : "place",
    });
    let response: Response;
    try {
      response = await doFetch(`${API}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Mapbox geocoding failed to connect: ${reason}`);
    }
    if (!response.ok) throw new Error(`Mapbox geocoding failed (HTTP ${response.status}).`);
    onUsage?.({
      model: GEOCODE_MODEL,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      searches: 1,
    });

    const body = (await response.json()) as { features?: Feature[] };
    const found = body.features?.[0]?.properties;
    const latitude = found?.coordinates?.latitude;
    const longitude = found?.coordinates?.longitude;
    if (typeof latitude !== "number" || typeof longitude !== "number") return null;
    // An address Mapbox matched only loosely is somewhere else: the city is a better guess.
    if (source === "address" && found?.match_code?.confidence === "low") return null;
    return { latitude, longitude };
  };
}
