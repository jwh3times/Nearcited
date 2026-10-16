import { defineConfig } from "vitest/config";

// Each test file loads every migration into its own in-process Postgres before it starts. That
// takes longer as migrations are added, and longer still on a shared CI runner, so the setup is
// given a minute rather than the default ten seconds.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
  },
});
