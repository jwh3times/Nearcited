import {
  ApiErrorSchema,
  type AssistantChoice,
  type AuditFormValues,
  type LocationDetail,
  LocationDetailSchema,
  type LocationFormValues,
  LocationSchema,
  MeSchema,
  OperatorAccountsSchema,
  OperatorAuditSchema,
  OperatorOverviewSchema,
  OperatorSpendSchema,
  type OrganizationLimits,
  OrganizationSchema,
  PlanSchema,
  PublicAuditSchema,
  RecommendationSchema,
  type RecommendationStatus,
  ScanSchema,
  type TrackedQueryInput,
  TrackedQuerySchema,
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
  /** The one thing the operator changes on a customer's account. */
  setOrganizationLimits: (id: string, limits: OrganizationLimits) =>
    json(OrganizationSchema, "PUT", `/operator/organizations/${id}/limits`, limits),
  /** Which assistants the organization is checked on, within what its plan covers. */
  chooseAssistants: (id: string, surfaces: AssistantChoice["surfaces"]) =>
    json(OrganizationSchema, "PUT", `/organizations/${id}/assistants`, { surfaces }),
  renameOrganization: (id: string, name: string) =>
    json(OrganizationSchema, "PATCH", `/organizations/${id}`, { name }),
  listLocations: (organizationId: string) =>
    json(LocationSchema.array(), "GET", `/organizations/${organizationId}/locations`),
  createLocation: (organizationId: string, input: LocationFormValues) =>
    json(LocationSchema, "POST", `/organizations/${organizationId}/locations`, input),
  getLocation: (id: string): Promise<LocationDetail> =>
    json(LocationDetailSchema, "GET", `/locations/${id}`),
  /** The whole form goes back: the API replaces every field a user may set. */
  updateLocation: (id: string, input: LocationFormValues) =>
    json(LocationSchema, "PATCH", `/locations/${id}`, input),
  deleteLocation: (id: string) => send("DELETE", `/locations/${id}`),
  createQuery: (locationId: string, input: TrackedQueryInput) =>
    json(TrackedQuerySchema, "POST", `/locations/${locationId}/queries`, input),
  setQueryActive: (id: string, is_active: boolean) =>
    json(TrackedQuerySchema, "PATCH", `/queries/${id}`, { is_active }),
  startScan: (locationId: string) => json(ScanSchema, "POST", `/locations/${locationId}/scans`),
  listScans: (locationId: string) =>
    json(ScanSchema.array(), "GET", `/locations/${locationId}/scans`),
  setRecommendationStatus: (id: string, status: RecommendationStatus) =>
    json(RecommendationSchema, "PATCH", `/recommendations/${id}`, { status }),
};
