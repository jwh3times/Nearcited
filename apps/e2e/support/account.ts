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
  const userId = (account.session.user as { id: string } | undefined)?.id;
  await asWorker("platform_roles", { user_id: userId, role });
}

/** Records what a scan used at a provider, as the worker does after a live scan. Local stack only. */
export async function recordUsage(
  organizationId: string,
  usage: { model: string; calls: number },
): Promise<void> {
  await asWorker("provider_usage", {
    organization_id: organizationId,
    surface: "chatgpt",
    input_tokens: 1000,
    cached_input_tokens: 0,
    output_tokens: 100,
    searches: 1,
    ...usage,
  });
}

/**
 * Puts an organization on a paid plan, as the worker does when a subscription starts. A new
 * account is on the free plan, which is too small for most screens to have anything on them.
 */
export async function onPlan(organizationId: string, plan: string): Promise<void> {
  await asWorker("rpc/apply_plan", { org: organizationId, plan });
}

/**
 * Gives a location a source its answers read without naming it, as a scan's rule would. The
 * sample data has none, and a task stands on one. Local stack only.
 */
export async function withUnnamedSource(locationId: string, host: string): Promise<void> {
  await asWorker("recommendations", {
    location_id: locationId,
    rule: `source:${host}`,
    title: `Check your listing on ${host}`,
    detail: "Detail",
  });
}

/**
 * Gives a location a page task for its first prompt, as a scan's rule would once no answer to the
 * prompt had named the business. Returns the prompt. Local stack only.
 */
export async function withPageTask(account: Account, locationId: string): Promise<string> {
  const detail = await api<{ queries: { id: string; text: string }[] }>(
    account,
    "GET",
    `/locations/${locationId}`,
  );
  const [query] = detail.queries;
  if (!query) throw new Error("The location has no prompt to write a page for.");
  await asWorker("recommendations", {
    location_id: locationId,
    rule: `page:${query.id}`,
    title: "Publish a page",
    detail: "Detail",
  });
  return query.text;
}

/**
 * Gives an organization `each` drafts a month for the one location it is made to cover, as a
 * plan that includes drafts would. Local stack only.
 */
export async function withDrafts(organizationId: string, each: number): Promise<void> {
  await asWorker(
    `organizations?id=eq.${organizationId}`,
    { allowances: { drafts: each }, max_locations: 1 },
    "PATCH",
  );
}

/**
 * Gives a location a drop on one of its prompts, as a scan's rule would once the prompt had been
 * named and then missed three times running. One scan cannot show one. Returns the prompt.
 * Local stack only.
 */
export async function withDrop(account: Account, locationId: string): Promise<string> {
  const detail = await api<{ queries: { id: string; text: string }[] }>(
    account,
    "GET",
    `/locations/${locationId}`,
  );
  const [query] = detail.queries;
  if (!query) throw new Error("The location has no prompt to drop out of.");
  await asWorker("alerts", {
    location_id: locationId,
    kind: "drop",
    subject: `${query.id}|chatgpt`,
    tracked_query_id: query.id,
    surface: "chatgpt",
    facts: { prompt: query.text, missed: 3, checks_before: 4, named_before: 4 },
    since: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    // The local stack serves sample data, and a location's page shows the alerts of that kind.
    sample_data: true,
  });
  return query.text;
}

/**
 * Gives a location a business its answers named for the first time, as a scan's rule would once
 * the location had a record to be new against. Local stack only.
 */
export async function withNewBusiness(locationId: string, name: string): Promise<void> {
  await asWorker("alerts", {
    location_id: locationId,
    kind: "competitor",
    subject: name.toLowerCase(),
    facts: {
      name,
      answers: 4,
      scans: 2,
      of_scans: 3,
      places: [{ prompt: "Who makes the best pizza in Raleigh?", surfaces: ["chatgpt", "claude"] }],
      prompts: 1,
    },
    since: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    sample_data: true,
  });
}

/**
 * Gives a location a phone number its answers gave that is not the one on file, as a scan's
 * rule would once two scans' answers had given it. Local stack only.
 */
