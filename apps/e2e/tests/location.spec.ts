import { expect, test } from "@playwright/test";
import {
  type Account,
  api,
  createAccount,
  onPlan,
  signIn,
  withDrop,
  withNewBusiness,
  withOtherNumber,
  withScannedLocation,
  withUncheckedDetails,
  withUnnamedSource,
} from "../support/account";

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
  await expect(page.getByText("1 of 3 locations")).toBeVisible();
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
  await page.getByLabel("What we do").fill("  Wood-fired pizza, family-run since 1998.  ");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await page.reload();
  await expect(phone).toHaveValue("(919) 555-0100");
  await expect(page.getByLabel("Website")).toHaveValue("https://joespizza.example");
  await expect(page.getByLabel("What we do")).toHaveValue(
    "Wood-fired pizza, family-run since 1998.",
  );
  // How often it is scanned is the plan's to say: the page states it and offers no setting.
  await expect(page.getByRole("group", { name: "Scheduled scans" })).toHaveCount(0);
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

test("marks a task done, keeps that with the location, and takes it back", async ({ page }) => {
  await withUnnamedSource(locationPath.replace("/locations/", ""), "yelp.com");
  await signIn(page, account, locationPath);
  const task = page
    .getByRole("listitem")
    .filter({ hasText: "Claim and complete your listing on yelp.com" });
  await expect(task).toBeVisible();

  await task.getByRole("button", { name: "Mark done" }).click();
  await expect(task.getByText(/^Marked done /)).toContainText("Since: too early to say.");

  // It is kept with the location, not in this browser.
  await page.reload();
  await expect(task.getByText(/^Marked done /)).toBeVisible();
  await task.getByRole("button", { name: "Undo" }).click();
  await expect(task.getByText(/^Marked done /)).toHaveCount(0);
  await expect(task.getByRole("button", { name: "Mark done" })).toBeVisible();
});

