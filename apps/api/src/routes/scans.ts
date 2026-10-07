import type { Scan, ScanWithResults } from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { ApiError, notFound } from "../errors";
import { StoreError } from "../store/types";
import { uuidParam } from "../validation";
import { requireLocation } from "./locations";

export const scanRoutes = new Hono<AppEnv>();

const HISTORY_LIMIT = 30;

const scanInProgress = () =>
  new ApiError(409, "scan_in_progress", "A scan for this location is already under way.");

scanRoutes.get("/locations/:id/scans", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "id", "Location"));
  return c.json(await store.listScans(location.id, HISTORY_LIMIT));
});

scanRoutes.post("/locations/:id/scans", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "id", "Location"));

  // Every scan costs money in live mode, so one at a time per location. This check gives the
  // common case a quick answer; the database's unique index is what actually guarantees it,
  // including for two requests that arrive together.
  const [latest] = await store.listScans(location.id, 1);
  if (latest && (latest.status === "queued" || latest.status === "running")) throw scanInProgress();

  let scan: Scan;
  try {
    scan = await store.createScan(location.id, "manual", c.get("user").id);
  } catch (error) {
    if (error instanceof StoreError && error.kind === "conflict") throw scanInProgress();
    throw error;
  }
  // If this send fails the row stays "queued" with no message behind it. The request returns an
  // error, and the sweep in the scheduled handler fails the row so the location can scan again.
  await c.env.SCAN_QUEUE.send({ scan_id: scan.id });
  return c.json(scan, 202);
});

scanRoutes.get("/scans/:id", async (c) => {
  const store = c.get("store");
  const scan = await store.getScan(uuidParam(c, "id", "Scan"));
  if (!scan) throw notFound("Scan");
  const body: ScanWithResults = { ...scan, results: await store.listScanResults(scan.id) };
  return c.json(body);
});
