import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the app under test lives. The end-to-end tests run against a local stack and read it
 * from the web app's own env file, so the two cannot drift. The smoke test runs against a real
 * deployment and is told through the environment:
 *
 *   E2E_APP_URL                    the deployed site, e.g. https://nearcited.com
 *   E2E_SUPABASE_URL               its Supabase project
 *   E2E_SUPABASE_PUBLISHABLE_KEY   the project's public key
 */
function webEnv(): Record<string, string> {
  const path = join(import.meta.dirname, "../../web/.env.local");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${path} is missing. Start Supabase, then run \`pnpm local:env\`.`);
  }
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

const deployed = process.env.E2E_APP_URL?.replace(/\/$/, "");
const local = deployed ? {} : webEnv();

export const APP_URL = deployed ?? "http://localhost:5173";
export const API_URL = deployed ? `${deployed}/api` : "http://127.0.0.1:8787/api";
export const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? local.VITE_SUPABASE_URL ?? "";
export const PUBLISHABLE_KEY =
  process.env.E2E_SUPABASE_PUBLISHABLE_KEY ?? local.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
if (!SUPABASE_URL || !PUBLISHABLE_KEY) {
  throw new Error("Set E2E_SUPABASE_URL and E2E_SUPABASE_PUBLISHABLE_KEY for a deployed run.");
}

/** The local stack's mail catcher, which receives every email Auth sends. */
export const MAILBOX_URL = "http://127.0.0.1:54324";

/** The key supabase-js keeps the session under: `sb-<first label of the host>-auth-token`. */
export const SESSION_KEY = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
