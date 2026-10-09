import { expect, test } from "@playwright/test";
import { createAccount, signIn } from "../support/account";

test("takes a new account from nothing to its first scan's results", async ({ page }) => {
  await signIn(page, await createAccount());

  // Step 1 will not go on without a name.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toHaveText("Name is required");
  await page.getByLabel("Organization name").fill("Raleigh Pizza Group");
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2 stops at what is wrong with the location, then accepts it.
  await page.getByLabel("Business name").fill("Joe's Pizza");
  await page.getByLabel("Website").fill("not a site");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Enter a web address, like joespizza.com")).toBeVisible();
  await expect(page.getByText("City is required")).toBeVisible();
  await page.getByLabel("What it is").fill("Pizza restaurant");
  await page.getByLabel("City").fill("Raleigh");
  await page.getByLabel("State or region").fill("NC");
  await page.getByLabel("Website").fill("joespizza.example");
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3 suggests prompts written from the business, with as many chosen as the free plan
  // tracks. Another can be ticked only once one is unticked.
  await expect(page.getByRole("heading", { name: "What would a customer ask?" })).toBeVisible();
  await expect(page.getByLabel("Who is the best pizza restaurant in Raleigh?")).toBeChecked();
  await expect(page.getByText("the free plan, which tracks 2 prompts")).toBeVisible();
  await expect(page.getByText("2 of 2 chosen")).toBeVisible();
  await expect(page.getByRole("checkbox").nth(2)).toBeDisabled();

  // The owner's own words go in the same list. One that says nothing is refused beside the field.
  const own = page.getByLabel("Or write your own");
  await own.fill("??");
  await page.getByRole("button", { name: "Add to the list" }).click();
  await expect(page.getByText("Use at least three letters")).toBeVisible();
  await own.fill("Where should I take my kids for pizza in Raleigh?");
  await own.press("Enter");
  // Still on this step: Enter added the prompt and did not move on. With both places taken it
  // waits unticked until one is given up.
  const mine = page.getByLabel("Where should I take my kids for pizza in Raleigh?");
  await expect(mine).not.toBeChecked();
  await expect(page.getByText("To choose a different one, untick one first.")).toBeVisible();
  await page.getByRole("checkbox").nth(1).uncheck();
  await mine.check();
  await expect(page.getByText("2 of 2 chosen")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 4 sums it up, and running the scan lands on the location while it is under way.
  await expect(page.getByText("Joe's Pizza, Raleigh, NC")).toBeVisible();
  await page.getByRole("button", { name: "Run first scan" }).click();
  await expect(page).toHaveURL(/\/locations\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Joe's Pizza", level: 1 })).toBeVisible();

  // The page fills in by itself when the scan finishes.
  await expect(page.getByRole("heading", { name: "What to do next" })).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByText("/ 100")).toBeVisible();
  await expect(page.getByRole("tab", { name: /Prompts/ })).toContainText("2");
  // These are generated results, and the page must say so.
  await expect(page.getByText("generated sample data, not real measurements")).toBeVisible();
  // The website was stored with the scheme the owner did not type.
  await expect(page.getByRole("link", { name: "joespizza.example" })).toHaveAttribute(
    "href",
    "https://joespizza.example",
  );
});
