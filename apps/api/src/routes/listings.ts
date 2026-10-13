import { ListingInputSchema, listingSite, readListing } from "@nearcited/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { ApiError, notFound } from "../errors";
import { parseJson, uuidParam } from "../validation";
import { requireLocation } from "./locations";

export const listingRoutes = new Hono<AppEnv>();

/**
 * The site a listing is kept under, as the list of known sites names it. Only a site a task asks
 * for a listing on: one that lets a business ask its customers for reviews. Any other name is no
 * listing at all, so it is not found.
 */
function siteParam(c: Context): string {
  const named = c.req.param("site") ?? "";
  if (listingSite(named) !== named) throw notFound("Listing");
  return named;
}

/**
 * A member gives the address of a location's own page on a site, the first time or in place of
 * the one before. Any member of the location's organization: to anyone else, the operator
 * included, there is no such listing. Only the shape of the address is checked. Nothing opens
 * it.
 */
listingRoutes.put("/locations/:locationId/listings/:site", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  const site = siteParam(c);
  const { url } = await parseJson(c, ListingInputSchema);

  const read = readListing(site, url);
  if ("problem" in read) throw new ApiError(422, "validation_failed", read.problem);

  const listing = await store.setListing(location.id, site, read.url);
  if (!listing) throw notFound("Listing");
  return c.json(listing);
});

/** A member takes a location's listing on a site away. */
listingRoutes.delete("/locations/:locationId/listings/:site", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  if (!(await store.removeListing(location.id, siteParam(c)))) throw notFound("Listing");
  return c.body(null, 204);
});
