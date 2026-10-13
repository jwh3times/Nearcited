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
/** Where a customer writes a review of each: bbb.org is a site whose form address is known. */
const FORM = `${PAGE}/leave-a-review`;
const OTHER_FORM = `${OTHER}/leave-a-review`;
/** A site that lets a business ask and whose form address is not known. */
const ELSEWHERE = "https://www.angi.com/companylist/us/nc/raleigh/joes-pizza-reviews-1234.htm";
/** The link Google gives a business to ask for reviews with. It is not on google.com. */
const FROM_GOOGLE = "https://g.page/r/CZx1AbCdEfGhEAE/review";

let account: Account;
let locationPath: string;

test.beforeEach(async () => {
  account = await createAccount();
  const { location } = await withScannedLocation(account);
  locationPath = `/locations/${location.id}`;
  // Three review sites that let a business ask its customers, and one that forbids it.
  await withUnnamedSource(location.id, "bbb.org");
  await withUnnamedSource(location.id, "angi.com");
  await withUnnamedSource(location.id, "google.com");
  await withUnnamedSource(location.id, "yelp.com");
});

const taskFor = (page: import("@playwright/test").Page, title: string) =>
  page.getByRole("listitem").filter({ hasText: title });

test("takes the business's listing on a review site and gives the link to its review form", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, account, locationPath);
  const task = taskFor(page, "Ask your customers for reviews on bbb.org");
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
  await expect(task.getByText("Where your customers write a review on bbb.org.")).toBeVisible();
  await expect(task.getByRole("link", { name: FORM })).toHaveAttribute("href", FORM);
  // The listing it was made from stays in view.
  await expect(task.getByRole("link", { name: PAGE, exact: true })).toHaveAttribute("href", PAGE);
  await expect(field).toHaveCount(0);

  // What is copied is what a customer is sent: the form, not the listing.
  await task.getByRole("button", { name: "Copy the link" }).click();
  await expect(task.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(FORM);

  // It is kept with the location, not with the page that was open.
  await page.reload();
  await expect(task.getByRole("link", { name: FORM })).toBeVisible();
});

test("gives the listing itself where the site's review form has no known address", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, account, locationPath);
  const task = taskFor(page, "Ask your customers for reviews on angi.com");
  await task.getByLabel("Your listing on angi.com").fill(ELSEWHERE);
  await task.getByRole("button", { name: "Save the listing" }).click();

  await expect(task.getByText("Your listing on angi.com. Send customers this link")).toBeVisible();
  await expect(task.getByRole("link", { name: ELSEWHERE })).toHaveAttribute("href", ELSEWHERE);
  await expect(task.getByText("Made from your listing")).toHaveCount(0);
  await task.getByRole("button", { name: "Copy the link" }).click();
  await expect(task.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ELSEWHERE);
});

test("asks for the review link Google gives, and says where an owner finds it", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, account, locationPath);
  const task = taskFor(page, "Ask your customers for reviews on google.com");
  const field = task.getByLabel("Your review link from Google");

  // The steps are Google's own, for an owner who does not know the link exists.
  await expect(task.getByText("Google gives every business a link")).toBeVisible();
  await expect(task.getByRole("listitem").filter({ hasText: "business.google.com" })).toBeVisible();
  await expect(
    task.getByRole("listitem").filter({ hasText: "choose Read Reviews, then Get more reviews" }),
  ).toBeVisible();
  await expect(task.getByRole("link", { name: "Google's own steps" })).toHaveAttribute(
    "href",
    "https://support.google.com/business/answer/16816815",
  );

  // What the top of the browser holds while a profile is managed is not the link.
  await field.fill("https://www.google.com/search?q=Joe%27s+Pizza+Raleigh");
  await task.getByRole("button", { name: "Save the link" }).click();
  await expect(task.getByRole("alert")).toContainText(
    "That does not look like the review link Google gives you.",
  );

  await field.fill(FROM_GOOGLE);
  await task.getByRole("button", { name: "Save the link" }).click();
  await expect(
    task.getByText("Your review link from Google. Send customers this link."),
  ).toBeVisible();
  await expect(task.getByRole("link", { name: FROM_GOOGLE })).toHaveAttribute("href", FROM_GOOGLE);
  await expect(task.getByText("Made from your listing")).toHaveCount(0);
  await task.getByRole("button", { name: "Copy the link" }).click();
  await expect(task.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(FROM_GOOGLE);

  await page.reload();
  await expect(task.getByRole("link", { name: FROM_GOOGLE })).toBeVisible();
});

test("lets a listing be changed for another, and taken away", async ({ page }) => {
  await signIn(page, account, locationPath);
  const task = taskFor(page, "Ask your customers for reviews on bbb.org");
  const field = task.getByLabel("Your listing on bbb.org");
  await field.fill(PAGE);
  await task.getByRole("button", { name: "Save the listing" }).click();
  await expect(task.getByRole("link", { name: FORM })).toBeVisible();

  // Changing starts from the one that is kept, and backing out leaves it.
  await task.getByRole("button", { name: "Change" }).click();
  await expect(field).toHaveValue(PAGE);
  await task.getByRole("button", { name: "Cancel" }).click();
  await expect(task.getByRole("link", { name: FORM })).toBeVisible();

  await task.getByRole("button", { name: "Change" }).click();
  await field.fill(OTHER);
  await task.getByRole("button", { name: "Save the listing" }).click();
  await expect(task.getByRole("link", { name: OTHER_FORM })).toBeVisible();
  await expect(task.getByRole("link", { name: FORM })).toHaveCount(0);

  await task.getByRole("button", { name: "Remove" }).click();
  await expect(field).toHaveValue("");
  await expect(task.getByRole("link", { name: OTHER_FORM })).toHaveCount(0);
  await page.reload();
  await expect(field).toBeVisible();
});

test("asks for no listing on a site that does not let a business ask for reviews", async ({
  page,
}) => {
  await signIn(page, account, locationPath);
  const asking = taskFor(page, "Ask your customers for reviews on bbb.org");
  const claiming = taskFor(page, "Claim and complete your listing on yelp.com");
  await expect(asking.getByLabel(/^Your listing on/)).toBeVisible();
  await expect(claiming).toBeVisible();
  await expect(claiming.getByLabel(/^Your listing on/)).toHaveCount(0);
});
