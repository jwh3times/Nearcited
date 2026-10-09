import {
  ATTENTION_WINDOW_MS,
  buildOperatorOverview,
  type OperatorOverview,
} from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { ApiError, notFound } from "../errors";
import { usesSampleData } from "../providers";
import type { Store } from "../store/types";
import { uuidParam } from "../validation";

/**
 * The operator's view: every organization, read through the same store as any request. The
 * database lets the operator read every row and write none of a customer's
 * (docs/adr/0004-the-operator-reads-through-policies.md), so nothing here uses the secret key.
 */
export const operatorRoutes = new Hono<AppEnv>();

/**
 * Everything under /operator answers only the operator. To anyone else it does not exist: the
 * store's "every" reads would otherwise hand a member their own rows dressed as the whole product.
 */
operatorRoutes.use("/operator/*", async (c, next) => {
  const role = await c.get("store").getPlatformRole(c.get("user").id);
  if (role !== "operator") throw new ApiError(404, "not_found", "Not found");
  await next();
});

/** How far back scans are read. The missed-scan check looks no further than the attention window. */
const sinceWindow = (now: Date) => new Date(now.getTime() - ATTENTION_WINDOW_MS).toISOString();

async function overview(store: Store, now: Date) {
  const [organizations, locations, activePrompts, scans, audits, mine] = await Promise.all([
    store.listEveryOrganization(),
    store.listEveryLocation(),
    store.countActiveQueries(),
    store.listScansSince(sinceWindow(now)),
    store.listEveryAudit(),
    store.listOrganizations(),
  ]);
  return buildOperatorOverview({
    now,
    operatorOrganizationIds: mine.map((organization) => organization.id),
    organizations,
    locations,
    activePrompts,
    scans,
    audits,
  });
}

operatorRoutes.get("/operator/overview", async (c) => {
  const body: OperatorOverview = {
    ...(await overview(c.get("store"), new Date())),
    deployment: {
      sample_data: usesSampleData(c.env),
      models: c.get("deployment").models,
      commit: c.env.COMMIT?.trim().slice(0, 7) || null,
    },
  };
  return c.json(body);
});

/** One organization, for reading through its pages. */
operatorRoutes.get("/operator/organizations/:organizationId", async (c) => {
  const id = uuidParam(c, "organizationId", "Organization");
  const organization = await c.get("store").getOrganization(id);
  if (!organization) throw notFound("Organization");
  return c.json(organization);
});
