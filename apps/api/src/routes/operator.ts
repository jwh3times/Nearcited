import {
  ATTENTION_WINDOW_MS,
  AuditInputSchema,
  buildAccounts,
  buildOperatorOverview,
  buildOperatorPlans,
  buildSpend,
  monthOf,
  monthStart,
  type OperatorAccounts,
  type OperatorAudit,
  type OperatorOverview,
  type OperatorPlan,
  type OperatorSpend,
  OrganizationLimitsSchema,
  PlanChangeInputSchema,
  type PlanImpact,
  PlanPricesInputSchema,
  PlanSettingsSchema,
  PriceChangeInputSchema,
  planImpact,
  reductions,
  withoutReductions,
} from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { enqueueLimitChangeSteps } from "../billing/limit-change";
import { enqueuePriceChangeSteps } from "../billing/price-change";
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

/** How many calendar months of spend are shown, counting this one. */
const SPEND_MONTHS = 3;

/**
 * What the providers were paid, by calendar month in UTC. The counts come from the database and
 * the rates from the tuning; only the dollars leave the server.
 */
operatorRoutes.get("/operator/spend", async (c) => {
  const store = c.get("store");
  const now = new Date();
  const [usage, organizations, mine] = await Promise.all([
    store.listUsageByMonth(monthStart(monthOf(now, SPEND_MONTHS - 1))),
    store.listEveryOrganization(),
    store.listOrganizations(),
  ]);
  const body: OperatorSpend = buildSpend({
    now,
    months: SPEND_MONTHS,
    rates: c.get("deployment").rates ?? {},
    operatorOrganizationIds: mine.map((organization) => organization.id),
    organizations,
    usage,
  });
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

/** Every plan, on sale or not, with who is on it. */
operatorRoutes.get("/operator/plans", async (c) => {
  const store = c.get("store");
  const [plans, organizations, subscriptions, priceChanges, limitChanges] = await Promise.all([
    store.listPlans(),
    store.listEveryOrganization(),
    store.listEverySubscription(),
    store.listOpenPriceChanges(),
    store.listOpenLimitChanges(),
  ]);
  const limitNotices = (
    await Promise.all(limitChanges.map((change) => store.listLimitChangeNotices(change.id)))
  ).flat();
  const notices = (
    await Promise.all(priceChanges.map((change) => store.listPriceChangeNotices(change.id)))
  ).flat();
  return c.json(
    buildOperatorPlans({
      plans,
      organizations,
      subscriptions,
      priceChanges,
      notices,
      limitChanges,
      limitNotices,
    }) satisfies OperatorPlan[],
  );
});

/** A plan's key as it is in the database. Anything else cannot name one, so it is a 404. */
const PLAN_KEY = /^[a-z][a-z0-9_]{1,30}$/;

function planKey(key: string): string {
  if (!PLAN_KEY.test(key)) throw notFound("Plan");
  return key;
}

/**
 * Who a change to a plan would reach, for the operator to read before lowering a limit. Changes
 * nothing.
 */
operatorRoutes.post("/operator/plans/:key/impact", async (c) => {
  const key = planKey(c.req.param("key"));
  const settings = await parseJson(c, PlanSettingsSchema);
  const store = c.get("store");
  const [organizations, locations, activePrompts] = await Promise.all([
    store.listEveryOrganization(),
    store.listEveryLocation(),
    store.countActiveQueries(),
  ]);
  return c.json(
    planImpact(key, settings.max_queries_per_location, {
      organizations,
      locations,
      activePrompts,
    }) satisfies PlanImpact,
  );
});

/**
 * Changes what a plan allows, and the database records who changed what.
 *
 * Whatever is raised, the name and the on-sale flag are saved at once, for every organization on
 * the plan. Whatever is lowered depends on who pays. On a plan with subscribers it is announced
 * for `reduce_on`, at least thirty days out, everyone on the plan is emailed, and it is made on
 * the day; without the day the request is refused. On a plan nobody pays for it is made at once,
 * and on the free plan each organization is told the same day.
 */
operatorRoutes.put("/operator/plans/:key", async (c) => {
  const key = planKey(c.req.param("key"));
  const { reduce_on, ...settings } = await parseJson(c, PlanChangeInputSchema);
  const store = c.get("store");
  const plan = (await store.listPlans()).find((candidate) => candidate.key === key);
  if (!plan) throw notFound("Plan");

  const lowered = reductions(plan, settings);
  const lowers = Object.keys(lowered).length > 0;
  const paid = key !== "free" && (await store.listPlanSubscribers(key)).length > 0;
  if (!lowers || !paid) {
    const saved = await store.setPlan(key, settings);
    if (!saved) throw notFound("Plan");
    // A cut to the free plan was made just now. Its organizations are told, where email is set
    // up; where it is not, the cut stands and nobody is told.
    const made = lowers && key === "free" ? await store.getLatestMadeLimitChange(key) : null;
    if (made && c.env.RESEND_API_KEY) {
      await enqueueLimitChangeSteps(
        c.env.SCAN_QUEUE,
        made,
        await store.listPlanOrganizations(key),
        "announce",
      );
    }
    return c.json(saved);
  }

  if (!reduce_on) {
    throw new ApiError(
      409,
      "needs_notice",
      "Subscribers pay for this plan, so what it allows can only be lowered with 30 days' notice. Choose the day the reduction takes effect.",
    );
  }
  if (!c.env.RESEND_API_KEY) {
    throw new ApiError(
      503,
      "billing_unavailable",
      "A reduction has to be announced by email, and outgoing email is not set up here.",
    );
  }
  // The announcement first: if the day is refused, nothing else has been saved either.
  const change = await store.announceLimitChange(key, settings, `${reduce_on}T00:00:00.000Z`);
  if (!change) throw notFound("Plan");
  const saved = await store.setPlan(key, withoutReductions(plan, settings));
  if (!saved) throw notFound("Plan");
  await enqueueLimitChangeSteps(
    c.env.SCAN_QUEUE,
    change,
    await store.listPlanOrganizations(key),
    "announce",
  );
  return c.json(saved);
});

/**
 * Calls off a plan's announced reduction before its day. Everyone who was told is told it is
 * off.
 */
operatorRoutes.delete("/operator/plans/:key/limit-change", async (c) => {
  const key = planKey(c.req.param("key"));
  const store = c.get("store");
  const change = await store.callOffLimitChange(key);
  if (!change) throw notFound("Reduction");
  const told = (await store.listLimitChangeNotices(change.id))
    .filter((notice) => notice.announced_at !== null)
    .map((notice) => notice.organization_id);
  await enqueueLimitChangeSteps(c.env.SCAN_QUEUE, change, told, "call_off");
  return c.json(change);
});

/**
 * Sets what a new subscriber pays for a plan. The payment provider cannot edit a price, so two
 * new ones are made there, the plan's and its extra location's, and the plan is pointed at them.
 * Whoever already subscribes goes on paying what they were: nothing here touches a subscription.
 */
operatorRoutes.put("/operator/plans/:key/prices", async (c) => {
  const key = planKey(c.req.param("key"));
  const input = await parseJson(c, PlanPricesInputSchema);
  const payments = c.get("payments")();
  if (!payments) {
    throw new ApiError(503, "billing_unavailable", "No payment provider is set up here.");
  }
  const store = c.get("store");
  const [plans, prices] = await Promise.all([store.listPlans(), store.listPlanPrices()]);
  const plan = plans.find((candidate) => candidate.key === key);
  const sold = prices.find((candidate) => candidate.key === key);
  if (!plan || !sold) throw notFound("Plan");
  if (plan.price_cents === 0) {
    throw new ApiError(409, "free_plan", "The free plan has no price to change.");
  }
  if (
    sold.current?.price_cents === input.price_cents &&
    sold.current.extra_location_price_cents === input.extra_location_price_cents
  ) {
    throw new ApiError(422, "no_change", "That is what the plan is already sold at.");
  }

  // Both are made new, even when only one amount changed, so that either one names this
  // version of the plan's prices and no other.
  const stripe_price_id = await payments.createPrice({
    like: sold.current?.stripe_price_id ?? null,
    product_name: `Nearcited ${plan.name}`,
    cents: input.price_cents,
  });
  const stripe_extra_location_price_id =
    input.extra_location_price_cents === null
      ? null
      : await payments.createPrice({
          like: sold.current?.stripe_extra_location_price_id ?? null,
          product_name: `Nearcited ${plan.name}: extra location`,
          cents: input.extra_location_price_cents,
        });
  const saved = await store.setPlanPrices(key, {
    ...input,
    stripe_price_id,
    stripe_extra_location_price_id,
  });
  if (!saved) throw notFound("Plan");
  return c.json(saved);
});

/**
 * Announces a plan's present prices to the subscribers it already has: from the day given, each
 * is moved to them at its next renewal. The database refuses a day that gives a price rise less
 * than thirty days. The announcement emails are queued here, one organization to a message.
 *
 * Refused where no email can be sent: an announcement nobody receives is not notice.
 */
operatorRoutes.post("/operator/plans/:key/price-change", async (c) => {
  const key = planKey(c.req.param("key"));
  const { effective_on } = await parseJson(c, PriceChangeInputSchema);
  if (!c.get("payments")() || !c.env.RESEND_API_KEY) {
    throw new ApiError(
      503,
      "billing_unavailable",
      "A price change needs the payment provider and outgoing email, and one is not set up here.",
    );
  }
  const store = c.get("store");
  const change = await store.announcePriceChange(key, `${effective_on}T00:00:00.000Z`);
  if (!change) throw notFound("Plan");
  await enqueuePriceChangeSteps(
    c.env.SCAN_QUEUE,
    change,
    await store.listPlanSubscribers(key),
    "announce",
  );
  return c.json(change, 201);
});

/**
 * Calls off a plan's announced price change before it takes effect. Everyone who was told is
 * told it is off. New subscribers go on paying the plan's present price either way.
 */
operatorRoutes.delete("/operator/plans/:key/price-change", async (c) => {
  const key = planKey(c.req.param("key"));
  const store = c.get("store");
  const change = await store.callOffPriceChange(key);
  if (!change) throw notFound("Price change");
  const told = (await store.listPriceChangeNotices(change.id))
    .filter((notice) => notice.announced_at !== null)
    .map((notice) => notice.organization_id);
  await enqueuePriceChangeSteps(c.env.SCAN_QUEUE, change, told, "call_off");
  return c.json(change);
});
