import { type Draft, draftRequest, NO_DRAFT } from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { writerFor } from "../drafts";
import { ApiError, notFound } from "../errors";
import { usesSampleData } from "../providers";
import { currentTasks } from "../tasks";
import { uuidParam } from "../validation";
import { requireLocation } from "./locations";

export const draftRoutes = new Hono<AppEnv>();

/** Queues the worker to write a draft. If the message is lost the schedule sends it. */
async function queueWrite(queue: AppEnv["Bindings"]["SCAN_QUEUE"], draft: Draft) {
  if (draft.status !== "asked") return;
  try {
    await queue.send({ draft_id: draft.id, step: "write" });
  } catch (error) {
    console.error(`Draft ${draft.id}: could not queue it, the schedule will`, error);
  }
}

/**
 * A member's ask for a draft of one task, the first or another. Any member of the location's
 * organization: to anyone else, the operator included, the task is not found. The request only
 * records the ask. The worker writes the draft, because that takes from the month's allowance.
 *
 * What is refused here is refused before anything is counted: a task with no draft to write, a
 * location that has not said what the business does, a deployment with nothing to write a real
 * draft with, and a month with no room.
 */
draftRoutes.post("/locations/:locationId/tasks/:taskId/draft", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  const taskId = uuidParam(c, "taskId", "Task");

  const organization = await store.getOrganization(location.organization_id);
  const sample = usesSampleData(c.env) || organization?.is_test === true;
  const task = (await currentTasks(store, location, sample)).find(
    (candidate) => candidate.id === taskId,
  );
  if (!task) throw notFound("Task");
  const request = draftRequest(location, task);
  if (typeof request === "string") throw new ApiError(409, request, NO_DRAFT[request]);
  if (!writerFor(sample, undefined)) {
    throw new ApiError(503, "drafts_unavailable", "Drafts cannot be written here yet.");
  }

  const draft = await store.askDraft(task.id);
  if (!draft) throw notFound("Task");
  await queueWrite(c.env.SCAN_QUEUE, draft);
  return c.json(draft, 202);
});
