import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests: a real browser against the real app, the real Worker and a local Supabase
 * stack. Nothing is mocked but the providers, which serve generated data in mock mode.
 *
 * Before running: `supabase start`, then `pnpm local:env` to write the two env files. The config
 * below starts the Worker and the web app itself, or reuses them if `pnpm dev` is already up.
 */
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests",
  // Each test makes its own account, so they do not share state and can run side by side.
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [["github"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, grepInvert: /@phone/ },
    // The same tests on a phone-sized touch screen, where the sidebar is a menu and tables stack.
    { name: "phone", use: { ...devices["Pixel 7"] }, grep: /@phone/ },
  ],
  webServer: [
    {
      command: "pnpm --filter @nearcited/api dev",
      // Answers 401 without a session, which is enough to know it is up.
      url: "http://127.0.0.1:8787/api/me",
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @nearcited/web dev",
      url: "http://localhost:5173",
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
  ],
});
