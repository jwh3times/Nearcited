import type { ScanWithResults } from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { ApiError, notFound } from "../errors";
import { uuidParam } from "../validation";
import { requireLocation } from "./locations";

export const scanRoutes = new Hono<AppEnv>();

const HISTORY_LIMIT = 30;

scanRoutes.get("/locations/:id/scans", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "id", "Location"));
  return c.json(await store.listScans(location.id, HISTORY_LIMIT));
});

scanRoutes.post("/locations/:id/scans", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "id", "Location"));

  // Every scan costs money in live mode, so one at a time per location.
  const [latest] = await store.listScans(location.id, 1);
  if (latest && (latest.status === "queued" || latest.status === "running")) {
    throw new ApiError(409, "scan_in_progress", "A scan for this location is already under way.");
  }

  const scan = await store.createScan(location.id, "manual", c.get("user").id);
  // If this send fails the row stays "queued" with no message behind it. The request returns an
  // error and the scheduler ignores stale in-flight scans, but nothing marks the row failed.
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
