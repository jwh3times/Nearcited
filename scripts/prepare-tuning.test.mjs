import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BUNDLED_TUNING, PRIVATE_TUNING, prepareTuning } from "./prepare-tuning.mjs";

function repository(t, privateTuning) {
  const root = mkdtempSync(path.join(os.tmpdir(), "nearcited-prepare-tuning-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (privateTuning !== undefined) {
    mkdirSync(path.join(root, "private"));
    writeFileSync(path.join(root, PRIVATE_TUNING), privateTuning);
  }
  return root;
}

const bundled = (root) => JSON.parse(readFileSync(path.join(root, BUNDLED_TUNING), "utf8"));

test("writes the default marker when there is no private checkout", (t) => {
  const root = repository(t);
  assert.equal(prepareTuning(root), "default");
  assert.deepEqual(bundled(root), { source: "default" });
});

test("bundles the private file when it is present", (t) => {
  const root = repository(t, JSON.stringify({ score: { unranked: 0.4 } }));
  assert.equal(prepareTuning(root), "private");
  assert.deepEqual(bundled(root), { source: "private", tuning: { score: { unranked: 0.4 } } });
});

test("refuses a private file that is not a JSON object", (t) => {
  assert.throws(() => prepareTuning(repository(t, "{ not json")), /not valid JSON/);
  assert.throws(() => prepareTuning(repository(t, "[]")), /JSON object/);
  assert.throws(() => prepareTuning(repository(t, "null")), /JSON object/);
});

test("leaves an unchanged bundle file alone", (t) => {
  const root = repository(t);
  prepareTuning(root);
  const target = path.join(root, BUNDLED_TUNING);
  const before = statSync(target).mtimeMs;
  prepareTuning(root);
  assert.equal(statSync(target).mtimeMs, before);
});

test("returns to the defaults when the private file goes away", (t) => {
  const root = repository(t, "{}");
  assert.equal(prepareTuning(root), "private");
  rmSync(path.join(root, "private"), { recursive: true });
  assert.equal(prepareTuning(root), "default");
  assert.deepEqual(bundled(root), { source: "default" });
});
