import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cloneCommandFor,
  DEFAULT_REFERENCE,
  parseArgs,
  privateState,
} from "./bootstrap-private.mjs";

function temporaryDirectory(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nearcited-bootstrap-private-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("defaults to the 1Password reference and no explicit locator", () => {
  assert.deepEqual(parseArgs([], {}), {
    locator: null,
    reference: DEFAULT_REFERENCE,
    serviceAccountReference: null,
  });
});

test("reads each option and the service-account environment variable", () => {
  const parsed = parseArgs(["--url", "owner/name", "--op-reference", "op://v/i/f"], {
    NEARCITED_OP_SERVICE_ACCOUNT_REFERENCE: "op://v/i/token",
  });
  assert.equal(parsed.locator, "owner/name");
  assert.equal(parsed.reference, "op://v/i/f");
  assert.equal(parsed.serviceAccountReference, "op://v/i/token");
});

test("rejects an unknown option and an option with no value", () => {
  assert.throws(() => parseArgs(["--force"], {}), /Unknown argument/);
  assert.throws(() => parseArgs(["--url"], {}), /requires a value/);
});

test("clones owner/name through the GitHub CLI and URLs through git", () => {
  assert.deepEqual(cloneCommandFor("owner/name", "dest"), [
    "gh",
    ["repo", "clone", "owner/name", "dest"],
  ]);
  for (const url of ["https://github.com/owner/name.git", "git@github.com:owner/name.git"]) {
    assert.deepEqual(cloneCommandFor(url, "dest"), ["git", ["clone", url, "dest"]]);
  }
});

test("refuses locators that carry a credential or leave GitHub", () => {
  for (const locator of [
    "https://token@github.com/owner/name.git",
    "https://user:pass@github.com/owner/name.git",
    "https://example.com/owner/name.git",
    "git@example.com:owner/name.git",
    "owner/name\n--upload-pack=x",
    "--upload-pack=x",
    "../somewhere",
  ]) {
    assert.throws(() => cloneCommandFor(locator, "dest"), Error, locator);
  }
});

test("reports whether private/ is absent, installed or blocked", (t) => {
  const root = temporaryDirectory(t);
  const privateRoot = path.join(root, "private");
  assert.equal(privateState(privateRoot), "absent");

  mkdirSync(privateRoot);
  assert.equal(privateState(privateRoot), "absent");

  writeFileSync(path.join(privateRoot, "notes.md"), "kept");
  assert.equal(privateState(privateRoot), "blocked");

  mkdirSync(path.join(privateRoot, ".git"));
  assert.equal(privateState(privateRoot), "installed");
});
