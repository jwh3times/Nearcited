import { expect, test } from "@playwright/test";
import { api, createAccount, signIn } from "../support/account";

test("renames the organization from Account settings, everywhere at once", async ({ page }) => {
  const account = await createAccount();
  await api(account, "POST", "/organizations", { name: "Raleigh Pizza Group" });
  await signIn(page, account);

  await page.getByRole("link", { name: "Account settings" }).click();
  await expect(page.getByRole("heading", { name: "Account settings" })).toBeVisible();
  // Nothing to save until the name is different.
  await expect(page.getByRole("button", { name: "Save name" })).toBeDisabled();

  const name = page.getByLabel("Organization name");
  await name.fill("   ");
  await name.blur();
  await expect(page.getByText("Name is required")).toBeVisible();

  await name.fill("Triangle Pizza Group");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.locator(".org-card")).toContainText("Triangle Pizza Group");

  await page.reload();
  await expect(page.locator(".org-card")).toContainText("Triangle Pizza Group");
  // What the plan allows is shown, and not offered for editing.
  await expect(page.getByText("Prompts and keywords")).toBeVisible();
  await expect(page.getByText("are not built yet")).toBeVisible();
});
