import { expect, test } from "@playwright/test";
import { type Account, api, signIn, signInWithPassword } from "../support/account";

const email = process.env.TEST_ACCOUNT_EMAIL ?? "";
const password = process.env.TEST_ACCOUNT_PASSWORD ?? "";

interface Organization {
  id: string;
  is_test: boolean;
}

let account: Account;
let organization: Organization;

test.beforeAll(async () => {
  if (!email || !password) throw new Error("Set TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD.");
  account = await signInWithPassword(email, password);

  const me = await api<{ organizations: Organization[] }>(account, "GET", "/me");
  organization =
    me.organizations[0] ??
    (await api<Organization>(account, "POST", "/organizations", { name: "Smoke test" }));

  // The whole point of a test organization is that its scans ask nobody and cost nothing. If
  // this account's organization is not one, stop before anything is scanned.
  if (!organization.is_test) {
    throw new Error(
      `${email} is not a test account: its organization is a real one. Refusing to go on.`,
    );
  }

  // Whatever an earlier run left behind.
  const locations = await api<{ id: string }[]>(
    account,
    "GET",
    `/organizations/${organization.id}/locations`,
  );
  for (const location of locations) await api(account, "DELETE", `/locations/${location.id}`);
});

test("the deployment serves its public pages", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "Privacy policy", level: 1 })).toBeVisible();
});

test("a signed-in account can add a location, scan it, read the results and remove it", async ({
  page,
}) => {
  await signIn(page, account);
  await expect(page.getByRole("heading", { name: "Locations", level: 1 })).toBeVisible();
  // A test organization's data is generated, and the page must say so.
  await expect(page.getByText("generated sample data, not real measurements")).toBeVisible();

  await page.getByRole("button", { name: "Add location" }).click();
  await page.getByLabel("Business name").fill("Smoke Test Pizza");
  await page.getByLabel("City").fill("Raleigh");
  await page.getByLabel("State or region").fill("NC");
  await page.locator("form.inline-card").getByRole("button", { name: "Add location" }).click();

  // A new location opens on its prompts.
  await expect(page.getByRole("heading", { name: "Smoke Test Pizza", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/tab=prompts/);
  await page
    .getByPlaceholder(/What would a customer ask/)
    .fill("Who makes the best pizza in Raleigh?");
  await page.getByRole("button", { name: "Add prompt" }).click();
  await expect(page.getByText("“Who makes the best pizza in Raleigh?”")).toBeVisible();

  // The scan goes through the queue and the Worker, and the page fills in when it ends.
  await page.getByRole("button", { name: "Run scan" }).click();
  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByText("/ 100")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator(".score-card")).toContainText(/Named in \d+ of \d+ answers/);

  // What was scanned was generated, never a real assistant's answer.
  const detail = await api<{ latest_scan: { status: string; sample_data: boolean } }>(
    account,
    "GET",
    new URL(page.url()).pathname,
  );
  expect(detail.latest_scan).toMatchObject({ status: "succeeded", sample_data: true });

  await page.getByRole("tab", { name: "Answers" }).click();
  await expect(page.getByRole("figure").first()).toBeVisible();

  // Leave nothing behind.
  await page.getByRole("tab", { name: "Settings" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete location" }).click();
  await expect(page.getByText("No locations yet")).toBeVisible();
});