export async function withOtherNumber(locationId: string): Promise<void> {
  await asWorker("alerts", {
    location_id: locationId,
    kind: "phone",
    subject: "+19195550199",
    facts: {
      number: "+19195550199",
      on_file: "+19195550100",
      country_code: "US",
      answers: 2,
      scans: 2,
      of_scans: 7,
      places: [{ prompt: "Who makes the best pizza in Raleigh?", surfaces: ["chatgpt"] }],
      prompts: 1,
    },
    since: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    sample_data: true,
  });
}

/**
 * Gives a location a website, and a check of it that found everything in order but structured
 * business details, as a scan would on a live deployment. The local stack serves sample data,
 * which reads no site. Local stack only.
 */
export async function withUncheckedDetails(account: Account, locationId: string): Promise<void> {
  await api(account, "PATCH", `/locations/${locationId}`, {
    name: "Joe's Pizza",
    city: "Raleigh",
    region: "NC",
    website: "joespizza.example",
  });
  const detail = await api<{ latest_scan: { id: string } }>(
    account,
    "GET",
    `/locations/${locationId}`,
  );
  const passed = (id: string) => ({ id, passed: id !== "structured_data" });
  await asWorker(
    `scans?id=eq.${detail.latest_scan.id}`,
    {
      site_check: {
        url: "https://joespizza.example/",
        status: 200,
        checks: [
          "reachable",
          "crawlers_allowed",
          "indexable",
          "text_content",
          "names_business",
          "names_city",
          "structured_data",
        ].map(passed),
        blocked_crawlers: [],
        words: 240,
      },
    },
    "PATCH",
  );
  // The finding the scan would have kept, which is what marking the fix done stands on.
  await asWorker("recommendations", {
    location_id: locationId,
    rule: "site:structured_data",
    title: "Your home page has no structured business details",
    detail: "Detail",
  });
}

/** Writes a row with the secret key. Never against a deployment: its data is not a test's. */
async function asWorker(table: string, row: unknown, method = "POST"): Promise<void> {
  if (process.env.E2E_APP_URL) throw new Error("Tests do not write to a deployment's database.");
  const vars = readFileSync(join(import.meta.dirname, "../../api/.dev.vars"), "utf8");
  const secretKey = /^SUPABASE_SECRET_KEY=(.*)$/m.exec(vars)?.[1] ?? "";
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method,
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(row),
  });
  if (!response.ok) throw new Error(`Could not write to ${table}: status ${response.status}.`);
}

/** Reads rows as the worker does, with the secret key. Local stack only. */
async function readAsWorker<T>(query: string): Promise<T[]> {
  if (process.env.E2E_APP_URL) throw new Error("Tests do not read a deployment's database.");
  const vars = readFileSync(join(import.meta.dirname, "../../api/.dev.vars"), "utf8");
  const secretKey = /^SUPABASE_SECRET_KEY=(.*)$/m.exec(vars)?.[1] ?? "";
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}` },
  });
  if (!response.ok) throw new Error(`Could not read ${query}: status ${response.status}.`);
  return (await response.json()) as T[];
}

/**
 * Gives a location counts as its site would have reported them over some days. A day's ceiling
 * and the pages past a day's fiftieth take a thousand visits to reach. Local stack only.
 */
export async function withCounted(
  locationId: string,
  counted: { ago: number; assistant: string; path: string; count: number }[],
): Promise<void> {
  await asWorker(
    "visits",
    counted.map(({ ago, ...row }) => ({
      location_id: locationId,
      day: new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10),
      ...row,
    })),
  );
}

/** A location's line: the key its site carries, and the day it last answered a check. */
export async function lineOf(
  locationId: string,
): Promise<{ key: string; checked_on: string | null }> {
  const [line] = await readAsWorker<{ key: string; checked_on: string | null }>(
    `visit_lines?location_id=eq.${locationId}&select=key,checked_on`,
  );
  if (!line) throw new Error("The location has no line.");
  return line;
}

/** The visits counted for a location, as the database holds them. Local stack only. */
export async function visitsOf(
  locationId: string,
): Promise<{ assistant: string; path: string; count: number }[]> {
  return readAsWorker(
    `visits?location_id=eq.${locationId}&select=assistant,path,count&order=assistant,path`,
  );
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
  await onPlan(organization.id, "standard");
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
