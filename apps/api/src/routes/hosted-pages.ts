import {
  type AnswerSubdomain,
  AnswerSubdomainInputSchema,
  answerHostname,
  HOSTED_PAGES_ALLOWANCE,
  type Location,
  type LocationHostedPages,
  type Organization,
  RECORD_WAIT_DAYS,
  recordTarget,
  subdomainLabel,
  underWebsite,
} from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { hostingConfigured } from "../connections";
import { lookUp, newTarget } from "../connections/hosted";
import type { Env } from "../env";
import { ApiError, notFound } from "../errors";
import { usesSampleData } from "../providers";
import { type KeptAnswerSubdomain, type Store, StoreError } from "../store/types";
import { parseJson, uuidParam } from "../validation";
import { requireLocation } from "./locations";

/**
 * A location's hosted pages: the answer subdomain its owner points at the product with one DNS
 * record, once (issue #141). Any member reads it; only an owner or admin makes one, and removes
 * one as any connection is removed.
 */
export const hostedPagesRoutes = new Hono<AppEnv>();

/**
 * What stands in the way of a location having hosted pages, or null where nothing does. A test
 * organization has none, since its pages would go out under a real domain; a deployment that can
 * register no subdomain to be served offers none, except on sample data, where nothing is
 * registered anywhere.
 */
async function barred(
  env: Env,
  store: Store,
  organization: Organization,
  location: Location,
): Promise<LocationHostedPages["barred"]> {
  if (organization.is_test || organization.allowances[HOSTED_PAGES_ALLOWANCE] === undefined) {
    return "not_included";
  }
  if (!usesSampleData(env) && !hostingConfigured(env)) return "unavailable";
  const held = await store.listLocationConnections(location.id);
  if (held.some((connection) => connection.kind === "wordpress")) return "wordpress";
  if (!location.website) return "no_website";
  return null;
}

/** An answer subdomain as a member is sent it: what the worker keeps for itself left out. */
export function sentAnswerSubdomain(
  kept: KeptAnswerSubdomain,
  website: string | null,
): AnswerSubdomain {
  const waiting = kept.registered_at === null && kept.status === "working";
  return {
    connection_id: kept.connection_id,
    location_id: kept.location_id ?? "",
    hostname: kept.hostname,
    target: recordTarget(kept.target),
    record: kept.record,
    checked_at: kept.checked_at,
    registered_at: kept.registered_at,
    live_at: kept.live_at,
    home_links: kept.home_links,
    website_matches: underWebsite(kept.hostname, website),
    waits_until: waiting
      ? new Date(Date.parse(kept.connected_at) + RECORD_WAIT_DAYS * 86_400_000).toISOString()
      : null,
    status: kept.status,
    paused_at: kept.paused_at,
  };
}

/** A location's hosted pages, for anyone who can read the location. */
hostedPagesRoutes.get("/locations/:locationId/hosted-pages", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  const organization = await store.getOrganization(location.organization_id);
  if (!organization) throw notFound("Location");
  const [bar, canManage, kept] = await Promise.all([
    barred(c.env, store, organization, location),
    store.managesConnections(organization.id),
    store.getLocationAnswerSubdomain(location.id),
  ]);
  return c.json({
    barred: bar,
    can_manage: canManage,
    subdomain: kept ? sentAnswerSubdomain(kept, location.website) : null,
  } satisfies LocationHostedPages);
});

const BARRED: Record<NonNullable<LocationHostedPages["barred"]>, ApiError> = {
  not_included: new ApiError(
    422,
    "connection_unavailable",
    "This organization's plan does not include hosted pages.",
  ),
  unavailable: new ApiError(
    503,
    "hosted_pages_unavailable",
    "Hosted pages cannot be set up here yet: this deployment cannot serve them.",
  ),
  wordpress: new ApiError(
    409,
    "wordpress_connected",
    "This location's WordPress site is connected, so its pages are published there.",
  ),
  no_website: new ApiError(422, "no_website", "Add this location's website under Settings first."),
};

/**
 * Makes the location's answer subdomain: the name its owner chose in front of the website's
 * domain, pointed at a target of its own. Owner or admin only. A name that already points
 * somewhere is refused, so a subdomain in use is not broken. The worker then looks for the
 * record, and registers the name to be served only once it points at this connection's target.
 */
hostedPagesRoutes.post("/locations/:locationId/hosted-pages", async (c) => {
  const { label: typed } = await parseJson(c, AnswerSubdomainInputSchema);
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  const organization = await store.getOrganization(location.organization_id);
  if (!organization || !(await store.managesConnections(organization.id))) {
    throw notFound("Location");
  }
  const bar = await barred(c.env, store, organization, location);
  if (bar) throw BARRED[bar];
  if (await store.getLocationAnswerSubdomain(location.id)) {
    throw new ApiError(409, "already_connected", "This location has an answer subdomain already.");
  }
  const label = subdomainLabel(typed);
  const hostname = label ? answerHostname(label, location.website) : null;
  if (!label || !hostname) {
    throw new ApiError(
      422,
      "bad_label",
      "Use one word of letters, digits and hyphens, such as “answers”.",
    );
  }
  // On sample data nothing goes out, so nothing is looked up either.
  if (!usesSampleData(c.env) && (await lookUp(hostname, null)) !== "missing") {
    throw new ApiError(
      422,
      "in_use",
      `${hostname} already points somewhere. Choose another name, so nothing using it breaks.`,
    );
  }

  const id = crypto.randomUUID();
  let made: Awaited<ReturnType<Store["createAnswerSubdomain"]>>;
  try {
    made = await store.createAnswerSubdomain({
      id,
      location_id: location.id,
      label,
      target: newTarget(),
    });
  } catch (error) {
    if (error instanceof StoreError && error.kind === "conflict") {
      throw new ApiError(409, "taken", `${hostname} is already being set up. Choose another name.`);
    }
    throw error;
  }
  if (!made) throw notFound("Location");
  const kept = await store.getLocationAnswerSubdomain(location.id);
  if (!kept) throw notFound("Location");
  // The worker looks for the record now, and the schedule keeps looking until it appears.
  try {
    await c.env.SCAN_QUEUE.send({ connection_id: id, step: "sync" });
  } catch (error) {
    console.error(`Connection ${id}: could not queue its first check, the schedule will`, error);
  }
  return c.json(sentAnswerSubdomain(kept, location.website), 201);
});
