import { type BrowserContext, expect, type Page, type Request, test } from "@playwright/test";
import {
  type Account,
  api,
  createAccount,
  lineOf,
  onPlan,
  visitsOf,
  withVisits,
} from "../support/account";
import { BUILT_URL } from "../support/stack";

/** The business's own site, which exists only in these tests. */
const SITE = "https://joes-pizza.example";
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
async function withSite(context: BrowserContext, site: string) {
  await context.grantPermissions(["local-network-access"]);
  await context.route(`${site}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><title>Joe's Pizza</title>
        <script async src="${BUILT_URL}/line.js" data-site="${key}"></script>
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
