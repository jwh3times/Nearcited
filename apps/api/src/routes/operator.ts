import {
  ATTENTION_WINDOW_MS,
  AuditInputSchema,
  buildAccounts,
  buildOperatorOverview,
  type OperatorAccounts,
  type OperatorAudit,
  type OperatorOverview,
  OrganizationLimitsSchema,
} from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { ApiError, notFound } from "../errors";
import { usesSampleData } from "../providers";
import type { ListedAudit, Store } from "../store/types";
import { parseJson, uuidParam } from "../validation";

/**
 * The operator's view: every organization, read through the same store as any request. The
 * database lets the operator read every row and write none of a customer's
 * (docs/adr/0004-the-operator-reads-through-policies.md), so nothing here uses the secret key.
 * The one thing the operator changes is an organization's limits, through a database function
 * that answers nobody else (docs/adr/0005-the-operator-changes-limits-through-one-function.md).
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

/** Who has signed up, and how far each account has got. */
operatorRoutes.get("/operator/accounts", async (c) => {
  const store = c.get("store");
  const [accounts, roles, memberships, organizations, locations] = await Promise.all([
    store.listAccounts(),
    store.listPlatformRoles(),
    store.listEveryMembership(),
    store.listEveryOrganization(),
    store.listEveryLocation(),
  ]);
  const body: OperatorAccounts = buildAccounts({
    now: new Date(),
    accounts,
    roles,
    memberships,
    organizations,
    locations,
  });
  return c.json(body);
});

/** An audit as the operator's list shows it, with its link only while the link works. */
function listed({ token, ...audit }: ListedAudit, appUrl: string, now: string): OperatorAudit {
  const app = appUrl.replace(/\/$/, "");
  return {
    ...audit,
    link: audit.revoked_at === null && audit.expires_at > now ? `${app}/audit/${token}` : null,
  };
}

/**
 * Every shareable audit. They belong to no organization, so this is the only list they are on.
 * The link is given only while it works: holding it is the permission to read the report.
 */
operatorRoutes.get("/operator/audits", async (c) => {
  const now = new Date().toISOString();
  const body: OperatorAudit[] = (await c.get("store").listEveryAudit()).map((audit) =>
    listed(audit, c.env.APP_URL, now),
  );
  return c.json(body);
});

/**
 * Makes a shareable audit and queues it, one message per prompt. An audit is shown to a prospect
 * as a measurement, so a deployment serving sample data refuses to make one at all.
 */
operatorRoutes.post("/operator/audits", async (c) => {
  const input = await parseJson(c, AuditInputSchema);
  if (usesSampleData(c.env)) {
    throw new ApiError(
      409,
      "audits_unavailable",
      "Audits need live data, and this deployment serves sample data.",
    );
  }
  const audit = await c.get("store").createAudit(input);
  if (!audit) throw new ApiError(404, "not_found", "Not found");
  // If a send fails the row stays "queued" with nothing behind it. The request returns an error,
  // and the sweep in the scheduled handler fails the audit, so its link does not wait for ever.
  await c.env.SCAN_QUEUE.sendBatch(
    input.prompts.map((_, prompt_index) => ({ body: { audit_id: audit.id, prompt_index } })),
  );
  return c.json(listed(audit, c.env.APP_URL, new Date().toISOString()), 201);
});

/** One organization, for reading through its pages. */
operatorRoutes.get("/operator/organizations/:organizationId", async (c) => {
  const id = uuidParam(c, "organizationId", "Organization");
  const organization = await c.get("store").getOrganization(id);
  if (!organization) throw notFound("Organization");
  return c.json(organization);
});

/** Changes what an organization's plan allows. The database records who changed what. */
operatorRoutes.put("/operator/organizations/:organizationId/limits", async (c) => {
  const id = uuidParam(c, "organizationId", "Organization");
  const limits = await parseJson(c, OrganizationLimitsSchema);
  const organization = await c.get("store").setOrganizationLimits(id, limits);
  if (!organization) throw notFound("Organization");
  return c.json(organization);
});
