#!/usr/bin/env node
// Restores the optional confidential `private/` companion checkout for authorized maintainers.
//
// The private repository's locator deliberately never appears in public source. It is read at run
// time from the 1Password `Nearcited Workspace` item (secret reference below), so a fresh clone
// of the public repository can be completed with one command:
//
//   npm run bootstrap:private
//
// The locator may be `owner/name` (cloned with `gh repo clone`, reusing the GitHub CLI login) or a
// credential-free GitHub HTTPS/SSH URL (cloned with `git clone`). Nothing here prints the locator,
// a token, or any resolved secret; the public checkout keeps ignoring `/private/` either way.
//
// Options:
//   --url <locator>                          skip 1Password and use this locator
//   --op-reference <op://...>                read the locator from a different secret reference
//   --service-account-reference <op://...>   if the current identity cannot read the locator, read a
//                                            service-account token from this reference and retry
//                                            with it in a process-scoped OP_SERVICE_ACCOUNT_TOKEN
//                                            (also NEARCITED_OP_SERVICE_ACCOUNT_REFERENCE)
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_REFERENCE = "op://Nearcited/Nearcited Workspace/private_repository";

const OPTIONS = ["--url", "--op-reference", "--service-account-reference"];

export function parseArgs(argv, environment = process.env) {
  const options = {
    locator: null,
    reference: DEFAULT_REFERENCE,
    serviceAccountReference: environment.NEARCITED_OP_SERVICE_ACCOUNT_REFERENCE ?? null,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    if (!OPTIONS.includes(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value.`);
    if (argument === "--url") options.locator = value;
    else if (argument === "--op-reference") options.reference = value;
    else options.serviceAccountReference = value;
  }
  return options;
}

// A GitHub owner starts with a letter or digit, which also keeps `../x` and `-x/y` out.
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;
const SSH_URL = /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/u;

/** The command that clones `locator` into `destination`. Throws on anything but a GitHub locator. */
export function cloneCommandFor(locator, destination) {
  if (/\r|\n/u.test(locator)) {
    throw new Error("The private repository locator must be a single line.");
  }
  if (OWNER_NAME.test(locator)) return ["gh", ["repo", "clone", locator, destination]];
  if (/^https?:\/\//iu.test(locator)) {
    const parsed = new URL(locator);
    if (parsed.hostname.toLowerCase() !== "github.com" || parsed.username || parsed.password) {
      throw new Error(
        "An HTTPS locator must target github.com and contain no embedded credential.",
      );
    }
    return ["git", ["clone", locator, destination]];
  }
  if (SSH_URL.test(locator)) return ["git", ["clone", locator, destination]];
  throw new Error(
    "The private repository locator must be `owner/name` or a credential-free GitHub HTTPS/SSH URL.",
  );
}

/** "installed", "blocked" (a non-empty directory that is not a checkout), or "absent". */
export function privateState(privateRoot) {
  if (existsSync(join(privateRoot, ".git"))) return "installed";
  if (existsSync(privateRoot) && readdirSync(privateRoot).length > 0) return "blocked";
  return "absent";
}

function opRead(secretReference, env = process.env) {
  const result = spawnSync("op", ["read", secretReference], {
    encoding: "utf8",
    env,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function readLocator({ reference, serviceAccountReference }) {
  let locator = opRead(reference);
  if (!locator && serviceAccountReference) {
    let serviceToken = opRead(serviceAccountReference);
    if (serviceToken) {
      const scopedEnvironment = { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: serviceToken };
      locator = opRead(reference, scopedEnvironment);
      scopedEnvironment.OP_SERVICE_ACCOUNT_TOKEN = "";
      serviceToken = "";
    }
  }
  if (!locator) {
    throw new Error(
      "Could not read the private repository locator with the current 1Password identity" +
        " or the optional service-account reference. Sign in to 1Password (`op vault list`) and retry.",
    );
  }
  return locator;
}

export function main(argv = process.argv.slice(2)) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const privateRoot = join(repositoryRoot, "private");
  const options = parseArgs(argv);

  const state = privateState(privateRoot);
  if (state === "installed") {
    console.log("The private companion checkout is already installed at private/.");
    return 0;
  }
  if (state === "blocked") {
    throw new Error(
      "Refusing to overwrite the non-empty private/ directory because it is not a Git checkout.",
    );
  }

  const [command, args] = cloneCommandFor(options.locator ?? readLocator(options), privateRoot);
  // stdio is inherited so clone progress is visible; git/gh print the locator themselves only in
  // their normal "Cloning into" line, which names the destination path, not the remote.
  const clone = spawnSync(command, args, { stdio: "inherit", windowsHide: true });
  if (clone.status !== 0 || !existsSync(join(privateRoot, ".git"))) {
    throw new Error("The private companion clone did not complete successfully.");
  }
  console.log("Private companion checkout installed at private/.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`bootstrap-private: ${error.message}`);
    process.exitCode = 1;
  }
}
