import {
  ActionSchema,
  AlertSchema,
  ApiErrorSchema,
  type AssistantChoice,
  type AuditFormValues,
  BillingRedirectSchema,
  type CheckoutInput,
  type ConnectionKind,
  ConnectionMatchSchema,
  ConnectionSchema,
  DraftSchema,
  LimitChangeSchema,
  ListingSchema,
  LocationActionsSchema,
  type LocationDetail,
  LocationDetailSchema,
  type LocationFormValues,
  LocationLineSchema,
  LocationSchema,
  MeSchema,
  OperatorAccountsSchema,
  OperatorAuditSchema,
  OperatorOverviewSchema,
  OperatorPlanSchema,
  OperatorSpendSchema,
  OrganizationAccountSchema,
  OrganizationConnectionsSchema,
  type OrganizationLimits,
  OrganizationSchema,
  type PlanChangeInput,
  PlanImpactSchema,
  type PlanPricesInput,
  PlanSchema,
  type PlanSettings,
  PriceChangeSchema,
  PublicAuditSchema,
  RecommendationSchema,
  type RecommendationStatus,
  ScanSchema,
  SubscriptionChangeSchema,
  type TrackedQueryInput,
  TrackedQuerySchema,
  WaitingActionsSchema,
} from "@nearcited/shared";
import type { z } from "zod";
import { supabase } from "./supabase";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const session = (await supabase?.auth.getSession())?.data.session;
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.ok) return response;

  const parsed = ApiErrorSchema.safeParse(await response.json().catch(() => null));
  throw parsed.success
    ? new ApiRequestError(response.status, parsed.data.error.code, parsed.data.error.message)
    : new ApiRequestError(response.status, "unknown", `The server returned ${response.status}.`);
}

/** Every response is parsed against the shared schema, so a drifted API fails here, not in a component. */
async function json<S extends z.ZodType>(
  schema: S,
  method: string,
  path: string,
  body?: unknown,
): Promise<z.output<S>> {
  return schema.parse(await (await send(method, path, body)).json());
}

