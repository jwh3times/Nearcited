import { expect, test } from "@playwright/test";
import {
  type Account,
  api,
  createAccount,
  signIn,
  withDrafts,
  withPageTask,
  withScannedLocation,
} from "../support/account";

const SAID = "Wood-fired pizza and fresh pasta, family-run since 1998.";
/** How long a draft may take to land: the worker writes it from the queue, on its own time. */
const LANDS = { timeout: 30_000 };

let account: Account;
let organizationId: string;
let locationId: string;
let prompt: string;

test.beforeEach(async () => {
  account = await createAccount();
  const { organization, location } = await withScannedLocation(account);
  organizationId = organization.id;
  locationId = location.id;
  // A page goes on the business's own site, so the location has one.
  await api(account, "PATCH", `/locations/${location.id}`, {
    name: "Joe's Pizza",
    city: "Raleigh",
    region: "NC",
    primary_category: "Pizza restaurant",
    website: "https://joespizza.example",
    phone: "+1 919 555 0100",
    what_we_do: SAID,
  });
  prompt = await withPageTask(account, location.id);
});

test("writes the copy for a page that answers a prompt, and counts the answers once it is up", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await withDrafts(organizationId, 1);
  await signIn(page, account, `/locations/${locationId}?tab=website`);

  await expect(page.getByRole("heading", { name: "Pages that answer your prompts" })).toBeVisible();
  const task = page
    .getByRole("listitem")
    .filter({ hasText: `Publish a page that answers “${prompt}”` });
  await expect(task.getByText("1 of 1 left this month")).toBeVisible();
  // Not listed a second time with the other recommendations.
  await page.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByText(`Publish a page that answers “${prompt}”`)).toHaveCount(0);
  await page.getByRole("tab", { name: "Website" }).click();

  await task.getByRole("button", { name: "Write a draft" }).click();
  // Sample data: generated text, said to be nobody's writing, read as a page with its title.
  const copy = task.locator(".page-copy");
  await expect(copy.locator(".page-title")).toContainText(prompt, LANDS);
  await expect(task.getByText(/^Sample text\. No model wrote this/)).toBeVisible();
  // The last line is composed from the location's details, and says so.
  await expect(copy.getByText("Joe's Pizza, Raleigh, NC. Call (919) 555-0100.")).toBeVisible();
  await expect(
    copy.getByText("The last line is added from this location's details."),
  ).toBeVisible();

  await task.getByRole("button", { name: "Copy the page" }).click();
  await expect(task.getByRole("button", { name: "Copied" })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.startsWith(`${prompt}: Joe's Pizza in Raleigh, NC\n\n`)).toBe(true);
  expect(copied.endsWith("\n\nJoe's Pizza, Raleigh, NC. Call (919) 555-0100.")).toBe(true);
  expect(copied).not.toContain("## ");

  // Once it is up the owner says so, and where it is.
  await task.getByRole("button", { name: "Mark published" }).click();
  const where = task.getByLabel("Where is the page?");
  await where.fill("https://elsewhere.example/late-night");
  await task.getByRole("button", { name: "Save the address" }).click();
  await expect(
    task.getByText(
      "That address is not on joespizza.example. Paste the address of the page on your site.",
    ),
  ).toBeVisible();
  await where.fill("joespizza.example/late-night-pizza");
  await task.getByRole("button", { name: "Save the address" }).click();
  await expect(
    task.getByRole("link", { name: "https://joespizza.example/late-night-pizza" }),
  ).toBeVisible();
  const proof = task.locator(".task-proof");
  await expect(proof).toContainText(/^Marked done /);
  await expect(proof).toContainText("Before: named in");
  await expect(proof).toContainText("Since: too early to say. No answer to it yet.");

  // It is kept.
  await page.reload();
  await expect(
    task.getByRole("link", { name: "https://joespizza.example/late-night-pizza" }),
  ).toBeVisible();
  await expect(task.locator(".page-copy")).toContainText(prompt);
});
