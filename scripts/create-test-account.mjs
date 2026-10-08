#!/usr/bin/env node
// Makes the deployment's test account: the sign-in automation uses to check that a deployment
// works (docs/adr/0003-platform-roles-and-test-accounts.md). Safe to run again: it finds the
// account if it is already there and makes sure it has the `test` role.
//
//   pnpm test-account:create
//
// Only the operator can do this. It reads, from the environment and never from a file here:
//
//   SUPABASE_SECRET_KEY      creates the account and grants the role
//   TEST_ACCOUNT_EMAIL       the address the account signs in as; nobody needs to read its mail
//   TEST_ACCOUNT_PASSWORD    kept with the other production secrets, and never printed
//
// SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY override the deployment's own, to make one in a local
// stack instead.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripJsonc } from "./create-audit.mjs";

/** Shorter than this and a password guards nothing. */
export const MIN_PASSWORD = 20;

/** Where the account goes and what makes it, from the environment and the Worker's own config. */
export function readSettings(env, root) {
  const file = join("apps", "api", "wrangler.jsonc");
  const vars = JSON.parse(stripJsonc(readFileSync(join(root, file), "utf8"))).vars ?? {};
  const settings = {
    supabaseUrl: env.SUPABASE_URL || vars.SUPABASE_URL,
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY || vars.SUPABASE_PUBLISHABLE_KEY,
    secretKey: env.SUPABASE_SECRET_KEY,
    email: env.TEST_ACCOUNT_EMAIL?.trim().toLowerCase(),
    password: env.TEST_ACCOUNT_PASSWORD,
  };
  const missing = [
    !settings.secretKey && "SUPABASE_SECRET_KEY",
    !settings.email && "TEST_ACCOUNT_EMAIL",
    !settings.password && "TEST_ACCOUNT_PASSWORD",
  ].filter(Boolean);
  if (missing.length > 0) throw new Error(`Set ${missing.join(", ")} in the environment.`);
  if (!settings.supabaseUrl || !settings.publishableKey) {
    throw new Error(`${file} does not say where Supabase is.`);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(settings.email)) {
    throw new Error("TEST_ACCOUNT_EMAIL is not an email address.");
  }
  if (settings.password.length < MIN_PASSWORD) {
    throw new Error(`TEST_ACCOUNT_PASSWORD must be at least ${MIN_PASSWORD} characters.`);
  }
  return settings;
}

async function call(ctx, key, path, init = {}) {
  const response = await ctx.fetch(`${ctx.settings.supabaseUrl}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: response.ok, status: response.status, body };
}

/**
 * Creates the account, or finds it, and grants it the `test` role. Returns its ID and whether it
 * was made just now.
 */
export async function createTestAccount(ctx) {
  const { email, password, secretKey, publishableKey } = ctx.settings;

  // Confirmed from the start: nothing is sent to the address, which nobody reads.
  const made = await call(ctx, secretKey, "/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  let userId = made.ok ? made.body?.id : null;

  if (!made.ok) {
    // Most likely it is already there. Signing in proves that, and that the password kept with
    // the secrets is the one the account has.
    const signedIn = await call(ctx, publishableKey, "/auth/v1/token?grant_type=password", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    userId = signedIn.ok ? signedIn.body?.user?.id : null;
    if (!userId) {
      const reason = made.body?.msg ?? made.body?.message ?? `status ${made.status}`;
      throw new Error(
        `Could not create ${email} (${reason}), and could not sign in as it with this password. ` +
          "If it exists with another password, set that one here or change it in the dashboard.",
      );
    }
  }
  if (!userId) throw new Error("Supabase created the account but did not say what its ID is.");

  const granted = await call(ctx, secretKey, "/rest/v1/platform_roles?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: userId, role: "test" }),
  });
  if (!granted.ok) {
    throw new Error(
      `The account exists but the test role was not granted (status ${granted.status}). ` +
        "Has the platform_roles migration been applied?",
    );
  }
  return { userId, created: made.ok };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const settings = readSettings(process.env, root);
    const { created } = await createTestAccount({ fetch, settings });
    console.log(
      `${created ? "Created" : "Found"} ${settings.email} at ${new URL(settings.supabaseUrl).host}. It has the test role: every organization it creates is a test organization.`,
    );
  } catch (error) {
    console.error(`test account: ${error.message}`);
    process.exitCode = 1;
  }
}
