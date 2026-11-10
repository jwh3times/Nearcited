import {
  isConfidentialCategory,
  type Location,
  type LocationFoundAnswers,
  type LocationReviewRequests,
  type Organization,
  qualifyingSites,
  REVIEW_REQUESTS_ALLOWANCE,
  type ReviewRequestSettings,
  type ReviewRequestsBar,
  ReviewRequestsInputSchema,
  type ReviewSite,
  receiptAddress,
  SCAN_WINDOW,
} from "@nearcited/shared";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../app";
import { ApiError, notFound } from "../errors";
import { usesSampleData } from "../providers";
import type { KeptReviewRequests, Store } from "../store/types";
import { citedIn } from "../tasks";
import { parseJson, uuidParam } from "../validation";
import { requireLocation } from "./locations";

/**
 * A location's review requests (issue #290, part of #146): the receipt address its owner copies
 * receipts to, the site a customer is asked to review the business on, and where a reply goes.
 * Any member reads them; only an owner or admin turns them on, replaces the receipt address, and
 * turns them off, as any connection is removed. Nothing is received or sent yet.
 */
export const reviewRequestRoutes = new Hono<AppEnv>();

/** The sites a location's review requests may ask for, the one its answers cited most first. */
async function sitesFor(
  c: Context<AppEnv>,
  store: Store,
  organization: Organization,
  location: Location,
): Promise<ReviewSite[]> {
  // Generated and real results never share a window, as on the location's own page.
  const sample = usesSampleData(c.env) || organization.is_test;
  const [listings, recent] = await Promise.all([
    store.listListings(location.id),
    store.listRecentResults(location.id, SCAN_WINDOW, sample),
  ]);
  return qualifyingSites(listings, citedIn(recent, location.website).sources);
}

/** What stands in the way of turning a location's review requests on, or null where nothing does. */
function barred(
  organization: Organization,
  location: Location,
  sites: readonly ReviewSite[],
): ReviewRequestsBar | null {
  if (organization.allowances[REVIEW_REQUESTS_ALLOWANCE] === undefined) return "not_included";
  if (location.time_zone === null) return "no_time_zone";
  if (isConfidentialCategory(location.primary_category)) return "confidential";
  if (sites.length === 0) return "no_site";
  return null;
}

const BARRED: Record<ReviewRequestsBar, ApiError> = {
  not_included: new ApiError(
    422,
    "connection_unavailable",
    "This organization's plan does not include review requests.",
  ),
  no_time_zone: new ApiError(
    422,
    "no_time_zone",
    "Set this location's time zone under Settings first: a request is sent at a time of its day.",
  ),
  confidential: new ApiError(
    422,
    "confidential",
    "Review requests are not offered to a business whose list of customers is confidential, such as a clinic or a law firm.",
  ),
  no_site: new ApiError(
    422,
    "no_site",
    "Add this location's listing on Google, BBB or Trustpilot first, so there is a review form to send customers to.",
  ),
};

/**
 * Review requests as a member is sent them, for the location they were read for: with the receipt
 * address written out whole.
 */
function sentReviewRequests(location: Location, kept: KeptReviewRequests): ReviewRequestSettings {
  return {
    connection_id: kept.connection_id,
    location_id: location.id,
    receipt_address: receiptAddress(kept.receipt_address),
    address_made_at: kept.address_made_at,
    site: kept.site,
    reply_to: kept.reply_to,
    turned_on_by_email: kept.connected_by_email,
    turned_on_at: kept.connected_at,
    status: kept.status,
    paused_at: kept.paused_at,
  };
}

/**
 * Refuses a caller who can read the location but not change its review requests: a plain member,
 * or the operator reading through.
 */
async function requireManager(store: Store, organizationId: string) {
  if (!(await store.managesConnections(organizationId))) {
    throw new ApiError(
      403,
      "owners_and_admins_only",
      "Only an owner or admin turns review requests on or changes them.",
    );
  }
}

/** A location's review requests, for anyone who can read the location. */
reviewRequestRoutes.get("/locations/:locationId/review-requests", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  const organization = await store.getOrganization(location.organization_id);
  if (!organization) throw notFound("Location");
  const [sites, canManage, kept] = await Promise.all([
    sitesFor(c, store, organization, location),
    store.managesConnections(organization.id),
    store.getLocationReviewRequests(location.id),
  ]);
  return c.json({
    barred: barred(organization, location, sites),
    can_manage: canManage,
    settings: kept ? sentReviewRequests(location, kept) : null,
    sites,
    reply_to: c.get("user").email ?? null,
  } satisfies LocationReviewRequests);
});

/**
 * Turns a location's review requests on, which approves the wording as it stands. Owner or admin
 * only. Refused with the reason for a location that has no time zone, whose category is a
 * confidential one or that has no listing to ask for a review on, for a site that is not one of
 * those, and without the owner's word that the list of customers is not confidential.
 */
reviewRequestRoutes.post("/locations/:locationId/review-requests", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  const organization = await store.getOrganization(location.organization_id);
  if (!organization) throw notFound("Location");
  await requireManager(store, organization.id);
  const input = await parseJson(c, ReviewRequestsInputSchema);
  if (await store.getLocationReviewRequests(location.id)) {
    throw new ApiError(
      409,
      "already_connected",
      "Review requests are on for this location already.",
    );
  }
  const sites = await sitesFor(c, store, organization, location);
  const bar = barred(organization, location, sites);
  if (bar) throw BARRED[bar];
  if (!sites.some((site) => site.site === input.site)) {
    throw new ApiError(
      422,
      "not_a_site",
      "Choose one of the sites where this location has a listing with a review form.",
    );
  }

  const made = await store.turnOnReviewRequests({
    id: crypto.randomUUID(),
    location_id: location.id,
    site: input.site,
    reply_to: input.reply_to,
    confirmed: input.confirmed,
  });
  if (!made) throw notFound("Location");
  const kept = await store.getLocationReviewRequests(location.id);
  if (!kept) throw notFound("Location");
  return c.json(sentReviewRequests(location, kept), 201);
});

/**
 * Gives a location's review requests a new receipt address. Owner or admin only. The old one is
 * nobody's from then on, so a receipt copied to it reaches nothing.
 */
reviewRequestRoutes.post("/locations/:locationId/review-requests/address", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  await requireManager(store, location.organization_id);
  const kept = await store.replaceReceiptAddress(location.id);
  if (!kept) throw notFound("Review requests");
  return c.json(sentReviewRequests(location, kept));
});

/**
 * A location's found answers over the months shown, for anyone who can read the location: how many
 * customers who followed a review request said each way they found the business, by month (issue
 * #148). A test organization's, and every one in a deployment on sample data, are the made-up ones.
 */
reviewRequestRoutes.get("/locations/:locationId/found-answers", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  const organization = await store.getOrganization(location.organization_id);
  if (!organization) throw notFound("Location");
  const sampleData = usesSampleData(c.env) || organization.is_test;
  return c.json({
    months: await store.getLocationFoundAnswers(location.id, sampleData),
    sample_data: sampleData,
  } satisfies LocationFoundAnswers);
});
