import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { API_URL, PUBLISHABLE_KEY, SESSION_KEY, SUPABASE_URL } from "./stack";

/** A signed-in account that exists only for one test. */
export interface Account {
  email: string;
  /** The session as supabase-js stores it. */
  session: { access_token: string } & Record<string, unknown>;
}

let counter = 0;

/** An address nobody else in this run, or any earlier one, has used. */
export function freshEmail(label = "e2e"): string {
  counter += 1;
  return `${label}-${Date.now()}-${process.pid}-${counter}@example.com`;
}

/**
 * Makes an account and signs it in, without the emailed link. The app only offers the link, and
 * one test does go through it; the rest start here so they are not all waiting on a mailbox.
 */
export async function createAccount(): Promise<Account> {
  const email = freshEmail();
  const response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: `pw-${crypto.randomUUID()}` }),
  });
  const session = (await response.json()) as Account["session"];
  if (!response.ok || !session.access_token) {
    throw new Error(`Could not create ${email}: ${response.status} ${JSON.stringify(session)}`);
  }
  return { email, session };
}

/**
 * Signs in as an account that already exists, with its password. This is how the deployment's
 * test account gets in: it has no mailbox to read a link from.
 */
export async function signInWithPassword(email: string, password: string): Promise<Account> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const session = (await response.json()) as Account["session"];
  if (!response.ok || !session.access_token) {
    // Never the body: a failed sign-in's reply is not worth a secret ending up in a log.
    throw new Error(`Could not sign in as ${email}: status ${response.status}.`);
  }
  return { email, session };
}

/** Opens the app already signed in as the account. */
export async function signIn(page: Page, account: Account, path = "/"): Promise<void> {
  await page.addInitScript(
    ([key, session]) => window.localStorage.setItem(key as string, session as string),
    [SESSION_KEY, JSON.stringify(account.session)],
  );
  await page.goto(path);
}

/** Calls the API as the account. For setting a scene up quickly; the tests themselves click. */
export async function api<T = unknown>(
  account: Account,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${account.session.access_token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * Gives an account a platform role, the way the operator does: with the secret key. Local stack
 * only. A deployment's roles are the operator's to set, never a test's.
 */
export async function grantRole(account: Account, role: "operator" | "test"): Promise<void> {
  if (process.env.E2E_APP_URL) throw new Error("Roles are not granted against a deployment.");
  const vars = readFileSync(join(import.meta.dirname, "../../api/.dev.vars"), "utf8");
  const secretKey = /^SUPABASE_SECRET_KEY=(.*)$/m.exec(vars)?.[1] ?? "";
  const userId = (account.session.user as { id: string } | undefined)?.id;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/platform_roles`, {
    method: "POST",
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ user_id: userId, role }),
  });
  if (!response.ok) throw new Error(`Could not grant ${role}: status ${response.status}.`);
}

interface Scene {
  organization: { id: string; name: string };
  location: { id: string; name: string };
}

/**
 * An organization with one location, three prompts and one finished scan: what most screens
 * need before there is anything on them to check.
 */
export async function withScannedLocation(
  account: Account,
  organizationName = "Raleigh Pizza Group",
): Promise<Scene> {
  const organization = await api<Scene["organization"]>(account, "POST", "/organizations", {
    name: organizationName,
  });
  const location = await api<Scene["location"]>(
    account,
    "POST",
    `/organizations/${organization.id}/locations`,
    { name: "Joe's Pizza", city: "Raleigh", region: "NC", primary_category: "Pizza restaurant" },
  );
  for (const text of [
    "Who makes the best pizza in Raleigh?",
    "Where can I get late night pizza in Raleigh?",
    "Best family pizza restaurant near downtown Raleigh",
  ]) {
    await api(account, "POST", `/locations/${location.id}/queries`, { kind: "ai_prompt", text });
  }
  await api(account, "POST", `/locations/${location.id}/scans`);
  await scanFinished(account, location.id);
  return { organization, location };
}

/** Waits for a location's latest scan to end, and fails if it did not succeed. */
export async function scanFinished(account: Account, locationId: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const detail = await api<{ latest_scan: { status: string; error: string | null } | null }>(
      account,
      "GET",
      `/locations/${locationId}`,
    );
    const status = detail.latest_scan?.status;
    if (status === "succeeded") return;
    if (status === "failed") throw new Error(`The scan failed: ${detail.latest_scan?.error}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The scan did not finish in 30 seconds.");
}
