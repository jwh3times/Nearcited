import {
  ApiErrorSchema,
  type LocationDetail,
  LocationDetailSchema,
  type LocationFormValues,
  LocationSchema,
  MeSchema,
  OrganizationSchema,
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
  me: () => json(MeSchema, "GET", "/me"),
  createOrganization: (name: string) =>
    json(OrganizationSchema, "POST", "/organizations", { name }),
  listLocations: (organizationId: string) =>
    json(LocationSchema.array(), "GET", `/organizations/${organizationId}/locations`),
  createLocation: (organizationId: string, input: LocationFormValues) =>
    json(LocationSchema, "POST", `/organizations/${organizationId}/locations`, input),
  getLocation: (id: string): Promise<LocationDetail> =>
    json(LocationDetailSchema, "GET", `/locations/${id}`),
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
