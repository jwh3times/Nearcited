import { Hono } from "hono";
import type { AppEnv } from "../app";
import { notFound } from "../errors";
import { uuidParam } from "../validation";

export const alertRoutes = new Hono<AppEnv>();

/**
 * A member's dismissal of one alert. Any member of the location's organization: to anyone else,
 * the operator included, the alert is not found. Nothing else about an alert is a request's to
 * change: the worker raises one and clears one, when a scan finishes.
 */
alertRoutes.post("/alerts/:alertId/dismiss", async (c) => {
  const alert = await c.get("store").dismissAlert(uuidParam(c, "alertId", "Alert"));
  if (!alert) throw notFound("Alert");
  return c.json(alert);
});
