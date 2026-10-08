import { defineConfig, devices } from "@playwright/test";

/**
 * The smoke test: one pass through a real deployment, signed in as its test account, to see
 * that what was just deployed works. Unlike the end-to-end tests it starts nothing and fakes
 * nothing; it needs to be told where the deployment is and who to sign in as.
 *
 *   E2E_APP_URL, E2E_SUPABASE_URL, E2E_SUPABASE_PUBLISHABLE_KEY   see support/stack.ts
 *   TEST_ACCOUNT_EMAIL, TEST_ACCOUNT_PASSWORD                    the deployment's test account
 */
export default defineConfig({
  testDir: "./smoke",
  // One account, one organization: the steps build on each other and must not overlap.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  // A deployment that works on the second try is still worth knowing about, but not worth
  // failing a deploy over a dropped connection.
  retries: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.E2E_APP_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }],
});
