import type { Env } from "./env";
import { createSupabaseStore, createUserClient } from "./store/supabase";
import type { Store } from "./store/types";

export interface AuthedUser {
  id: string;
  email: string | null;
}

export interface Identity {
  user: AuthedUser;
  /** A store that acts as this user. */
  store: Store;
}

/** Resolves who is calling, or null when there is no valid token. */
export type Authenticate = (request: Request, env: Env) => Promise<Identity | null>;

/**
 * Verifies a Supabase access token and returns a store bound to that user.
 *
 * `getClaims` checks the signature against the project's published signing keys and caches them,
 * so most requests verify without a network call. On a project still using a legacy shared JWT
 * secret it falls back to asking the Auth server on every request; move such a project to
 * asymmetric signing keys.
 */
export const authenticateWithSupabase: Authenticate = async (request, env) => {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;

  const client = createUserClient(env, token);
  const { data, error } = await client.auth.getClaims(token);
  if (error || !data) return null;

  const { sub, email, role } = data.claims;
  if (!sub || role !== "authenticated") return null;

  return {
    user: { id: sub, email: typeof email === "string" ? email : null },
    store: createSupabaseStore(client),
  };
};
