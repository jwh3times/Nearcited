import {
  addDays,
  dayOf,
  FETCHES_SHOWN_DAYS,
  fetchSource,
  type LocationFetches,
} from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { notFound } from "../errors";
import { usesSampleData } from "../providers";
import { uuidParam } from "../validation";
import { requireLocation } from "./locations";

/** Fetches of a location's own site, read from its Cloudflare zone by the worker. */
export const fetchRoutes = new Hono<AppEnv>();

/**
 * A location's fetches by known fetchers over the last thirty finished days, added up, for anyone
 * who can read the location, with where they come from. Where the zone holding its website is
 * another location's, that location is named and no count is sent, so none is shown twice. A
 * test organization's, and every one in a deployment on sample data, are the made-up ones.
 */
fetchRoutes.get("/locations/:locationId/fetches", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  const organization = await store.getOrganization(location.organization_id);
  if (!organization) throw notFound("Location");
  const sampleData = usesSampleData(c.env) || organization.is_test;
  const [connections, locations] = await Promise.all([
    store.listConnections(organization.id),
    store.listLocations(organization.id),
  ]);
  const source = fetchSource({
    location,
    locations,
    connections,
    allowances: organization.allowances,
    sampleData,
  });
  const today = dayOf(new Date());
  const since = addDays(today, -FETCHES_SHOWN_DAYS);
  const added =
    source.state === "elsewhere"
      ? { days: [], pages: [], other_pages: [], read_through: null }
      : await store.getLocationFetches(location.id, since, sampleData);
  return c.json({
    source,
    since,
    through: addDays(today, -1),
    ...added,
  } satisfies LocationFetches);
});
