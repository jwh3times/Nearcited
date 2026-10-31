import {
  addDays,
  analyticsSource,
  dayOf,
  type LocationAnalyticsVisits,
  type LocationLine,
  type LocationVisits,
  lineToPaste,
  VISITS_SHOWN_DAYS,
  type VisitLine,
} from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import type { Env } from "../env";
import { notFound } from "../errors";
import { usesSampleData } from "../providers";
import { uuidParam } from "../validation";
import { requireLocation } from "./locations";

/**
 * A location's line, for a signed-in reader. What the line itself posts, with no sign-in, is
 * received in `app.ts`, ahead of everything that asks who is calling.
 */
export const visitRoutes = new Hono<AppEnv>();

/** A line as a page is sent it: with the line to paste, which names where the product is served. */
const sent = (env: Env, line: VisitLine, canReplace: boolean): LocationLine => ({
  line,
  html: lineToPaste(env.APP_URL, line.key),
  can_replace: canReplace,
});

/**
 * A location's line, for anyone who can read the location: the key its site carries, the line
 * to paste and the last day the line answered a check. The key is no secret, since it is in the
 * site's source. Whoever may make a connection may replace it: an owner or an admin.
 */
visitRoutes.get("/locations/:locationId/line", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  const [line, canReplace] = await Promise.all([
    store.getVisitLine(location.id),
    store.managesConnections(location.organization_id),
  ]);
  if (!line) throw notFound("Line");
  return c.json(sent(c.env, line, canReplace));
});

/**
 * A location's visits from assistants over the last thirty days, added up, for anyone who can
 * read the location. It is what the location's own site reported and nothing else: nothing here
 * is generated, on sample data or for a test organization.
 */
visitRoutes.get("/locations/:locationId/visits", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  return c.json(
    (await store.getLocationVisits(location.id, VISITS_SHOWN_DAYS)) satisfies LocationVisits,
  );
});

/**
 * A location's sessions from assistants over the last thirty finished days, added up, as its Google
 * Analytics property reported them and the worker read them, with where they come from. Kept apart
 * from what the line reported and never added to it. Where the property measuring its website is
 * another location's, that location is named and no count is sent, so none is shown twice. A test
 * organization's, and every one in a deployment on sample data, are the made-up ones. For anyone who
 * can read the location.
 */
visitRoutes.get("/locations/:locationId/analytics-visits", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  const organization = await store.getOrganization(location.organization_id);
  if (!organization) throw notFound("Location");
  const sampleData = usesSampleData(c.env) || organization.is_test;
  const [connections, locations] = await Promise.all([
    store.listConnections(organization.id),
    store.listLocations(organization.id),
  ]);
  const source = analyticsSource({
    location,
    locations,
    connections,
    allowances: organization.allowances,
    sampleData,
  });
  const today = dayOf(new Date());
  const since = addDays(today, -VISITS_SHOWN_DAYS);
  const added =
    source.state === "elsewhere"
      ? { days: [], pages: [], other_pages: 0 }
      : await store.getLocationAnalyticsVisits(location.id, since, sampleData);
  return c.json({
    source,
    since,
    through: addDays(today, -1),
    ...added,
  } satisfies LocationAnalyticsVisits);
});

/**
 * Gives a location a new site key. Owner or admin only: to anyone else there is no such thing.
 * The line on the site counts nothing from then on, until it is pasted again with the new key.
 */
visitRoutes.post("/locations/:locationId/line/key", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  const line = await store.replaceSiteKey(location.id);
  if (!line) throw notFound("Line");
  return c.json(sent(c.env, line, true));
});
