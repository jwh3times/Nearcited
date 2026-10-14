import { type BrowserContext, expect, type Page, type Request, test } from "@playwright/test";
import {
  type Account,
  api,
  createAccount,
  grantRole,
  lineOf,
  onPlan,
  signIn,
  visitsOf,
  withVisits,
} from "../support/account";
import { APP_URL, BUILT_URL } from "../support/stack";

/** The business's own site, which exists only in these tests. */
const SITE = "https://joes-pizza.example";
/** The same site as its owner gave it, which is the address the product sends them to. */
const ON_FILE = "https://www.joes-pizza.example";
/** Somebody else's, carrying a copy of the same line. */
const ELSEWHERE = "https://elsewhere.example";

let account: Account;
let organizationId: string;
let locationId: string;
let key: string;

test.beforeEach(async () => {
  account = await createAccount();
  const organization = await api<{ id: string }>(account, "POST", "/organizations", {
    name: "Raleigh Pizza Group",
  });
  organizationId = organization.id;
  await onPlan(organizationId, "standard");
  const location = await api<{ id: string }>(
    account,
    "POST",
    `/organizations/${organizationId}/locations`,
    { name: "Joe's Pizza", city: "Raleigh", region: "NC", website: "www.joes-pizza.example" },
  );
  locationId = location.id;
  key = (await lineOf(locationId)).key;
});

/**
 * Serves a site whose every page carries the line, as its owner would have pasted it.
 *
 * To the browser the site is out on the web and the product is on this machine, and it asks
 * before letting the one reach the other. A real site reaches a real deployment without asking.
 */
async function withSite(
  context: BrowserContext,
  site: string,
  line = `<script async src="${BUILT_URL}/line.js" data-site="${key}"></script>`,
) {
  await context.grantPermissions(["local-network-access", "clipboard-read", "clipboard-write"]);
  await context.unroute(`${site}/**`);
  await context.route(`${site}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><title>Joe's Pizza</title>
        ${line}
        </head><body><h1>Joe's Pizza</h1><a href="/menu">Menu</a></body></html>`,
    }),
  );
}

/** Everything the page posts to the product, as it is sent. */
function reports(page: Page): Request[] {
  const posted: Request[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/visits")) posted.push(request);
  });
  return posted;
}

