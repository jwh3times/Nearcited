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
  await expect(page.getByText("0 of 0 this month")).toBeVisible();
  // The owner is shown the way to the plans. Nothing can be bought where no provider is set up.
  await expect(page.getByText("Subscriptions are not available here yet.")).toBeVisible();
  await page.getByRole("link", { name: "See plans and prices" }).click();
  await expect(page.getByRole("heading", { name: "Pricing", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Free plan" })).toContainText("Your plan");
  await expect(page.getByRole("region", { name: "Starter plan" })).toContainText(
    "Subscriptions are not available here yet.",
  );
});

test("lets the owner of a free organization choose which assistant it is checked on", async ({
  page,
}) => {
  const account = await createAccount();
  await api(account, "POST", "/organizations", { name: "Free Pizza Group" });
  await signIn(page, account, "/settings");

  await expect(page.getByRole("heading", { name: "Your plan: Free" })).toBeVisible();
  const chooser = page.getByRole("group", { name: "Assistant to check" });
  await expect(chooser.getByRole("button", { name: "ChatGPT" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await chooser.getByRole("button", { name: "Claude" }).click();
  await expect(chooser.getByRole("button", { name: "Claude" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // It is what the account now says, not only what the button shows.
  const me = await api<{ organizations: { surfaces: string[] }[] }>(account, "GET", "/me");
  expect(me.organizations[0]?.surfaces).toEqual(["claude"]);
});
