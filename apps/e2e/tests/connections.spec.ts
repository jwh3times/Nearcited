import { expect, test } from "@playwright/test";
import { api, createAccount, signIn } from "../support/account";

test("connects a sample account, matches a location to it, and removes it leaving the record", async ({
  page,
}) => {
  const account = await createAccount();
  const organization = await api<{ id: string }>(account, "POST", "/organizations", {
    name: "Raleigh Pizza Group",
  });
  const location = await api<{ id: string }>(
    account,
    "POST",
    `/organizations/${organization.id}/locations`,
    { name: "Joe's Pizza", city: "Raleigh" },
  );
  await signIn(page, account);

  // The local stack runs on sample data, so there is a sample account to connect.
  await page.getByRole("link", { name: "Connections" }).click();
  await expect(page.getByRole("heading", { name: "Connections", level: 1 })).toBeVisible();
  await expect(page.getByText("Nothing is connected.")).toBeVisible();

  await page.getByRole("button", { name: "Connect a sample account" }).click();
  const connected = page.getByRole("article", { name: "Sample account" });
  await expect(connected).toContainText("Connected by");
  await expect(connected).toContainText(account.email);
  await expect(page.getByText("Nothing is connected.")).toBeHidden();

  // What the API sends holds no sign-in, sealed or not.
  const listed = await api<{ connections: Record<string, unknown>[] }>(
    account,
    "GET",
    `/organizations/${organization.id}/connections`,
  );
  expect(listed.connections).toHaveLength(1);
  expect(JSON.stringify(listed)).not.toMatch(/seal|sign_in|secret|sample-/i);

  // The worker reads what the account reaches, and then the location can be matched to one.
  const choice = connected.getByLabel("Sample account for Joe's Pizza");
  await expect(choice).toBeVisible({ timeout: 30_000 });
  await expect(choice).toHaveValue("");
  await choice.selectOption({ label: "Sample listing: Riverside" });
  await expect(choice).toHaveValue("sample-listing-2");

  // The location's own Settings say what it is matched to, and the way back.
  await page.goto(`/locations/${location.id}?tab=settings`);
  const matched = page.locator(".side-card", { hasText: "Connected accounts" });
  await expect(matched).toContainText("Sample account");
  await expect(matched).toContainText("Sample listing: Riverside");
  await matched.getByRole("link", { name: "Connections" }).click();
  await expect(page.getByRole("heading", { name: "Connections", level: 1 })).toBeVisible();
  await expect(connected.getByLabel("Sample account for Joe's Pizza")).toHaveValue(
    "sample-listing-2",
  );

  // Removing says what it does and asks again.
  await connected.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(connected.getByRole("alert")).toContainText("It cannot be undone");
  await connected.getByRole("button", { name: "Keep it" }).click();
  await expect(connected.getByRole("alert")).toBeHidden();
  await connected.getByRole("button", { name: "Remove", exact: true }).click();
  await connected.getByRole("button", { name: "Remove Sample account" }).click();

  // The worker finishes it without the page being reloaded, and the record stays.
  const removed = page.getByRole("region", { name: "Removed" });
  await expect(removed).toContainText(`removed by ${account.email}`, { timeout: 30_000 });
  await expect(removed).toContainText(`connected by ${account.email}`);
  await expect(page.getByText("Nothing is connected.")).toBeVisible();
});