/** Opens a page of the site as a visitor arriving from `from`, and waits for it to settle. */
async function arrive(page: Page, address: string, from?: string) {
  await page.goto(address, { referer: from });
  await expect(page.getByRole("heading", { name: "Joe's Pizza" })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

test("counts a visit to the business's site that arrived from an assistant, and no other", async ({
  page,
  context,
}) => {
  await withVisits(organizationId);
  await withSite(context, SITE);
  const posted = reports(page);

  // A search, and a visitor who typed the address: the line says nothing about either.
  await arrive(page, `${SITE}/menu`, "https://www.google.com/");
  await arrive(page, `${SITE}/menu`);
  expect(posted).toHaveLength(0);
  expect(await visitsOf(locationId)).toEqual([]);

  // From ChatGPT, landing on a page with a question mark in its address.
  await arrive(page, `${SITE}/menu?table=4&email=someone@example.com`, "https://chatgpt.com/");
  await expect
    .poll(() => visitsOf(locationId))
    .toEqual([{ assistant: "chatgpt", path: "/menu", count: 1 }]);
  expect(posted).toHaveLength(1);
  // What went: the key, the host and the path. Nothing of the address around either.
  expect(posted[0]?.postDataJSON()).toEqual({
    key,
    referrer: "chatgpt.com",
    tag: null,
    path: "/menu",
  });
  expect(await posted[0]?.headerValue("cookie")).toBeNull();

  // Looking at the page again is the same visit, and so is the next page of the site.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Menu" }).click();
  await page.waitForLoadState("networkidle");
  expect(posted).toHaveLength(1);

  // Out of ChatGPT's app, which names no site and tags the address.
  await arrive(page, `${SITE}/?utm_source=chatgpt.com`);
  // From Perplexity, whose address holds what the visitor asked.
  await arrive(page, `${SITE}/`, "https://www.perplexity.ai/search/why-does-my-knee-hurt-a1b2c3");
  await expect
    .poll(() => visitsOf(locationId))
    .toEqual([
      { assistant: "chatgpt", path: "/", count: 1 },
      { assistant: "chatgpt", path: "/menu", count: 1 },
      { assistant: "perplexity", path: "/", count: 1 },
    ]);
  expect(posted).toHaveLength(3);
  expect(JSON.stringify(posted.map((request) => request.postDataJSON()))).not.toMatch(
    /knee|someone|table/,
  );
});

test("counts nothing for a copy of the line on somebody else's site", async ({ page, context }) => {
  await withVisits(organizationId);
  await withSite(context, ELSEWHERE);
  const posted = reports(page);
  const answered = page.waitForResponse((response) => response.url().endsWith("/api/visits"));

  await arrive(page, `${ELSEWHERE}/menu`, "https://chatgpt.com/");
  // The line reported, as it does anywhere, and was told nothing.
  expect((await answered).status()).toBe(204);
  expect(posted).toHaveLength(1);
  expect(await visitsOf(locationId)).toEqual([]);
});

test("counts nothing on a plan that does not include visits", async ({ page, context }) => {
  await withSite(context, SITE);
  const answered = page.waitForResponse((response) => response.url().endsWith("/api/visits"));

  await arrive(page, `${SITE}/menu`, "https://chatgpt.com/");
  expect((await answered).status()).toBe(204);
  expect(await visitsOf(locationId)).toEqual([]);

  // The same visit once the plan includes them.
  await withVisits(organizationId);
  await arrive(page, `${SITE}/menu`, "https://chatgpt.com/");
  await expect
    .poll(() => visitsOf(locationId))
    .toEqual([{ assistant: "chatgpt", path: "/menu", count: 1 }]);
});

test("notes the owner's check that the line is there, and counts no visit for it", async ({
  page,
  context,
}) => {
  await withVisits(organizationId);
  await withSite(context, SITE);
  expect((await lineOf(locationId)).checked_on).toBeNull();

  // The owner's own look, even one that happened to arrive from an assistant.
  await arrive(page, `${SITE}/#nearcited-check`, "https://chatgpt.com/");
  await expect
    .poll(async () => (await lineOf(locationId)).checked_on)
    .toBe(new Date().toISOString().slice(0, 10));
  expect(await visitsOf(locationId)).toEqual([]);
});

/** The card on a location's Website tab. */
const card = (page: Page) => page.getByRole("region", { name: "Visits from assistants" });
const websiteTab = (base = "") => `${base}/locations/${locationId}?tab=website`;
const today = () =>
  new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(),
  );

test("hands an owner the line to paste, says where it goes, and sees it answer from their site", async ({
  page,
  context,
}) => {
  await withVisits(organizationId);
  await withSite(context, ON_FILE, "");
  await signIn(page, account, websiteTab());

  await expect(card(page)).toContainText("It reports nothing about any other visitor");
  // The line, loaded from where the product is served and carrying this location's key.
  const line = `<script async src="${APP_URL}/line.js" data-site="${key}"></script>`;
  await card(page).getByRole("button", { name: "Copy the line" }).click();
  await expect(card(page).getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(line);
  await card(page).getByText("See the line").click();
  await expect(card(page).locator("pre")).toHaveText(line);

  // Where it goes: in plain words, and by name for the builders an owner is likely to be on.
  await expect(card(page)).toContainText("It goes in your site's header code");
  await card(page).getByText("Where that is in WordPress, Wix, Squarespace and Shopify").click();
  for (const builder of ["WordPress.", "Wix.", "Squarespace.", "Shopify."]) {
    await expect(card(page).getByText(builder, { exact: true })).toBeVisible();
  }

  // Before the line is on the site, looking for it finds nothing.
  await expect(card(page).getByText("The line has not answered from your site yet.")).toBeVisible();
  const check = card(page).getByRole("link", { name: "Check the line" });
  await expect(check).toHaveAttribute("href", `${ON_FILE}/#nearcited-check`);

  // The owner pastes what they copied into their site, and opens the site to check.
  await withSite(context, ON_FILE, await page.evaluate(() => navigator.clipboard.readText()));
  const [site] = await Promise.all([context.waitForEvent("page"), check.click()]);
  await expect(site.getByRole("heading", { name: "Joe's Pizza" })).toBeVisible();
  await expect(
    card(page).getByText(`The line answered from your site on ${today()}.`),
  ).toBeVisible();
  // Checking was not a visit.
  expect(await visitsOf(locationId)).toEqual([]);

  // And the line as it was handed over counts a visit that arrives from an assistant.
  await arrive(site, `${ON_FILE}/menu`, "https://chatgpt.com/");
  await expect
    .poll(() => visitsOf(locationId))
    .toEqual([{ assistant: "chatgpt", path: "/menu", count: 1 }]);
});

test("replaces the key when its owner asks, and the line with the old one counts nothing", async ({
  page,
  context,
}) => {
  await withVisits(organizationId);
  await signIn(page, account, websiteTab());
  await card(page).getByText("See the line").click();
  const shown = card(page).locator("pre");
  const old = `<script async src="${APP_URL}/line.js" data-site="${key}"></script>`;
  await expect(shown).toHaveText(old);

  await card(page).getByText("Replace the key", { exact: true }).first().click();
  await expect(card(page)).toContainText("counts nothing until you paste the new one");
  const replace = card(page).getByRole("button", { name: "Replace the key" });

  // Asked first, and nothing happens on a no.
  page.once("dialog", (dialog) => dialog.dismiss());
  await replace.click();
  await expect(shown).toHaveText(old);
  expect((await lineOf(locationId)).key).toBe(key);

  let asked = "";
  page.once("dialog", (dialog) => {
    asked = dialog.message();
    return dialog.accept();
  });
  await replace.click();
  await expect(
    card(page).getByText("The key was replaced. Paste the new line into your site."),
  ).toBeVisible();
  expect(asked).toContain("stops counting until you paste the new one");
  const replaced = (await lineOf(locationId)).key;
  expect(replaced).not.toBe(key);
  await expect(shown).toHaveText(old.replace(key, replaced));

  // The line still on the site counts nothing. Pasted again with the new key, it counts.
  const site = await context.newPage();
  await withSite(context, SITE, old);
  const answered = site.waitForResponse((response) => response.url().endsWith("/api/visits"));
  await arrive(site, `${SITE}/menu`, "https://chatgpt.com/");
  expect((await answered).status()).toBe(204);
  expect(await visitsOf(locationId)).toEqual([]);

  await withSite(context, SITE, old.replace(key, replaced));
  await arrive(site, `${SITE}/menu`, "https://chatgpt.com/");
  await expect
    .poll(() => visitsOf(locationId))
    .toEqual([{ assistant: "chatgpt", path: "/menu", count: 1 }]);
});

test("asks for the website first where a location has none on file", async ({ page }) => {
  await withVisits(organizationId);
  const bare = await api<{ id: string }>(
    account,
    "POST",
    `/organizations/${organizationId}/locations`,
    {
      name: "Joe's Pizza Downtown",
      city: "Raleigh",
      region: "NC",
    },
  );
  await signIn(page, account, `/locations/${bare.id}?tab=website`);

  await expect(card(page)).toContainText("There is no website on file for this location.");
  await expect(card(page).getByRole("button", { name: "Copy the line" })).toHaveCount(0);
  await card(page).getByRole("button", { name: "Add it in Settings" }).click();
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("says nothing of visits where no plan counts them", async ({ page }) => {
  await signIn(page, account, websiteTab());
  await expect(page.getByRole("heading", { name: "Your website" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Visits from assistants" })).toHaveCount(0);
});

test("shows the operator a customer's line, and no way to replace its key", async ({ page }) => {
  await withVisits(organizationId);
  const operator = await createAccount();
  await api(operator, "POST", "/organizations", { name: "The operator's own" });
  await grantRole(operator, "operator");
  await signIn(page, operator, websiteTab(`/operator/o/${organizationId}`));

  await card(page).getByText("See the line").click();
  await expect(card(page).locator("pre")).toContainText(`data-site="${key}"`);
  await expect(card(page).getByRole("link", { name: "Check the line" })).toBeVisible();
  await expect(card(page).getByText("Replace the key")).toHaveCount(0);
});
