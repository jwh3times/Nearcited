import {
  type LocationDetail,
  RecommendationUpdateSchema,
  TrackedQueryInputSchema,
} from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { notFound } from "../errors";
import type { Store } from "../store/types";
import { parseJson, uuidParam } from "../validation";

export const locationRoutes = new Hono<AppEnv>();

/** Loads a location the caller can see. A location in someone else's organization reads as missing. */
export async function requireLocation(store: Store, id: string) {
  const location = await store.getLocation(id);
  if (!location) throw notFound("Location");
  return location;
}

locationRoutes.get("/locations/:id", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "id", "Location"));

  const [queries, [latest], recommendations] = await Promise.all([
    store.listQueries(location.id),
    store.listScans(location.id, 1),
    store.listRecommendations(location.id),
  ]);

  const detail: LocationDetail = {
    location,
    queries,
    latest_scan: latest ? { ...latest, results: await store.listScanResults(latest.id) } : null,
    recommendations,
  };
  return c.json(detail);
});

locationRoutes.delete("/locations/:id", async (c) => {
  const deleted = await c.get("store").deleteLocation(uuidParam(c, "id", "Location"));
  if (!deleted) throw notFound("Location");
  return c.body(null, 204);
});

locationRoutes.post("/locations/:id/queries", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "id", "Location"));
  const input = await parseJson(c, TrackedQueryInputSchema);
  return c.json(await store.createQuery(location.id, input), 201);
});

locationRoutes.delete("/queries/:id", async (c) => {
  const deleted = await c.get("store").deleteQuery(uuidParam(c, "id", "Query"));
  if (!deleted) throw notFound("Query");
  return c.body(null, 204);
});

locationRoutes.patch("/recommendations/:id", async (c) => {
  const id = uuidParam(c, "id", "Recommendation");
  const { status } = await parseJson(c, RecommendationUpdateSchema);
  const updated = await c.get("store").setRecommendationStatus(id, status);
  if (!updated) throw notFound("Recommendation");
  return c.json(updated);
});
