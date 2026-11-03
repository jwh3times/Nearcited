import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { changedMigrations, main, parseArgs } from "./check-migrations.mjs";

describe("changedMigrations", () => {
  it("passes additions and names every other change to a migration", () => {
    const nameStatus = [
      "A\tsupabase/migrations/20261103000000_new.sql",
      "M\tsupabase/migrations/20261004000000_init.sql",
      "D\tsupabase/migrations/20261007000000_scan_window.sql",
      "T\tsupabase/migrations/20261007010000_retire_tracked_queries.sql",
      "M\tsupabase/config.toml",
      "",
    ].join("\n");
    assert.deepEqual(changedMigrations(nameStatus), [
      { path: "supabase/migrations/20261004000000_init.sql", what: "edited" },
      { path: "supabase/migrations/20261007000000_scan_window.sql", what: "deleted" },
      {
        path: "supabase/migrations/20261007010000_retire_tracked_queries.sql",
        what: "changed type",
      },
    ]);
  });

  it("finds nothing in an empty diff", () => {
    assert.deepEqual(changedMigrations(""), []);
  });
});

describe("parseArgs", () => {
  it("defaults to origin/main and takes --base", () => {
    assert.equal(parseArgs([]).base, "origin/main");
    assert.equal(parseArgs(["--base", "abc123"]).base, "abc123");
    assert.throws(() => parseArgs(["--base"]));
    assert.throws(() => parseArgs(["--other"]));
  });
});

describe("main", () => {
  function git(root, ...args) {
    return execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  }

  function repository() {
    const root = mkdtempSync(path.join(tmpdir(), "check-migrations-"));
    git(root, "init", "-q", "-b", "main");
    mkdirSync(path.join(root, "supabase/migrations"), { recursive: true });
    writeFileSync(path.join(root, "supabase/migrations/1_init.sql"), "create table a ();\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    git(root, "switch", "-q", "-c", "branch");
    return root;
  }

  function run(root) {
    const { error } = console;
    const { log } = console;
    console.error = () => {};
    console.log = () => {};
    try {
      return main(["--base", "main"], root);
    } finally {
      console.error = error;
      console.log = log;
    }
  }

  function commitAll(root) {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "change");
  }

  it("passes a branch that adds a migration", (t) => {
    const root = repository();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(path.join(root, "supabase/migrations/2_more.sql"), "create table b ();\n");
    commitAll(root);
    assert.equal(run(root), 0);
  });

  it("fails a branch that edits a merged migration", (t) => {
    const root = repository();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(path.join(root, "supabase/migrations/1_init.sql"), "create table a (id int);\n");
    commitAll(root);
    assert.equal(run(root), 1);
  });

  it("fails a branch that renames a merged migration", (t) => {
    const root = repository();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    renameSync(
      path.join(root, "supabase/migrations/1_init.sql"),
      path.join(root, "supabase/migrations/0_init.sql"),
    );
    commitAll(root);
    assert.equal(run(root), 1);
  });

  it("fails a branch that deletes a merged migration", (t) => {
    const root = repository();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    rmSync(path.join(root, "supabase/migrations/1_init.sql"));
    commitAll(root);
    assert.equal(run(root), 1);
  });
});
