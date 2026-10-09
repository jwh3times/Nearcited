import { expect, test } from "@playwright/test";
import {
  api,
  createAccount,
  grantRole,
  onPlan,
  recordUsage,
  signIn,
  withScannedLocation,
} from "../support/account";

test("shows the operator every organization, and lets them read a customer's account without changing it", async ({
  page,
}) => {
  const customerName = `Customer ${Date.now()}`;
  const customer = await createAccount();
  const { location } = await withScannedLocation(customer, customerName);

  const operator = await createAccount();
  await api(operator, "POST", "/organizations", { name: "The operator's own" });
  await grantRole(operator, "operator");
  await signIn(page, operator);

  // The link is in the sidebar, and the page lists the customer among everyone.
  await page.getByRole("link", { name: "Operator", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Operator", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();
  await expect(page.getByText("Deployed commit")).toBeVisible();
  // The customer is among the accounts, with how far they have got; the funnel counts them.
  await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
  const account = page.locator("div.gtable-row", { hasText: customer.email });
  await expect(account).toContainText(customerName);
  await expect(account).toContainText("Scanned in the last 7 days");
  await expect(page.getByRole("heading", { name: "Audits" })).toBeVisible();
  // The customer also appears under "Needs attention", so the row is found in the table.
  // A row of the organizations table is a link; an account's row, which also names it, is not.
  const row = page.locator("a.gtable-row", { hasText: customerName });
  await expect(row).toContainText("1 of");
  await expect(row).toContainText("Succeeded");

  // Reading through: the customer's sidebar and pages, under a bar that says whose they are.
  await row.click();
  await expect(page.getByRole("status").filter({ hasText: "as the operator" })).toContainText(
    customerName,
  );
  await expect(page.locator(".org-card")).toContainText(customerName);
  await expect(page.getByRole("button", { name: "Add location" })).toBeHidden();
  await page
    .getByRole("link", { name: /Joe's Pizza/ })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/operator/o/[0-9a-f-]+/locations/${location.id}`));
  await expect(page.getByRole("heading", { name: "Joe's Pizza", level: 1 })).toBeVisible();
  await expect(page.getByText("/ 100")).toBeVisible();

  // Nothing that changes anything is offered.
  await expect(page.getByRole("button", { name: "Run scan" })).toBeHidden();
  await page.getByRole("tab", { name: /Prompts/ }).click();
  await expect(page.getByText("“Who makes the best pizza in Raleigh?”")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Retire/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add prompt" })).toBeHidden();
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByLabel("Business name")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Delete location" })).toBeHidden();

  // And back out to the operator's own account.
  await page.getByRole("link", { name: "Back to the operator view" }).click();
  await expect(page.getByRole("heading", { name: "Operator", level: 1 })).toBeVisible();
  await expect(page.locator(".org-card")).toContainText("The operator's own");
});

test("lets the operator change a customer's limits, which the customer then has", async ({
  page,
}) => {
  const customerName = `Customer ${Date.now()}`;
  const customer = await createAccount();
  const organization = await api<{ id: string; max_locations: number }>(
    customer,
    "POST",
    "/organizations",
    { name: customerName },
  );
  const operator = await createAccount();
  await api(operator, "POST", "/organizations", { name: "The operator's own" });
  await grantRole(operator, "operator");

  await signIn(page, operator, `/operator/o/${organization.id}`);
  await page.getByRole("link", { name: "plan and limits" }).click();
  await expect(page.getByRole("heading", { name: "Plan and limits", level: 1 })).toBeVisible();
  const locations = page.getByRole("textbox", { name: "Locations", exact: true });
  await expect(locations).toHaveValue(String(organization.max_locations));
  await expect(page.getByRole("button", { name: "Save limits" })).toBeDisabled();

  // A value the plan cannot hold is refused beside the field, before anything is sent.
  const every = page.getByLabel("Days between scheduled scans");
  await every.fill("0");
  await every.blur();
  await expect(page.getByRole("alert")).toHaveText("Enter 1 or more");
  await every.fill("1");

  await locations.fill("3");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await expect(page.getByRole("link", { name: /All locations/ })).toContainText("0/3");

  // The customer's own account now says so.
  const me = await api<{ organizations: { max_locations: number; scan_every_days: number }[] }>(
    customer,
    "GET",
    "/me",
  );
  expect(me.organizations[0]).toMatchObject({ max_locations: 3, scan_every_days: 1 });
});

test("offers the operator a form for a new audit, which a sample-data deployment refuses to run", async ({
  page,
}, testInfo) => {
  const operator = await createAccount();
  await api(operator, "POST", "/organizations", { name: "The operator's own" });
  await grantRole(operator, "operator");
  await signIn(page, operator, "/operator");

  await page.getByRole("button", { name: "New audit" }).click();
  // Nothing is sent until the form would be accepted, and each field says what it lacks.
  await page.getByRole("button", { name: "Make audit" }).click();
  await expect(page.getByText("Name is required")).toBeVisible();
  await expect(page.getByText("Give at least one prompt")).toBeVisible();

  await page.getByLabel("Business name").fill("Tony's Slice House");
  await page.getByLabel("Website").fill("tonys.example");
  await page.getByLabel("City").fill("Raleigh");
  await page.getByLabel("Prompt 1").fill("Who makes the best pizza in Raleigh?");
  await page.getByRole("button", { name: "Add another prompt" }).click();
  await page.getByLabel("Prompt 2").fill("Where can I eat late in Raleigh?");
  await page.getByLabel("Times each prompt is asked").fill("2");
  await expect(page.getByText("This asks every assistant for 4 answers")).toBeVisible();
  await page
    .locator("form", { hasText: "New audit" })
    .screenshot({ path: testInfo.outputPath("new-audit.png") });

  // An audit is read as a measurement, so the local stack, which serves sample data, makes none.
  await page.getByRole("button", { name: "Make audit" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Audits need live data" })).toBeVisible();
  await expect(page.getByText("Tony's Slice House")).toHaveCount(0);
});

test("shows the operator what each month cost, and says what it could not price", async ({
  page,
}, testInfo) => {
  const customer = await createAccount();
  const organization = await api<{ id: string }>(customer, "POST", "/organizations", {
    name: `Spender ${Date.now()}`,
  });
  // A model nothing has a rate for, so this reads the same whatever rates the build was given.
  const model = `e2e-unpriced-${Date.now()}`;
  await recordUsage(organization.id, { model, calls: 3 });
  await recordUsage(organization.id, { model, calls: 4 });

  const operator = await createAccount();
  await api(operator, "POST", "/organizations", { name: "The operator's own" });
  await grantRole(operator, "operator");
  await signIn(page, operator, "/operator");

  await expect(page.getByRole("heading", { name: "Spend" })).toBeVisible();
  const thisMonth = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date());
  await expect(page.getByText(`${thisMonth}, so far`)).toBeVisible();
  // The two scans' calls are added up, and their cost is admitted to be unknown.
  await expect(page.getByRole("status").filter({ hasText: "Not counted" })).toContainText(
    `7 calls to ${model} in ${thisMonth}`,
  );
  await page
    .locator("section", { has: page.getByRole("heading", { name: "Spend" }) })
    .screenshot({ path: testInfo.outputPath("spend.png") });
});

test("has no operator page for anyone else", async ({ page }) => {
  const account = await createAccount();
  await api(account, "POST", "/organizations", { name: "Raleigh Pizza Group" });
  await signIn(page, account, "/operator");
  // The address leads nowhere and the sidebar offers no way in.
  await expect(page.getByRole("heading", { name: "Locations", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Operator", exact: true })).toHaveCount(0);
});

test("shows the operator who is on each plan, and changes what one allows for everyone on it", async ({
  page,
}) => {
  const customer = await createAccount();
  const organization = await api<{ id: string }>(customer, "POST", "/organizations", {
    name: `Enterprise customer ${Date.now()}`,
  });
  // Enterprise, because no other test reads what it allows: a plan is shared by everyone.
  await onPlan(organization.id, "enterprise");
  const operator = await createAccount();
  await api(operator, "POST", "/organizations", { name: "The operator's own" });
  await grantRole(operator, "operator");
  const [before] = (
    await api<{ key: string; max_manual_scans_per_month: number }[]>(
      operator,
      "GET",
      "/operator/plans",
    )
  ).filter((plan) => plan.key === "enterprise");

  await signIn(page, operator, "/operator");
  await expect(page.getByRole("heading", { name: "Plans" })).toBeVisible();
  const row = page.locator("div.gtable-row", { hasText: "Enterprise" }).first();
  await expect(row).toContainText("$399");
  await row.getByRole("button", { name: "Edit Enterprise" }).click();

  const form = page.getByRole("form", { name: "Edit Enterprise" });
  await expect(form.getByRole("button", { name: "Save plan" })).toBeDisabled();
  const byHand = form.getByLabel("Scans run by hand per month");
  try {
    // Lowering a limit says who it reaches, and waits to be told again.
    await byHand.fill("7");
    await form.getByRole("button", { name: "Save plan" }).click();
    await expect(form.getByRole("alert")).toContainText("This lowers what the plan allows for");
    await expect(form.getByRole("alert")).toContainText("Nothing is deleted.");
    const me = () =>
      api<{ organizations: { max_manual_scans_per_month: number }[] }>(customer, "GET", "/me");
    expect((await me()).organizations[0]?.max_manual_scans_per_month).toBe(
      before?.max_manual_scans_per_month,
    );

    await form.getByRole("button", { name: "Save, and lower it for them" }).click();
    await expect(form).toBeHidden();
    // The customer has the new limit without doing anything.
    expect((await me()).organizations[0]?.max_manual_scans_per_month).toBe(7);
  } finally {
    await api(operator, "PUT", "/operator/plans/enterprise", {
      name: "Enterprise",
      on_sale: true,
      max_queries_per_location: 15,
      assistants: 2,
      scan_every_days: 1,
      max_manual_scans_per_month: before?.max_manual_scans_per_month ?? 60,
      emails_report: true,
    });
  }
});
