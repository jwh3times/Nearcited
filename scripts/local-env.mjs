#!/usr/bin/env node
// Writes the two gitignored env files a local run needs, from their examples and the keys the
// local Supabase stack prints. Start the stack first (`supabase start`).
//
//   pnpm local:env            write whichever of the two is missing
//   pnpm local:env --force    write both, replacing what is there
//
// Mock mode and blank provider keys are left as the examples have them: this is for running the
// app against generated data, which is what development and the end-to-end tests do.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "../..");

/** The files to write: where each goes, and the example it starts from. */
export const TARGETS = [
  { path: "apps/api/.dev.vars", example: "apps/api/.dev.vars.example" },
  { path: "apps/web/.env.local", example: "apps/web/.env.example" },
];

/**
 * An example file with the stack's keys filled in. Every line that sets a URL or key the stack
 * provides is replaced; everything else, comments included, is kept as written.
 */
export function fillExample(example, status) {
  const values = {
    SUPABASE_URL: status.API_URL,
    SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: status.SECRET_KEY,
    VITE_SUPABASE_URL: status.API_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY,
  };
  return example
    .split("\n")
    .map((line) => {
      const name = line.slice(0, line.indexOf("="));
      return line.includes("=") && values[name] ? `${name}=${values[name]}` : line;
    })
    .join("\n");
}

/** The stack's status as an object, from what `supabase status -o json` prints. */
export function parseStatus(output) {
  const start = output.indexOf("{");
  if (start === -1) throw new Error("The Supabase stack is not running. Run `supabase start`.");
  const status = JSON.parse(output.slice(start));
  for (const key of ["API_URL", "PUBLISHABLE_KEY", "SECRET_KEY"]) {
    if (!status[key]) throw new Error(`\`supabase status\` did not report ${key}.`);
  }
  return status;
}

function supabaseStatus() {
  // The CLI is on PATH where it was installed for the machine or by CI; otherwise fetch it.
  for (const [command, args] of [
    ["supabase", ["status", "-o", "json"]],
    ["pnpm", ["dlx", "supabase", "status", "-o", "json"]],
  ]) {
    try {
      return execFileSync(command, args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {}
  }
  throw new Error("Could not run `supabase status`. Is the stack started?");
}

function main() {
  const force = process.argv.includes("--force");
  const status = parseStatus(supabaseStatus());
  for (const { path, example } of TARGETS) {
    if (existsSync(join(root, path)) && !force) {
      console.log(`= ${path} is already there`);
      continue;
    }
    const filled = fillExample(readFileSync(join(root, example), "utf8"), status);
    // Holds the stack's secret key, so it is readable by its owner only.
    writeFileSync(join(root, path), filled, { mode: 0o600 });
    console.log(`+ ${path}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
