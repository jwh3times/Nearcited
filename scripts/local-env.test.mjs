import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fillExample, parseStatus, TARGETS } from "./local-env.mjs";

const root = join(fileURLToPath(import.meta.url), "../..");

const status = {
  API_URL: "http://127.0.0.1:54321",
  PUBLISHABLE_KEY: "sb_publishable_local",
  SECRET_KEY: "sb_secret_local",
};

describe("fillExample", () => {
  it("fills in what the stack provides and keeps everything else as written", () => {
    const example = [
      "# Copy to .dev.vars",
      "SUPABASE_URL=http://127.0.0.1:54321",
      "SUPABASE_PUBLISHABLE_KEY=sb_publishable_from_supabase_status",
      "SUPABASE_SECRET_KEY=sb_secret_from_supabase_status",
      "PROVIDER_MODE=mock",
      "# Optional.",
      "OPENAI_API_KEY=",
      "",
    ].join("\n");
    assert.equal(
      fillExample(example, status),
      [
        "# Copy to .dev.vars",
        "SUPABASE_URL=http://127.0.0.1:54321",
        "SUPABASE_PUBLISHABLE_KEY=sb_publishable_local",
        "SUPABASE_SECRET_KEY=sb_secret_local",
        "PROVIDER_MODE=mock",
        "# Optional.",
        "OPENAI_API_KEY=",
        "",
      ].join("\n"),
    );
  });

  it("fills in the key connections are sealed with when one was made, and not otherwise", () => {
    assert.equal(
      fillExample("CONNECTIONS_KEY=\nPROVIDER_MODE=mock", status, { CONNECTIONS_KEY: "made=" }),
      "CONNECTIONS_KEY=made=\nPROVIDER_MODE=mock",
    );
    assert.equal(fillExample("CONNECTIONS_KEY=", status), "CONNECTIONS_KEY=");
  });

  it("fills the web app's names from the same keys", () => {
    assert.equal(
      fillExample("VITE_SUPABASE_URL=x\nVITE_SUPABASE_PUBLISHABLE_KEY=y", status),
      "VITE_SUPABASE_URL=http://127.0.0.1:54321\nVITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_local",
    );
  });
});

describe("TARGETS", () => {
  it("writes each file from an example whose database lines it fills in", () => {
    for (const { example } of TARGETS) {
      const filled = fillExample(readFileSync(join(root, example), "utf8"), status);
      assert.match(filled, /=http:\/\/127\.0\.0\.1:54321$/m, example);
      assert.match(filled, /=sb_publishable_local$/m, example);
    }
  });
});

describe("parseStatus", () => {
  it("reads the status past whatever the CLI prints before it", () => {
    const output = `Progress: resolved 1\n${JSON.stringify(status)}\n`;
    assert.deepEqual(parseStatus(output), status);
  });

  it("says so when the stack is not running, or reports no key", () => {
    assert.throws(() => parseStatus("failed to inspect container health"), /not running/);
    assert.throws(() => parseStatus(JSON.stringify({ API_URL: "x" })), /PUBLISHABLE_KEY/);
  });
});
