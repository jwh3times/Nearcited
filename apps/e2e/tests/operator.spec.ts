import { expect, test } from "@playwright/test";
import { api, createAccount, grantRole, signIn, withScannedLocation } from "../support/account";

test("shows the operator every organization, and lets them read a customer's account without changing it", async ({
  page,
}) => {
  const customerName = `Customer ${Date.now()}`;
  const customer = await createAccount();
  const { location } = await withScannedLocation(customer, customerName);

  const operator = await createAccount();
  await api(operator, "POST", "/organizations", { name: "The operator's own" });
  await grantRole(operator, "operator");
  await signIn(page, operator);

  // The link is in the sidebar, and the page lists the customer among everyone.
  await page.getByRole("link", { name: "Operator", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Operator", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();
  await expect(page.getByText("Deployed commit")).toBeVisible();
  // The customer is among the accounts, with how far they have got; the funnel counts them.
  await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
  const account = page.locator("div.gtable-row", { hasText: customer.email });
  await expect(account).toContainText(customerName);
  await expect(account).toContainText("Scanned in the last 7 days");
  await expect(page.getByRole("heading", { name: "Audits" })).toBeVisible();
  // The customer also appears under "Needs attention", so the row is found in the table.
  // A row of the organizations table is a link; an account's row, which also names it, is not.
  const row = page.locator("a.gtable-row", { hasText: customerName });
  await expect(row).toContainText("1 of");
  await expect(row).toContainText("Succeeded");

  // Reading through: the customer's sidebar and pages, under a bar that says whose they are.
  await row.click();
  await expect(page.getByRole("status").filter({ hasText: "as the operator" })).toContainText(
    customerName,
  );
  await expect(page.locator(".org-card")).toContainText(customerName);
  await expect(page.getByRole("button", { name: "Add location" })).toBeHidden();
  await page
    .getByRole("link", { name: /Joe's Pizza/ })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/operator/o/[0-9a-f-]+/locations/${location.id}`));
  await expect(page.getByRole("heading", { name: "Joe's Pizza", level: 1 })).toBeVisible();
  await expect(page.getByText("/ 100")).toBeVisible();

  // Nothing that changes anything is offered.
  await expect(page.getByRole("button", { name: "Run scan" })).toBeHidden();
  await page.getByRole("tab", { name: /Prompts/ }).click();
  await expect(page.getByText("“Who makes the best pizza in Raleigh?”")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Retire/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add prompt" })).toBeHidden();
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByLabel("Business name")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Delete location" })).toBeHidden();

  // And back out to the operator's own account.
  await page.getByRole("link", { name: "Back to the operator view" }).click();
  await expect(page.getByRole("heading", { name: "Operator", level: 1 })).toBeVisible();
  await expect(page.locator(".org-card")).toContainText("The operator's own");
});

test("has no operator page for anyone else", async ({ page }) => {
  const account = await createAccount();
  await api(account, "POST", "/organizations", { name: "Raleigh Pizza Group" });
  await signIn(page, account, "/operator");
  // The address leads nowhere and the sidebar offers no way in.
  await expect(page.getByRole("heading", { name: "Locations", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Operator", exact: true })).toHaveCount(0);
});
