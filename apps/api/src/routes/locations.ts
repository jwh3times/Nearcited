import {
  buildActionPlan,
  CITING_SURFACES,
  type LocationDetail,
  poolWindow,
  RecommendationUpdateSchema,
  SCAN_WINDOW,
  summarizeSources,
  summarizeWindow,
  TrackedQueryInputSchema,
  TrackedQueryUpdateSchema,
} from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { notFound } from "../errors";
import { checkedSurfaces, planSurfaces, usesSampleData } from "../providers";
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

  const [organization, queries, [latest], recommendations, recent, site] = await Promise.all([
    store.getOrganization(location.organization_id),
    store.listQueries(location.id),
    store.listScans(location.id, 1),
    store.listRecommendations(location.id),
    store.listRecentResults(location.id, SCAN_WINDOW, usesSampleData(c.env)),
    store.getSiteCheck(location.id),
  ]);

  // The same pool the rates are counted over, narrowed to the answers that list their sources.
  const answers = poolWindow(recent).filter((result) => CITING_SURFACES.includes(result.surface));

  // Every site, so the plan never calls the business's own site uncited because a list was cut.
  const sources = summarizeSources(answers, location.website, Number.POSITIVE_INFINITY);

  const detail: LocationDetail = {
    location,
    queries,
    latest_scan: latest ? { ...latest, results: await store.listScanResults(latest.id) } : null,
    window: {
      size: SCAN_WINDOW,
      scans: recent.length,
      cells: summarizeWindow(recent),
      answers: answers.length,
      sources: summarizeSources(answers, location.website),
    },
    site,
    actions: buildActionPlan({
      name: location.name,
      website: location.website,
      answers: answers.length,
      sources,
      site,
      competitors: answers.flatMap((answer) =>
        answer.competitors.map((name) => ({ name, count: 1 })),
      ),
    }),
    surfaces: planSurfaces(checkedSurfaces(c.env), organization?.surfaces ?? null),
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

  // Asking for a prompt that was retired brings it back with its history, instead of failing as
  // a duplicate of a row the user can no longer see in the grid.
  const retired = (await store.listQueries(location.id)).find(
    (query) => !query.is_active && query.kind === input.kind && query.text === input.text,
  );
  if (retired) {
    const restored = await store.setQueryActive(retired.id, true);
    if (restored) return c.json(restored, 200);
  }
  return c.json(await store.createQuery(location.id, input), 201);
});

// There is no delete: removing a prompt would remove every result recorded for it. Retiring it
// stops it being scanned and keeps the history.
locationRoutes.patch("/queries/:id", async (c) => {
  const id = uuidParam(c, "id", "Query");
  const { is_active } = await parseJson(c, TrackedQueryUpdateSchema);
  const updated = await c.get("store").setQueryActive(id, is_active);
  if (!updated) throw notFound("Query");
  return c.json(updated);
});

locationRoutes.patch("/recommendations/:id", async (c) => {
  const id = uuidParam(c, "id", "Recommendation");
  const { status } = await parseJson(c, RecommendationUpdateSchema);
  const updated = await c.get("store").setRecommendationStatus(id, status);
  if (!updated) throw notFound("Recommendation");
  return c.json(updated);
});
