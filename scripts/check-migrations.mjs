#!/usr/bin/env node
// Fails when a branch changes a migration its base already has. Every merge applies the new
// migrations to the hosted project, each once and in order, so an edit, rename or deletion of one
// already merged never reaches it, and the databases drift apart ("Migrations are append-only" in
// AGENTS.md). Adding a migration passes. CI runs it on every pull request.
//
//   node scripts/check-migrations.mjs                 against the merge base with origin/main
//   node scripts/check-migrations.mjs --base <ref>    against the merge base with <ref>

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const MIGRATIONS = "supabase/migrations";

const WHAT = { D: "deleted", M: "edited", T: "changed type" };

/**
 * The migrations a diff changes other than by adding them, from `git diff --name-status
 * --no-renames`. Without rename detection a rename is a deletion and an addition, so the
 * deletion is what fails it.
 */
export function changedMigrations(nameStatus) {
  return nameStatus
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [status, path] = line.split("\t");
      if (!path?.startsWith(`${MIGRATIONS}/`) || status === "A") return [];
      return [{ path, what: WHAT[status] ?? `changed (${status})` }];
    });
}

export function parseArgs(argv) {
  const options = { base: "origin/main" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--base" || !argv[index + 1]) {
      throw new Error(`Usage: node scripts/check-migrations.mjs [--base <ref>]`);
    }
    options.base = argv[index + 1];
    index += 1;
  }
  return options;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const { base } = parseArgs(argv);
  const nameStatus = execFileSync(
    "git",
    ["diff", "--name-status", "--no-renames", `${base}...HEAD`, "--", MIGRATIONS],
    { cwd, encoding: "utf8" },
  );
  const changed = changedMigrations(nameStatus);
  if (changed.length === 0) {
    console.log(`No migration on ${base} is changed.`);
    return 0;
  }
  for (const { path, what } of changed) console.error(`${path}: ${what}`);
  console.error(
    "A migration already merged has been applied to the hosted project and is never applied again. " +
      "Leave it as it is and add a new migration instead.",
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
