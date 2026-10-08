import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fillExample, parseStatus } from "./local-env.mjs";

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

  it("fills the web app's names from the same keys", () => {
    assert.equal(
      fillExample("VITE_SUPABASE_URL=x\nVITE_SUPABASE_PUBLISHABLE_KEY=y", status),
      "VITE_SUPABASE_URL=http://127.0.0.1:54321\nVITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_local",
    );
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
