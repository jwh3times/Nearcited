import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the local stack lives, read from the web app's own env file so the two cannot drift. */
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

const env = webEnv();

export const SUPABASE_URL = env.VITE_SUPABASE_URL ?? "";
export const PUBLISHABLE_KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
/** The local stack's mail catcher, which receives every email Auth sends. */
export const MAILBOX_URL = "http://127.0.0.1:54324";
export const API_URL = "http://127.0.0.1:8787/api";

/** The key supabase-js keeps the session under: `sb-<first label of the host>-auth-token`. */
export const SESSION_KEY = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
