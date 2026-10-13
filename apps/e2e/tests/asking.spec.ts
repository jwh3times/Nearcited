import { readFile } from "node:fs/promises";
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
import { readCode } from "../support/code";

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

/** The code as it is on the screen, by what a screen reader is told it is. */
const codeOn = (within: ReturnType<Page["locator"]>, link: string) =>
  within.getByRole("img", { name: `QR code that opens ${link}` });

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
    await expect(task.getByRole("img", { name: /^QR code/ })).toHaveCount(0);
    await expect(task.getByRole("link", { name: "Print a card" })).toHaveCount(0);
    await expect(task.getByRole("button", { name: "Download the code" })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Copy the request" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Print a card" })).toHaveCount(1);

  // Nor is there a card behind the address of one, for a site with no link to print.
  for (const site of ["yelp.com", "somewhere.example", "bbb.org"]) {
    await page.goto(`/locations/${locationId}/review-card/${site}`);
    await expect(page.getByRole("heading", { name: "A card to print" })).toBeVisible();
    await expect(page.getByText("There is no card to print for this site.")).toBeVisible();
    await expect(page.getByRole("region", { name: "The card as it prints" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Print the card" })).toHaveCount(0);
  }
});

test("draws the link as a code a camera reads, on the task and in the picture to save", async ({
  page,
  context,
}) => {
  await keep("bbb.org", PAGE);
  await signIn(page, account, `/locations/${locationId}`);
  const task = taskFor(page, "Ask your customers for reviews on bbb.org");

  // What is on the screen opens the review form, which is the link the task shows.
  const code = codeOn(task, FORM);
  await expect(code).toBeVisible();
  expect(await readCode(context, await code.screenshot())).toBe(FORM);

  // The picture is saved under the business's name and the site's, and holds the same link.
  const saving = page.waitForEvent("download");
  await task.getByRole("button", { name: "Download the code" }).click();
  const saved = await saving;
  expect(saved.suggestedFilename()).toBe("joes-pizza-bbb-review-code.png");
  const picture = await readFile(await saved.path());
  // A PNG, large enough to print from.
  expect(picture.subarray(1, 4).toString()).toBe("PNG");
  expect(picture.readUInt32BE(16)).toBeGreaterThanOrEqual(1024);
  expect(await readCode(context, picture)).toBe(FORM);

  // Saving it marks nothing done.
  await expect(task.getByRole("button", { name: "Mark done" })).toBeVisible();
});

test("draws a code that still reads for the longest address a listing may have", async ({
  page,
  context,
}) => {
  // 500 characters, which is the most a listing's address may run to.
  const start = "https://www.angi.com/companylist/us/nc/raleigh/joes-pizza-reviews-1234.htm?from=";
  const longest = start + "a1b2c3d4e5".repeat(50).slice(0, 500 - start.length);
  expect(longest).toHaveLength(500);
  await withUnnamedSource(locationId, "angi.com");
  await keep("angi.com", longest);
  await signIn(page, account, `/locations/${locationId}/review-card/angi.com`);

  // In the picture to save, and on the card at the size it prints.
  const saving = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download the code" }).click();
  expect(await readCode(context, await readFile(await (await saving).path()))).toBe(longest);
  const card = page.getByRole("region", { name: "The card as it prints" });
  await page.emulateMedia({ media: "print" });
  expect(await readCode(context, await codeOn(card, longest).screenshot())).toBe(longest);
});

test("opens a card to print, which is the card alone on paper", async ({ page, context }) => {
  await keep("google.com", FROM_GOOGLE);
  await signIn(page, account, `/locations/${locationId}`);
  const task = taskFor(page, "Ask your customers for reviews on google.com");
  await task.getByRole("link", { name: "Print a card" }).click();
  await expect(page).toHaveURL(new RegExp(`/locations/${locationId}/review-card/google\\.com$`));

  // The card: the business, one line that names the site, the code, and how to use it.
  const card = page.getByRole("region", { name: "The card as it prints" });
  await expect(card.getByRole("heading", { name: "Joe's Pizza" })).toBeVisible();
  await expect(card.getByText("How did we do? Leave a review on Google.")).toBeVisible();
  await expect(card.getByText("Point your phone's camera at the code.")).toBeVisible();
  // Shown at the size it prints: four inches wide.
  expect((await card.boundingBox())?.width).toBe(4 * 96);
  // It promises nothing for a review, and the owner is told to offer nothing.
  await expect(card).not.toContainText(/discount|free|gift|reward|prize/i);
  await expect(page.getByText("Offer nothing in return for a review.")).toBeVisible();

  // The button asks the browser to print.
  await page.evaluate(() => {
    window.print = () => {
      document.body.dataset.printed = "yes";
    };
  });
  await page.getByRole("button", { name: "Print the card" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-printed", "yes");

  // On paper there is the card and nothing else, still four inches wide, and its code reads.
  const banner = page.getByText("Scans are returning generated sample data");
  await expect(banner).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(card).toBeVisible();
  await expect(page.getByRole("button", { name: "Print the card" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "A card to print" })).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Locations" })).toBeHidden();
  await expect(banner).toBeHidden();
  expect((await card.boundingBox())?.width).toBe(4 * 96);
  expect(await readCode(context, await codeOn(card, FROM_GOOGLE).screenshot())).toBe(FROM_GOOGLE);
  await page.emulateMedia({ media: "screen" });

  // The picture can be saved from here too, and the way back is to the location.
  const saving = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download the code" }).click();
  expect((await saving).suggestedFilename()).toBe("joes-pizza-google-review-code.png");
  await page.getByRole("link", { name: "Joe's Pizza", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/locations/${locationId}$`));
});

test("shows the operator what a customer has to ask with, and nothing to change", async ({
  page,
}) => {
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

  // The code and its card too, and the card stays inside the account being read.
  await expect(codeOn(task, FROM_GOOGLE)).toBeVisible();
  await task.getByRole("link", { name: "Print a card" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/operator/o/${organizationId}/locations/${locationId}/review-card/google\\.com$`),
  );
  const card = page.getByRole("region", { name: "The card as it prints" });
  await expect(card.getByRole("heading", { name: "Joe's Pizza" })).toBeVisible();
  await page.getByRole("link", { name: "Joe's Pizza", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/operator/o/${organizationId}/locations/${locationId}$`),
  );
});
