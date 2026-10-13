import {
  ActivateLocationSchema,
  buildActionPlan,
  buildDetailsFix,
  buildTasks,
  CITING_SURFACES,
  type DetailsEvidence,
  draftsStanding,
  type LocationDetail,
  LocationInputSchema,
  MAX_SCANS_SINCE,
  RecommendationUpdateSchema,
  SCAN_WINDOW,
  SURFACES,
  scansCounted,
  summarizeSources,
  summarizeWindow,
  type TaskEvidence,
  TrackedQueryInputSchema,
  TrackedQueryUpdateSchema,
} from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { writesRealDrafts } from "../drafts";
import { notFound } from "../errors";
import { checkedSurfaces, planSurfaces, usesSampleData } from "../providers";
import type { Store } from "../store/types";
import { citedIn } from "../tasks";
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

  const organization = await store.getOrganization(location.organization_id);
  // Generated and real results never share a window, so which one to read is decided first. A
  // test organization's are generated even in a live deployment.
  const sample = usesSampleData(c.env) || organization?.is_test === true;
  const [queries, [latest], recommendations, recent, site, alerts, drafts, listings, allowanceUse] =
    await Promise.all([
      store.listQueries(location.id),
      store.listScans(location.id, 1),
      store.listRecommendations(location.id),
      store.listRecentResults(location.id, SCAN_WINDOW, sample),
      store.getSiteCheck(location.id),
      store.listAlerts(location.id, sample),
      store.listDrafts(location.id),
      store.listListings(location.id),
      store.getAllowanceUse(location.organization_id),
    ]);
  // A drop on a prompt retired since the last scan has nothing left to say. The next scan
  // clears it; until then it is not shown.
  const asked = new Set(queries.filter((query) => query.is_active).map((query) => query.id));

  const { answers, sources } = citedIn(recent, location.website);

  // For each recommendation a member marked, the answers either side of the mark. They are
  // read separately from the window: the window moves on, and the mark stays where it was put.
  const citing = (scans: Awaited<typeof recent>) =>
    scans.flat().filter((result) => CITING_SURFACES.includes(result.surface));
  const evidence = new Map<string, TaskEvidence & DetailsEvidence>(
    await Promise.all(
      recommendations
        .filter(
          (recommendation) => recommendation.acted_at && recommendation.status !== "dismissed",
        )
        .map(async (recommendation) => {
          const around = await store.listResultsAround(
            location.id,
            recommendation.acted_at ?? "",
            SCAN_WINDOW,
            MAX_SCANS_SINCE,
            sample,
          );
          return [
            recommendation.id,
            {
              before: citing(around.before),
              since: citing(around.since),
              scans_since: around.since.length,
            },
          ] as const;
        }),
    ),
  );

  const detail: LocationDetail = {
    location,
    queries,
    connections: await store.listLocationConnections(location.id),
    latest_scan: latest ? { ...latest, results: await store.listScanResults(latest.id) } : null,
    window: {
      size: SCAN_WINDOW,
      scans: scansCounted(recent),
      cells: summarizeWindow(recent),
      answers: answers.length,
      sources: summarizeSources(answers, location.website),
    },
    site,
    action_plan: buildActionPlan({
      name: location.name,
      website: location.website,
      answers: answers.length,
      sources,
      site,
      competitors: answers.flatMap((answer) =>
        answer.competitors.map((name) => ({ name, count: 1 })),
      ),
    }),
    surfaces: planSurfaces(
      sample ? [...SURFACES] : checkedSurfaces(c.env),
      organization?.surfaces ?? null,
    ),
    recommendations,
    tasks: buildTasks({
      name: location.name,
      recommendations,
      sources,
      answers: answers.length,
      evidence,
      drafts,
      listings,
      // No task is offered a draft this build could only refuse to write.
      writes: (kind) => sample || writesRealDrafts(c.env, c.get("deployment").draft_kinds, kind),
    }),
    drafts: draftsStanding(
      organization?.allowances ?? {},
      organization?.max_locations ?? 0,
      allowanceUse,
      new Date(),
    ),
    details_fix: buildDetailsFix({ recommendations, website: location.website, evidence }),
    alerts: alerts.filter(
      (alert) =>
        alert.dismissed_at === null && (alert.kind !== "drop" || asked.has(alert.tracked_query_id)),
    ),
  };
  return c.json(detail);
});

// The body is a whole location, as on create: a field left out goes back to blank or its default.
// The one exception is `what_we_do`, which stays as it is when left out.
locationRoutes.patch("/locations/:id", async (c) => {
  const id = uuidParam(c, "id", "Location");
  const input = await parseJson(c, LocationInputSchema);
  const updated = await c.get("store").updateLocation(id, input);
  if (!updated) throw notFound("Location");
  return c.json(updated);
});

/**
 * Brings a location the plan paused back into use. When the plan has no room, `instead_of`
 * names the location that gives up its place; the database says so when it is missing.
 */
locationRoutes.post("/locations/:id/activate", async (c) => {
  const id = uuidParam(c, "id", "Location");
  const { instead_of } = await parseJson(c, ActivateLocationSchema);
  const location = await c.get("store").activateLocation(id, instead_of);
  if (!location) throw notFound("Location");
  return c.json(location);
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
  const store = c.get("store");
  const id = uuidParam(c, "id", "Recommendation");
  const { status, acted } = await parseJson(c, RecommendationUpdateSchema);
  let updated = null;
  if (acted !== undefined) {
    updated = await store.setRecommendationActed(id, acted);
    if (!updated) throw notFound("Recommendation");
  }
  if (status !== undefined) updated = await store.setRecommendationStatus(id, status);
  if (!updated) throw notFound("Recommendation");
  return c.json(updated);
});
