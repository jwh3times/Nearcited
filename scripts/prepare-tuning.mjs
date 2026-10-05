#!/usr/bin/env node
// Writes the tuning file the Worker bundles, apps/api/.tuning/tuning.json.
//
// Wrangler runs this before every dev session, deploy and dry run (see "build" in
// apps/api/wrangler.jsonc). When the private companion is checked out and holds tuning.json, the
// bundle gets those values; otherwise it gets a marker telling the Worker to use the public
// defaults. Either way the output is gitignored and nothing private reaches this repository.
//
// This script only checks that the private file is a JSON object. The schema lives in
// packages/shared/src/tuning.ts and is applied twice: by private-tuning.test.ts in packages/db, which
// `pnpm check` and the deploy workflow run, and by the Worker when it starts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PRIVATE_TUNING = join("private", "tuning.json");
export const BUNDLED_TUNING = join("apps", "api", ".tuning", "tuning.json");

/** The content to bundle, as a string. Throws when the private file exists but is not usable. */
export function bundledTuning(root) {
  const source = join(root, PRIVATE_TUNING);
  if (!existsSync(source)) return `${JSON.stringify({ source: "default" })}\n`;

  let tuning;
  try {
    tuning = JSON.parse(readFileSync(source, "utf8"));
  } catch (error) {
    throw new Error(`${PRIVATE_TUNING} is not valid JSON: ${error.message}`);
  }
  if (tuning === null || typeof tuning !== "object" || Array.isArray(tuning)) {
    throw new Error(`${PRIVATE_TUNING} must hold a JSON object.`);
  }
  return `${JSON.stringify({ source: "private", tuning })}\n`;
}

/** Writes the bundle file, leaving it untouched when nothing changed. Returns the source used. */
export function prepareTuning(root) {
  const content = bundledTuning(root);
  const target = join(root, BUNDLED_TUNING);
  // An unchanged file keeps `wrangler dev` from rebuilding in a loop.
  if (!existsSync(target) || readFileSync(target, "utf8") !== content) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return JSON.parse(content).source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const source = prepareTuning(root);
    console.log(
      source === "private"
        ? "Tuning: private values from private/tuning.json."
        : "Tuning: public defaults (no private/tuning.json). Live scans will refuse to run.",
    );
  } catch (error) {
    console.error(`prepare-tuning: ${error.message}`);
    process.exitCode = 1;
  }
}
