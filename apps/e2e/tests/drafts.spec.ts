import { expect, test } from "@playwright/test";
import {
  type Account,
  createAccount,
  signIn,
  withDrafts,
  withScannedLocation,
  withUnnamedSource,
} from "../support/account";

const SAID = "Wood-fired pizza and fresh pasta, family-run since 1998.";
/**
 * How long a draft may take to land. The queue holds a lone message for up to ten seconds before
 * the worker is given it, as it does a scan's.
 */
const LANDS = { timeout: 30_000 };

let account: Account;
let organizationId: string;
let locationPath: string;

test.beforeEach(async () => {
  account = await createAccount();
  const { organization, location } = await withScannedLocation(account);
  organizationId = organization.id;
  locationPath = `/locations/${location.id}`;
  // A page somebody wrote: the task is to ask its author, and a note is wording to write.
  await withUnnamedSource(location.id, "usnews.com");
});

test("writes a draft for a task once the business has said what it does, and keeps it", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await withDrafts(organizationId, 1);
  await signIn(page, account, locationPath);
  const task = page.getByRole("listitem").filter({ hasText: "Ask to be included on usnews.com" });
  await expect(task.getByText("1 of 1 left this month")).toBeVisible();

  // Nothing is written until the business has said what it does, so that is asked for first.
  await task.getByRole("button", { name: "Write a draft" }).click();
  const said = task.getByLabel("What we do");
  await expect(said).toBeFocused();
  await expect(task.getByRole("button", { name: "Save and write a draft" })).toBeDisabled();
  await said.fill(SAID);
  await task.getByRole("button", { name: "Save and write a draft" }).click();

  // The worker writes it on its own time, and the page shows it when it lands.
  const draft = task.locator(".draft-text");
  await expect(task.getByRole("status").filter({ hasText: "Writing a draft" })).toBeVisible();
  await expect(draft).toContainText(`I run Joe's Pizza in Raleigh, NC. ${SAID}`, LANDS);
  // Sample data: generated text, said to be nobody's writing.
  await expect(task.getByText(/^Sample text\. No model wrote this/)).toBeVisible();
  await expect(task.getByText(/Written by a model/)).toHaveCount(0);

  await task.getByRole("button", { name: "Copy the draft" }).click();
  await expect(task.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await draft.innerText());

  // The month's one draft is used: what was written stays, and the button gives way to the day.
  await expect(task.getByText(/^This month's drafts are used\. More on /)).toBeVisible();
  await expect(task.getByRole("link", { name: "See plans" })).toBeVisible();
  await expect(task.getByRole("button", { name: /Write/ })).toHaveCount(0);

  // It is kept with the task, and what the business said is kept with the location.
  const written = await draft.innerText();
  await page.reload();
  await expect(draft).toHaveText(written);
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByLabel("What we do")).toHaveValue(SAID);
});

test("writes a draft again in place of the first, and counts one more", async ({ page }) => {
  // Two drafts, each after the queue's wait.
  test.setTimeout(90_000);
  await withDrafts(organizationId, 2);
  await signIn(page, account, `${locationPath}?tab=settings`);
  await page.getByLabel("What we do").fill(SAID);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await page.getByRole("tab", { name: "Overview" }).click();
  const task = page.getByRole("listitem").filter({ hasText: "Ask to be included on usnews.com" });
  // The business has said what it does, so the draft is written straight away.
  await task.getByRole("button", { name: "Write a draft" }).click();
  await expect(task.locator(".draft-text")).toContainText(SAID, LANDS);
  await expect(task.getByText("1 of 2 left this month")).toBeVisible();

  await task.getByRole("button", { name: "Write it again" }).click();
  // The first stays to be read while the second is on its way.
  await expect(task.getByRole("status").filter({ hasText: "Writing a draft" })).toBeVisible();
  await expect(task.locator(".draft-text")).toContainText(SAID);
  await expect(task.getByText(/^This month's drafts are used/)).toBeVisible(LANDS);
  await expect(task.locator(".draft-text")).toHaveCount(1);
});

test("offers no draft on a plan that includes none, and none for a task with no wording", async ({
  page,
}) => {
  await withUnnamedSource(locationPath.replace("/locations/", ""), "yelp.com");
  await signIn(page, account, locationPath);
  const note = page.getByRole("listitem").filter({ hasText: "Ask to be included on usnews.com" });
  await expect(note).toBeVisible();
  // No plan here includes drafts, so nobody is offered one or pointed at a price list for one.
  await expect(page.getByRole("button", { name: "Write a draft" })).toHaveCount(0);
  await expect(page.getByText(/does not include drafts/)).toHaveCount(0);

  await withDrafts(organizationId, 1);
  await page.reload();
  await expect(note.getByRole("button", { name: "Write a draft" })).toBeVisible();
  // Claiming a listing is not wording to write.
  const listing = page
    .getByRole("listitem")
    .filter({ hasText: "Claim and complete your listing on yelp.com" });
  await expect(listing).toBeVisible();
  await expect(listing.getByRole("button", { name: "Write a draft" })).toHaveCount(0);
});
