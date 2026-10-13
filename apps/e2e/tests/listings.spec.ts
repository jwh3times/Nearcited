import { expect, test } from "@playwright/test";
import {
  type Account,
  createAccount,
  signIn,
  withScannedLocation,
  withUnnamedSource,
} from "../support/account";

const PAGE = "https://www.bbb.org/us/nc/raleigh/profile/pizza/joes-pizza-0593-1234";
const OTHER = "https://www.bbb.org/us/nc/raleigh/profile/pizza/joes-pizza-0593-5678";

let account: Account;
let locationPath: string;

test.beforeEach(async () => {
  account = await createAccount();
  const { location } = await withScannedLocation(account);
  locationPath = `/locations/${location.id}`;
  // A review site that lets a business ask its customers, and one that forbids it.
  await withUnnamedSource(location.id, "bbb.org");
  await withUnnamedSource(location.id, "yelp.com");
});

test("keeps the business's listing on a review site, to copy and send to customers", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, account, locationPath);
  const task = page
    .getByRole("listitem")
    .filter({ hasText: "Ask your customers for reviews on bbb.org" });
  const field = task.getByLabel("Your listing on bbb.org");
  const save = task.getByRole("button", { name: "Save the listing" });
  await expect(save).toBeDisabled();

  // An address on another site is refused where it is typed, and nothing is kept.
  await field.fill("https://www.yelp.com/biz/joes-pizza-raleigh");
  await save.click();
  await expect(task.getByRole("alert")).toHaveText(
    "That address is not on bbb.org. Paste the address of your own page there.",
  );
  await expect(field).toBeVisible();

  // Pasted the way an address bar gives it, without its start.
  await field.fill(PAGE.replace("https://", ""));
  await save.click();
  await expect(task.getByRole("link", { name: PAGE })).toHaveAttribute("href", PAGE);
  await expect(field).toHaveCount(0);

  await task.getByRole("button", { name: "Copy the link" }).click();
  await expect(task.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PAGE);

  // It is kept with the location, not with the page that was open.
  await page.reload();
  await expect(task.getByRole("link", { name: PAGE })).toBeVisible();
});

test("lets a listing be changed for another, and taken away", async ({ page }) => {
  await signIn(page, account, locationPath);
  const task = page
    .getByRole("listitem")
    .filter({ hasText: "Ask your customers for reviews on bbb.org" });
  const field = task.getByLabel("Your listing on bbb.org");
  await field.fill(PAGE);
  await task.getByRole("button", { name: "Save the listing" }).click();
  await expect(task.getByRole("link", { name: PAGE })).toBeVisible();

  // Changing starts from the one that is kept, and backing out leaves it.
  await task.getByRole("button", { name: "Change" }).click();
  await expect(field).toHaveValue(PAGE);
  await task.getByRole("button", { name: "Cancel" }).click();
  await expect(task.getByRole("link", { name: PAGE })).toBeVisible();

  await task.getByRole("button", { name: "Change" }).click();
  await field.fill(OTHER);
  await task.getByRole("button", { name: "Save the listing" }).click();
  await expect(task.getByRole("link", { name: OTHER })).toBeVisible();
  await expect(task.getByRole("link", { name: PAGE })).toHaveCount(0);

  await task.getByRole("button", { name: "Remove" }).click();
  await expect(field).toHaveValue("");
  await expect(task.getByRole("link", { name: OTHER })).toHaveCount(0);
  await page.reload();
  await expect(field).toBeVisible();
});

test("asks for no listing on a site that does not let a business ask for reviews", async ({
  page,
}) => {
  await signIn(page, account, locationPath);
  const asking = page
    .getByRole("listitem")
    .filter({ hasText: "Ask your customers for reviews on bbb.org" });
  const claiming = page
    .getByRole("listitem")
    .filter({ hasText: "Claim and complete your listing on yelp.com" });
  await expect(asking.getByLabel(/^Your listing on/)).toBeVisible();
  await expect(claiming).toBeVisible();
  await expect(claiming.getByLabel(/^Your listing on/)).toHaveCount(0);
});
