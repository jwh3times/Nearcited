import { expect, type Page, test } from "@playwright/test";
import {
  type Account,
  api,
  createAccount,
  grantRole,
  signIn,
  withScannedLocation,
  withUnnamedSource,
} from "../support/account";

/** The link Google gives a business to ask for reviews with. */
const FROM_GOOGLE = "https://g.page/r/CZx1AbCdEfGhEAE/review";
const PAGE = "https://www.bbb.org/us/nc/raleigh/profile/pizza/joes-pizza-0593-1234";
/** Where a customer writes a review on bbb.org, which is made from the listing. */
const FORM = `${PAGE}/leave-a-review`;

const ABOUT = "A request to send your customers";
const request = (site: string, link: string) =>
  `Thank you for choosing Joe's Pizza. Would you leave a review on ${site}? Say what you honestly thought, good or bad: it helps other people decide.\n${link}`;

let account: Account;
let organizationId: string;
let locationId: string;

test.beforeEach(async () => {
  account = await createAccount();
  const { organization, location } = await withScannedLocation(account);
  organizationId = organization.id;
  locationId = location.id;
  // Two review sites that let a business ask, one that forbids it, and one nobody knows.
  await withUnnamedSource(location.id, "google.com");
  await withUnnamedSource(location.id, "bbb.org");
  await withUnnamedSource(location.id, "yelp.com");
  await withUnnamedSource(location.id, "somewhere.example");
});

const taskFor = (page: Page, title: string) =>
  page.getByRole("listitem").filter({ hasText: title });
const keep = (site: string, url: string) =>
  api(account, "PUT", `/locations/${locationId}/listings/${site}`, { url });

test("hands over a request to send once the link is kept, and copies it whole", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, account, `/locations/${locationId}`);
  const task = taskFor(page, "Ask your customers for reviews on google.com");

  // With no link to send there is nothing to ask with.
  await expect(task.getByLabel("Your review link from Google")).toBeVisible();
  await expect(task.getByText(ABOUT)).toHaveCount(0);

  await task.getByLabel("Your review link from Google").fill(FROM_GOOGLE);
  await task.getByRole("button", { name: "Save the link" }).click();

  // The request names the business and the site as a customer knows them, and ends on the link.
  await expect(task.getByText(ABOUT)).toBeVisible();
  await expect(
    task.getByText("Thank you for choosing Joe's Pizza. Would you leave a review on Google?"),
  ).toBeVisible();
  await expect(
    task.getByText(
      "Send it yourself, to every customer and not only the happy ones, and offer nothing in return.",
    ),
  ).toBeVisible();

  await task.getByRole("button", { name: "Copy the request" }).click();
  await expect(task.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    request("Google", FROM_GOOGLE),
  );

  // Copying sends nothing and marks nothing: the task is still the owner's to do.
  await expect(task.getByRole("button", { name: "Mark done" })).toBeVisible();
  await page.reload();
  await expect(task.getByText(ABOUT)).toBeVisible();
  await expect(task.getByRole("button", { name: "Mark done" })).toBeVisible();
});

test("asks on the site the task is for, with its review form where that is known", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await keep("bbb.org", PAGE);
  await signIn(page, account, `/locations/${locationId}`);
  const task = taskFor(page, "Ask your customers for reviews on bbb.org");

  await expect(task.getByText("Would you leave a review on BBB?")).toBeVisible();
  await task.getByRole("button", { name: "Copy the request" }).click();
  await expect(task.getByRole("button", { name: "Copied" })).toBeVisible();
  // The form, which is where a customer writes, and not the listing it was made from.
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(request("BBB", FORM));

  // Taking the listing away takes the request with it.
  await task.getByRole("button", { name: "Remove" }).click();
  await expect(task.getByLabel("Your listing on bbb.org")).toBeVisible();
  await expect(task.getByText(ABOUT)).toHaveCount(0);
});

test("offers no request for a site that forbids asking, or one whose kind is not known", async ({
  page,
}) => {
  await keep("google.com", FROM_GOOGLE);
  await signIn(page, account, `/locations/${locationId}`);
  // The one task that has a request, so the others are known to have been drawn.
  await expect(
    taskFor(page, "Ask your customers for reviews on google.com").getByText(ABOUT),
  ).toBeVisible();

  const forbidden = taskFor(page, "Claim and complete your listing on yelp.com");
  const unknown = taskFor(page, "See whether you can be listed on somewhere.example");
  for (const task of [forbidden, unknown]) {
    await expect(task).toBeVisible();
    await expect(task.getByText(ABOUT)).toHaveCount(0);
    await expect(task.getByRole("button", { name: "Copy the request" })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Copy the request" })).toHaveCount(1);
});

test("shows the operator the request a customer has, with nothing to change", async ({ page }) => {
  await keep("google.com", FROM_GOOGLE);
  const operator = await createAccount();
  await api(operator, "POST", "/organizations", { name: "The operator's own" });
  await grantRole(operator, "operator");
  await signIn(page, operator, `/operator/o/${organizationId}/locations/${locationId}`);

  const task = taskFor(page, "Ask your customers for reviews on google.com");
  await expect(task.getByText(ABOUT)).toBeVisible();
  await expect(task.getByText("Would you leave a review on Google?")).toBeVisible();
  await expect(task.getByRole("button", { name: "Copy the request" })).toBeVisible();
  await expect(task.getByRole("button", { name: "Change" })).toHaveCount(0);
  await expect(task.getByRole("button", { name: "Mark done" })).toHaveCount(0);
});
