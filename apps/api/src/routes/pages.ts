import { PromptPageInputSchema, promptOfRule, readPageAddress } from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { ApiError, notFound } from "../errors";
import type { Store } from "../store/types";
import { parseJson, uuidParam } from "../validation";
import { requireLocation } from "./locations";

export const pageRoutes = new Hono<AppEnv>();

/** A page task of the location's, by its ID. Any other task, or one elsewhere, is not found. */
async function requirePageTask(store: Store, locationId: string, taskId: string) {
  const task = (await store.listRecommendations(locationId)).find(
    (recommendation) => recommendation.id === taskId && promptOfRule(recommendation.rule),
  );
  if (!task) throw notFound("Task");
  return task;
}

/**
 * A member says where the page for a page task is, the first time or in place of the one before,
 * so the scans can count the answers that cite it. Any member of the location's organization: to
 * anyone else, the operator included, there is no such task. The address has to be on the
 * location's own website. Only its shape is checked. Nothing opens it.
 */
pageRoutes.put("/locations/:locationId/tasks/:taskId/page", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  const task = await requirePageTask(store, location.id, uuidParam(c, "taskId", "Task"));
  const { url } = await parseJson(c, PromptPageInputSchema);

  const read = readPageAddress(location.website, url);
  if ("problem" in read) throw new ApiError(422, "validation_failed", read.problem);

  const page = await store.setPromptPage(task.id, read.url);
  if (!page) throw notFound("Task");
  return c.json(page);
});

/** A member takes away where a task's page is. */
pageRoutes.delete("/locations/:locationId/tasks/:taskId/page", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  const task = await requirePageTask(store, location.id, uuidParam(c, "taskId", "Task"));
  if (!(await store.removePromptPage(task.id))) throw notFound("Page");
  return c.body(null, 204);
});
