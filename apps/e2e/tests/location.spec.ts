import { expect, test } from "@playwright/test";
import { type Account, createAccount, signIn, withScannedLocation } from "../support/account";

let account: Account;
let locationPath: string;

test.beforeEach(async () => {
  account = await createAccount();
  const { location } = await withScannedLocation(account);
  locationPath = `/locations/${location.id}`;
});

test("lists the location with its score and how often each assistant named it", async ({
  page,
}) => {
  await signIn(page, account);
  const row = page.getByRole("link", { name: /Joe's Pizza/ }).filter({ hasText: "Raleigh, NC" });
  await expect(row.first()).toBeVisible();
  // A rate for an assistant, as a percentage.
  await expect(page.locator(".rate-cell").first()).toHaveText(/^\d+%$/);
  await expect(page.getByText("1 of 1 location")).toBeVisible();
});

test("moves between the tabs by click, by arrow key and by address", async ({ page }) => {
  await signIn(page, account, locationPath);
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByRole("heading", { name: "What to do next" })).toBeVisible();

  await page.getByRole("tab", { name: "Sources" }).click();
  await expect(page).toHaveURL(/tab=sources/);
  await expect(panel.getByRole("heading", { name: "Where the answers come from" })).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Website/ })).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("heading", { name: "Your website" })).toBeVisible();

  await page.goto(`${locationPath}?tab=answers`);
  await expect(panel.getByRole("heading", { name: "What the answers said" })).toBeVisible();
  // The business's name is marked wherever an answer says it.
  await expect(panel.locator("mark").first()).toHaveText("Joe's Pizza");
});

test("adds a prompt, refuses one that says nothing, and retires and restores one", async ({
  page,
}) => {
  await signIn(page, account, `${locationPath}?tab=prompts`);
  const field = page.getByPlaceholder(/What would a customer ask/);

  await field.fill("??");
  await page.getByRole("button", { name: "Add prompt" }).click();
  await expect(page.getByText("Use at least three letters")).toBeVisible();

  await field.fill("Who delivers pizza in Raleigh?");
  await page.getByRole("button", { name: "Add prompt" }).click();
  await expect(page.getByText("“Who delivers pizza in Raleigh?”")).toBeVisible();
  await expect(page.getByText("4 of 10 used")).toBeVisible();

  await page.getByRole("button", { name: 'Retire "Who delivers pizza in Raleigh?"' }).click();
  await expect(page.getByText("“Who delivers pizza in Raleigh?”")).toBeHidden();

  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("button", { name: 'Restore "Who delivers pizza in Raleigh?"' }).click();
  await page.getByRole("tab", { name: /Prompts/ }).click();
  await expect(page.getByText("“Who delivers pizza in Raleigh?”")).toBeVisible();
});

test("checks a location's details beside each field, and saves them tidied", async ({ page }) => {
  await signIn(page, account, `${locationPath}?tab=settings`);
  const phone = page.getByLabel("Phone");

  await phone.fill("555-0100");
  await page.getByLabel("Postal code").fill("2760");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Enter a full phone number, with the area code")).toBeVisible();
  await expect(page.getByText("Enter a 5-digit ZIP code")).toBeVisible();
  await expect(page.getByText("Saved.")).toBeHidden();

  // A whole number is set out the way it is written once the field is left.
  await phone.fill("9195550100");
  await phone.blur();
  await expect(phone).toHaveValue("(919) 555-0100");
  await page.getByLabel("Postal code").fill("27601");
  await page.getByLabel("Website").fill("joespizza.example");
  await page.getByRole("button", { name: "Weekly" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await page.reload();
  await expect(phone).toHaveValue("(919) 555-0100");
  await expect(page.getByLabel("Website")).toHaveValue("https://joespizza.example");
  await expect(page.getByRole("button", { name: "Weekly" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("ticks a step of the plan off, and remembers it in this browser", async ({ page }) => {
  await signIn(page, account, locationPath);
  await expect(page.getByText(/^0 of \d+ done$/)).toBeVisible();
  await page
    .getByRole("button", { name: /^Mark ".*" as done$/ })
    .first()
    .click();
  await expect(page.getByText(/^1 of \d+ done$/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/^1 of \d+ done$/)).toBeVisible();
});

test("opens the menu on a phone, and stacks the tables @phone", async ({ page }) => {
  await signIn(page, account);
  // The sidebar is folded away behind a button.
  await expect(page.getByRole("link", { name: "Account settings" })).toBeHidden();
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("link", { name: "Account settings" })).toBeVisible();
  await page.getByRole("navigation", { name: "Locations" }).getByText("Joe's Pizza").click();

  // Going somewhere closes it again, and nothing scrolls sideways.
  await expect(page.getByRole("heading", { name: "Joe's Pizza", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Account settings" })).toBeHidden();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
