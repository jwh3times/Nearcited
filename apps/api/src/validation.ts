import type { Context } from "hono";
import { z } from "zod";
import { ApiError, notFound } from "./errors";

export async function parseJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) =>
        issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      )
      .join("; ");
    throw new ApiError(422, "validation_failed", message);
  }
  return result.data;
}

const Uuid = z.uuid();

/** A path parameter that must be a UUID. Anything else cannot name a row, so it is a 404. */
export function uuidParam(c: Context, name: string, what: string): string {
  const parsed = Uuid.safeParse(c.req.param(name));
  if (!parsed.success) throw notFound(what);
  return parsed.data;
}