test("shows a drop on the Overview and in the list, and takes it off when dismissed", async ({
  page,
}) => {
  const prompt = await withDrop(account, locationPath.replace("/locations/", ""));
  await signIn(page, account);
  const row = page.getByRole("link", { name: /Joe's Pizza/ }).filter({ hasText: "1 alert" });
  await expect(row).toBeVisible();

  await row.click();
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByRole("heading", { name: "Alerts" })).toBeVisible();
  const alert = panel
    .getByRole("listitem")
    .filter({ hasText: `No longer named for "${prompt}" on ChatGPT` });
  // It says what was counted, and nothing about what to do.
  await expect(alert).toContainText(
    "It was named in 4 of the 4 checks before that and in none of the 3 since.",
  );

  await alert.getByRole("button", { name: /^Dismiss/ }).click();
  await expect(alert).toHaveCount(0);
  // It is kept with the location, not in this browser.
  await page.reload();
  await expect(panel.getByRole("heading", { name: "What to do next" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Alerts" })).toHaveCount(0);
});

test("shows a business named for the first time, and leads to the answers that named it", async ({
  page,
}) => {
  await withNewBusiness(locationPath.replace("/locations/", ""), "Corner Slice Co");
  await signIn(page, account, locationPath);
  const panel = page.getByRole("tabpanel");
  const alert = panel
    .getByRole("listitem")
    .filter({ hasText: "Corner Slice Co is named for the first time" });
  await expect(alert).toContainText(
    'Named in 4 answers across 2 of the last 3 scans, and in no answer before. It was named for "Who makes the best pizza in Raleigh?" on ChatGPT and Claude.',
  );

  await alert.getByRole("button", { name: /Read the answers/ }).click();
  await expect(page).toHaveURL(/tab=answers/);
  await expect(panel.getByRole("heading", { name: "What the answers said" })).toBeVisible();
});

test("shows a phone number the answers give that is not on file, and lets a member say it is theirs", async ({
  page,
}) => {
  await withOtherNumber(locationPath.replace("/locations/", ""));
  await signIn(page, account, locationPath);
  const panel = page.getByRole("tabpanel");
  const alert = panel
    .getByRole("listitem")
    .filter({ hasText: "The answers give a different phone number: (919) 555-0199" });
  await expect(alert).toContainText("The number on file is (919) 555-0100.");

  await alert.getByRole("button", { name: /^This number is ours/ }).click();
  await expect(alert).toHaveCount(0);
  await page.reload();
  await expect(panel.getByRole("heading", { name: "What to do next" })).toBeVisible();
  await expect(panel.getByText("different phone number")).toHaveCount(0);
});

test("offers the structured details to paste where the page has none, and copies them", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await withUncheckedDetails(account, locationPath.replace("/locations/", ""));
  await signIn(page, account, `${locationPath}?tab=website`);
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByText("Your home page has no structured business details")).toBeVisible();
  // It says where it goes, and what is not on file to put in it.
  await expect(panel.getByText(/Paste it into the HTML of joespizza\.example/)).toBeVisible();
  await expect(
    panel.getByText(
      "Not on file, so not in the block: street address, postal code and phone number.",
    ),
  ).toBeVisible();

  await panel.getByRole("button", { name: "Copy the block" }).click();
  await expect(panel.getByRole("button", { name: "Copied" })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^<script type="application\/ld\+json">/);
  expect(JSON.parse(copied.slice(copied.indexOf("{"), copied.lastIndexOf("}") + 1))).toEqual({
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: "Joe's Pizza",
    url: "https://joespizza.example",
    address: {
      "@type": "PostalAddress",
      addressLocality: "Raleigh",
      addressRegion: "NC",
      addressCountry: "US",
    },
  });

  // The block can be read before it is copied, and the missing details lead to Settings.
  await panel.getByText("See the block").click();
  // The tab holds another thing to paste, the line that counts visits, so the block is named.
  await expect(panel.locator("pre").filter({ hasText: "application/ld+json" })).toContainText(
    '"@type": "LocalBusiness"',
  );
  await panel.getByRole("button", { name: "Add them in Settings" }).click();
  await expect(page).toHaveURL(/tab=settings/);

  // The plan's website step offers the same block.
  await page.getByRole("tab", { name: "Overview" }).click();
  const step = panel.getByRole("listitem").filter({ hasText: "Your website is not being cited" });
  await expect(step.getByRole("button", { name: "Copy the block" })).toBeVisible();
});

test("marks the structured details as pasted, keeps that with the location, and takes it back", async ({
  page,
}) => {
  await withUncheckedDetails(account, locationPath.replace("/locations/", ""));
  await signIn(page, account, `${locationPath}?tab=website`);
  const card = page.getByRole("tabpanel").locator(".paste-block");
  await expect(card.getByText("Once it is on the page, mark it done.")).toBeVisible();

  await card.getByRole("button", { name: "Mark done" }).click();
  const marked = card.getByText(/^Marked done /);
  // No scan has looked since, and it does not pretend one has.
  await expect(marked).toContainText("The next scan will look for it.");
  await expect(marked).toContainText("Before: 0 of 6 answers cited your website.");
  await expect(marked).toContainText("Since: too early to say. No answer has come in yet.");

  // It is kept with the location, not in this browser.
  await page.reload();
  await expect(marked).toBeVisible();
  await card.getByRole("button", { name: "Undo" }).click();
  await expect(marked).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Mark done" })).toBeVisible();
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

test("pauses what a smaller plan does not cover, deletes nothing, and lets the owner swap", async ({
  page,
}, testInfo) => {
  const owner = await createAccount();
  const { organization, location } = await withScannedLocation(owner, "Shrinking Pizza Group");
  const second = await api<{ id: string }>(
    owner,
    "POST",
    `/organizations/${organization.id}/locations`,
    { name: "Joe's Pizza Durham", city: "Durham", region: "NC" },
  );
  // The subscription ends: the organization is back on the free plan, which covers one location
  // and two prompts.
  await onPlan(organization.id, "free");

  await signIn(page, owner, `/locations/${second.id}`);
  const notice = page.getByRole("status").filter({ hasText: "This location is paused" });
  await expect(notice).toContainText("Your plan covers 1 location");
  await expect(page.getByRole("button", { name: "Run scan" })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("paused.png") });

  // The first location kept its results, and its third prompt was set aside, not removed.
  await page.goto(`/locations/${location.id}`);
  await expect(page.getByText("/ 100")).toBeVisible();
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByText("set aside by your plan")).toHaveCount(1);

  // Swap: scan the second location in place of the first.
  await page.goto(`/locations/${second.id}`);
  await notice.getByRole("button", { name: "Scan this one instead of Joe's Pizza" }).click();
  await expect(notice).toBeHidden();
  await page.goto(`/locations/${location.id}`);
  await expect(notice).toBeVisible();
});
