import { type Observation, SURFACES, type Surface } from "@nearcited/shared";
import type { ObserveInput, ProviderRegistry, SurfaceProvider } from "./types";

/**
 * Generated observations for development and demos. No network, no cost.
 *
 * Output is a pure function of the location, query, surface and calendar day, so a scan is
 * repeatable within a day and drifts from one day to the next. None of it is real: do not show
 * mock results to a customer as if they were measurements.
 */

const COMPETITORS = [
  "Harbor Street Collective",
  "Oak & Ember",
  "Northside Works",
  "Bluebird & Sons",
  "Capital City Co-op",
  "Maple Lane Studio",
  "Fifth Ward Trading",
  "Glenwood Guild",
  "Ironworks Annex",
  "Sunrise Corner",
];

/** FNV-1a. Small, stable, and good enough to spread a few dozen inputs. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function listed({ location, query, at }: ObserveInput, surface: Surface): string[] {
  const day = at.toISOString().slice(0, 10);
  const next = random(hash(`${location.id}|${query.id}|${surface}|${day}`));

  const pool = [...COMPETITORS];
  const names: string[] = [];
  const count = 3 + Math.floor(next() * 3);
  for (let i = 0; i < count && pool.length > 0; i++) {
    names.push(...pool.splice(Math.floor(next() * pool.length), 1));
  }
  if (next() < 0.55) {
    names.splice(Math.floor(next() * (names.length + 1)), 0, location.name);
  }
  return names;
}

function observation(input: ObserveInput, surface: Surface): Observation {
  const names = listed(input, surface);
  if (surface === "google_local_pack" || surface === "google_organic") {
    return {
      kind: "ranking",
      entries: names.map((name) => ({
        name,
        website: name === input.location.name ? input.location.website : null,
        place_id: name === input.location.name ? input.location.google_place_id : null,
      })),
    };
  }
  return {
    kind: "answer",
    text: `For "${input.query.text}" in ${input.location.city}, people most often point to ${names.join(", ")}. (Generated sample, not a real answer.)`,
    businesses: names,
    cited_urls: names.map((name) =>
      name === input.location.name && input.location.website
        ? input.location.website
        : `https://${slug(name)}.example`,
    ),
  };
}

function mockProvider(surface: Surface): SurfaceProvider {
  return { surface, observe: async (input) => observation(input, surface) };
}

export function createMockProviders(): ProviderRegistry {
  return Object.fromEntries(SURFACES.map((surface) => [surface, mockProvider(surface)]));
}
