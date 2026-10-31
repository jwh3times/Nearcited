import { open, seal } from "./seal";

/**
 * Signing in with Google (issue #144, `docs/adr/0029-analytics-counts-are-kept-apart-from-the-lines.md`).
 *
 * An owner or admin agrees on Google's own screen and Google sends them back to a page of the web
 * app, which posts the code to the API. The refresh token that comes of it is the sign-in. The
 * access token each read needs is asked for from it and used only for that read. Nothing here knows
 * what the sign-in is for: another Google connection can use it as it stands.
 */

const SIGN_IN = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const TIMEOUT_MS = 15_000;
/** How long someone has to agree on Google's screen before they must start again. */
const STATE_LASTS_MS = 10 * 60_000;

/** This deployment's project at Google. */
export interface GoogleApp {
  client_id: string;
  client_secret: string;
}

export interface GoogleDeps {
  /** How Google is reached. The tests put a made-up one here. */
  fetch?: typeof fetch;
}

/** Google refused the sign-in: its owner took the access away, or it lapsed. */
export class GoogleRefused extends Error {
  constructor(message = "Google refused the sign-in.") {
    super(message);
    this.name = "GoogleRefused";
  }
}

/** What a `state` is sealed to: only this caller, for this organization, can bring it back. */
const stateFor = (userId: string, organizationId: string) =>
  `google-state:${userId}:${organizationId}`;

/** A `state` for Google to hand back: bound to a caller and an organization, and short-lived. */
export const googleState = (
  key: CryptoKey,
  userId: string,
  organizationId: string,
  now = new Date(),
): Promise<string> =>
  seal(key, stateFor(userId, organizationId), String(now.getTime() + STATE_LASTS_MS));

/** Whether a `state` was made for this caller and organization, unchanged and in time. */
export async function googleStateIsGood(
  key: CryptoKey,
  state: string,
  userId: string,
  organizationId: string,
  now = new Date(),
): Promise<boolean> {
  try {
    return Number(await open(key, stateFor(userId, organizationId), state)) > now.getTime();
  } catch {
    return false;
  }
}

/**
 * Where to send someone to agree: for the one scope and no other, and for a sign-in that lasts.
 * Google gives a refresh token only the first time it is asked, unless it is asked to show its
 * screen again.
 */
export function googleSignInAddress(
  app: GoogleApp,
  { redirectUri, scope, state }: { redirectUri: string; scope: string; state: string },
): string {
  const url = new URL(SIGN_IN);
  url.search = new URLSearchParams({
    client_id: app.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    state,
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return url.toString();
}

const post = (url: string, form: Record<string, string>, deps: GoogleDeps) =>
  (deps.fetch ?? fetch)(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

/** The `error` Google's sign-in endpoints answered with, if it can be read. */
async function errorOf(response: Response): Promise<string | null> {
  try {
    const { error } = (await response.json()) as { error?: unknown };
    return typeof error === "string" ? error : null;
  } catch {
    return null;
  }
}

/** What a code comes to: the sign-in, where Google gave one, and the scopes it was given for. */
export interface GoogleSwapped {
  refreshToken: string | null;
  scopes: string[];
}

/** Swaps a code for the sign-in. `GoogleRefused` where Google will not take the code. */
export async function swapCode(
  app: GoogleApp,
  code: string,
  redirectUri: string,
  deps: GoogleDeps = {},
): Promise<GoogleSwapped> {
  const response = await post(
    TOKEN,
    {
      grant_type: "authorization_code",
      code,
      client_id: app.client_id,
      client_secret: app.client_secret,
      redirect_uri: redirectUri,
    },
    deps,
  );
  if (!response.ok) {
    if ((await errorOf(response)) === "invalid_grant") throw new GoogleRefused();
    throw new Error(`Google answered ${response.status} to a code.`);
  }
  const answered = (await response.json()) as { refresh_token?: unknown; scope?: unknown };
  return {
    refreshToken: typeof answered.refresh_token === "string" ? answered.refresh_token : null,
    scopes: typeof answered.scope === "string" ? answered.scope.split(" ") : [],
  };
}

/** An access token from a sign-in, for one read. `GoogleRefused` where the sign-in is no good. */
export async function accessTokenFor(
  app: GoogleApp,
  refreshToken: string,
  deps: GoogleDeps = {},
): Promise<string> {
  const response = await post(
    TOKEN,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: app.client_id,
      client_secret: app.client_secret,
    },
    deps,
  );
  if (!response.ok) {
    if ((await errorOf(response)) === "invalid_grant") throw new GoogleRefused();
    throw new Error(`Google answered ${response.status} to a refresh.`);
  }
  const { access_token: token } = (await response.json()) as { access_token?: unknown };
  if (typeof token !== "string") throw new Error("Google answered a refresh with no access token.");
  return token;
}

/**
 * Takes a sign-in back at Google. True where Google no longer holds it, which is also so of one it
 * says is not a token any more: it was taken back already. False where Google could not be asked.
 */
export async function withdrawSignIn(
  refreshToken: string,
  deps: GoogleDeps = {},
): Promise<boolean> {
  const response = await post(REVOKE, { token: refreshToken }, deps);
  if (response.ok) return true;
  return (await errorOf(response)) === "invalid_token";
}