export const api = {
  /** A shareable audit. The one call that needs no sign-in. */
  getAudit: (token: string) =>
    json(PublicAuditSchema, "GET", `/audits/${encodeURIComponent(token)}`),
  /** The price list. Needs no sign-in. */
  plans: () => json(PlanSchema.array(), "GET", "/plans"),
  me: () => json(MeSchema, "GET", "/me"),
  createOrganization: (name: string) =>
    json(OrganizationSchema, "POST", "/organizations", { name }),
  /** The operator's first screen. Answers 404 to anyone else. */
  operatorOverview: () => json(OperatorOverviewSchema, "GET", "/operator/overview"),
  /** What the providers were paid, by month. Dollars only: the rates stay on the server. */
  operatorSpend: () => json(OperatorSpendSchema, "GET", "/operator/spend"),
  operatorAccounts: () => json(OperatorAccountsSchema, "GET", "/operator/accounts"),
  operatorAudits: () => json(OperatorAuditSchema.array(), "GET", "/operator/audits"),
  /** Makes a shareable audit and queues it. Refused where scans return sample data. */
  createAudit: (input: AuditFormValues) =>
    json(OperatorAuditSchema, "POST", "/operator/audits", input),
  /** An organization the operator is reading through. */
  operatorOrganization: (id: string) =>
    json(OrganizationSchema, "GET", `/operator/organizations/${id}`),
  /** Every plan, on sale or not, with who is on it. */
  operatorPlans: () => json(OperatorPlanSchema.array(), "GET", "/operator/plans"),
  /** Who a change to a plan would reach. Changes nothing. */
  planImpact: (key: string, settings: PlanSettings) =>
    json(PlanImpactSchema, "POST", `/operator/plans/${key}/impact`, settings),
  /** Changes what a plan allows, for every organization on it at once. */
  setPlan: (key: string, change: PlanChangeInput) =>
    json(PlanSchema, "PUT", `/operator/plans/${key}`, change),
  /** Calls off a plan's announced reduction, and tells everyone who was told. */
  callOffLimitChange: (key: string) =>
    json(LimitChangeSchema, "DELETE", `/operator/plans/${key}/limit-change`),
  /** Sets what a new subscriber pays for a plan. Current subscribers keep their price. */
  setPlanPrices: (key: string, prices: PlanPricesInput) =>
    json(PlanSchema, "PUT", `/operator/plans/${key}/prices`, prices),
  /** Announces a plan's present prices to its current subscribers, from a day. Emails them. */
  announcePriceChange: (key: string, effective_on: string) =>
    json(PriceChangeSchema, "POST", `/operator/plans/${key}/price-change`, { effective_on }),
  /** Calls off a plan's announced price change, and tells everyone who was told. */
  callOffPriceChange: (key: string) =>
    json(PriceChangeSchema, "DELETE", `/operator/plans/${key}/price-change`),
  /** The one thing the operator changes on a customer's account. */
  setOrganizationLimits: (id: string, limits: OrganizationLimits) =>
    json(OrganizationSchema, "PUT", `/operator/organizations/${id}/limits`, limits),
  /** Which assistants the organization is checked on, within what its plan covers. */
  chooseAssistants: (id: string, surfaces: AssistantChoice["surfaces"]) =>
    json(OrganizationSchema, "PUT", `/organizations/${id}/assistants`, { surfaces }),
  /** This month's use, and for the owner alone where billing stands. */
  organizationAccount: (id: string) =>
    json(OrganizationAccountSchema, "GET", `/organizations/${id}/account`),
  /** Where the payment provider's checkout is, for the owner to be sent to. Charges nothing. */
  checkout: (id: string, input: CheckoutInput) =>
    json(BillingRedirectSchema, "POST", `/organizations/${id}/checkout`, input),
  /** Where the payment provider's account pages are: payment method, invoices, cancelling. */
  billingPortal: (id: string) =>
    json(BillingRedirectSchema, "POST", `/organizations/${id}/billing-portal`),
  /** What changing plan or the number of locations would come to. Changes nothing. */
  previewSubscriptionChange: (id: string, input: CheckoutInput) =>
    json(SubscriptionChangeSchema, "POST", `/organizations/${id}/subscription/preview`, input),
  /** Makes the change: an upgrade now, charging the card; a downgrade when the period ends. */
  changeSubscription: (id: string, input: CheckoutInput) =>
    json(SubscriptionChangeSchema, "PUT", `/organizations/${id}/subscription`, input),
  /** Drops a change that was waiting for the period to end. */
  keepCurrentPlan: (id: string) => send("DELETE", `/organizations/${id}/subscription/pending`),
  /** What is waiting for a yes at a location, and the record of what was done. */
  locationActions: (locationId: string) =>
    json(LocationActionsSchema, "GET", `/locations/${locationId}/actions`),
  /** How many actions wait for a yes, by location. */
  waitingActions: (organizationId: string) =>
    json(WaitingActionsSchema, "GET", `/organizations/${organizationId}/actions/waiting`),
  /** A yes to one action. `text` is sent only when the reader changed it. */
  approveAction: (id: string, text?: string) =>
    json(ActionSchema, "POST", `/actions/${id}/approve`, text === undefined ? {} : { text }),
  declineAction: (id: string, reason?: string) =>
    json(ActionSchema, "POST", `/actions/${id}/decline`, reason ? { reason } : {}),
  /** Asks for a failed action again. */
  retryAction: (id: string) => json(ActionSchema, "POST", `/actions/${id}/retry`),
  /** Takes an alert off the page. It is raised again only once it has ended and begun afresh. */
  dismissAlert: (id: string) => json(AlertSchema, "POST", `/alerts/${id}/dismiss`),
  /** What an organization has connected, what it could connect, and whether the reader may. */
  connections: (organizationId: string) =>
    json(OrganizationConnectionsSchema, "GET", `/organizations/${organizationId}/connections`),
  connect: (organizationId: string, kind: ConnectionKind) =>
    json(ConnectionSchema, "POST", `/organizations/${organizationId}/connections`, { kind }),
  /** Asks for a connection to be removed. The worker finishes it shortly after. */
  removeConnection: (id: string) => json(ConnectionSchema, "DELETE", `/connections/${id}`),
  /** Says which of the things a connection reaches is a location's. */
  matchConnectionLocation: (connectionId: string, locationId: string, externalId: string) =>
    json(ConnectionMatchSchema, "PUT", `/connections/${connectionId}/locations/${locationId}`, {
      external_id: externalId,
    }),
  unmatchConnectionLocation: (connectionId: string, locationId: string) =>
    send("DELETE", `/connections/${connectionId}/locations/${locationId}`).then(() => undefined),
  renameOrganization: (id: string, name: string) =>
    json(OrganizationSchema, "PATCH", `/organizations/${id}`, { name }),
  listLocations: (organizationId: string) =>
    json(LocationSchema.array(), "GET", `/organizations/${organizationId}/locations`),
  createLocation: (organizationId: string, input: LocationFormValues) =>
    json(LocationSchema, "POST", `/organizations/${organizationId}/locations`, input),
  getLocation: (id: string): Promise<LocationDetail> =>
    json(LocationDetailSchema, "GET", `/locations/${id}`),
  /** The whole form goes back: the API replaces every field a user may set that it is sent. */
  updateLocation: (id: string, input: LocationFormValues) =>
    json(LocationSchema, "PATCH", `/locations/${id}`, input),
  deleteLocation: (id: string) => send("DELETE", `/locations/${id}`),
  createQuery: (locationId: string, input: TrackedQueryInput) =>
    json(TrackedQuerySchema, "POST", `/locations/${locationId}/queries`, input),
  setQueryActive: (id: string, is_active: boolean) =>
    json(TrackedQuerySchema, "PATCH", `/queries/${id}`, { is_active }),
  /** Brings a location the plan paused back into use, in place of `insteadOf` when there is no room. */
  activateLocation: (locationId: string, insteadOf: string | null) =>
    json(LocationSchema, "POST", `/locations/${locationId}/activate`, { instead_of: insteadOf }),
  startScan: (locationId: string) => json(ScanSchema, "POST", `/locations/${locationId}/scans`),
  listScans: (locationId: string) =>
    json(ScanSchema.array(), "GET", `/locations/${locationId}/scans`),
  setRecommendationStatus: (id: string, status: RecommendationStatus) =>
    json(RecommendationSchema, "PATCH", `/recommendations/${id}`, { status }),
  setRecommendationActed: (id: string, acted: boolean) =>
    json(RecommendationSchema, "PATCH", `/recommendations/${id}`, { acted }),
  /** Asks for a draft of one task, the first or another. The worker writes it on its own time. */
  askDraft: (locationId: string, taskId: string) =>
    json(DraftSchema, "POST", `/locations/${locationId}/tasks/${taskId}/draft`),
  /** Gives the address of a location's own page on a site, the first time or in place of another. */
  setListing: (locationId: string, site: string, url: string) =>
    json(ListingSchema, "PUT", `/locations/${locationId}/listings/${site}`, { url }),
  removeListing: (locationId: string, site: string) =>
    send("DELETE", `/locations/${locationId}/listings/${site}`).then(() => undefined),
  /** A location's line: the key its site carries, the line to paste, and when it last answered. */
  getLine: (locationId: string) => json(LocationLineSchema, "GET", `/locations/${locationId}/line`),
  /** Gives a location a new site key. The line on the site counts nothing until pasted again. */
  replaceSiteKey: (locationId: string) =>
    json(LocationLineSchema, "POST", `/locations/${locationId}/line/key`),
};
