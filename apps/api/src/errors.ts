import type { ContentfulStatusCode } from "hono/utils/http-status";

/** An error the API reports to the caller as `{ error: { code, message } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);
