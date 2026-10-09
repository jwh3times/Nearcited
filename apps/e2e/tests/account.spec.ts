import { expect, test } from "@playwright/test";
import { api, createAccount, onPlan, signIn } from "../support/account";

test("renames the organization from Account settings, everywhere at once", async ({ page }) => {
  const account = await createAccount();
  await api(account, "POST", "/organizations", { name: "Raleigh Pizza Group" });
  await signIn(page, account);

  await page.getByRole("link", { name: "Account settings" }).click();
  await expect(page.getByRole("heading", { name: "Account settings" })).toBeVisible();
  // Nothing to save until the name is different.
  await expect(page.getByRole("button", { name: "Save name" })).toBeDisabled();

  const name = page.getByLabel("Organization name");
  await name.fill("   ");
  await name.blur();
  await expect(page.getByText("Name is required")).toBeVisible();

  await name.fill("Triangle Pizza Group");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.locator(".org-card")).toContainText("Triangle Pizza Group");

  await page.reload();
  await expect(page.locator(".org-card")).toContainText("Triangle Pizza Group");
  // What the plan allows is shown, and not offered for editing.
  await expect(page.getByText("Prompts and keywords")).toBeVisible();
  await expect(page.getByText("0 of 0 this month")).toBeVisible();
  // The owner is shown the way to the plans. Nothing can be bought where no provider is set up.
  await expect(page.getByText("Subscriptions are not available here yet.")).toBeVisible();
  await page.getByRole("link", { name: "See plans and prices" }).click();
  await expect(page.getByRole("heading", { name: "Pricing", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Free plan" })).toContainText("Your plan");
  await expect(page.getByRole("region", { name: "Starter plan" })).toContainText(
    "Subscriptions are not available here yet.",
  );
});

test("lets the owner of a free organization choose which assistant it is checked on", async ({
  page,
}) => {
  const account = await createAccount();
  await api(account, "POST", "/organizations", { name: "Free Pizza Group" });
  await signIn(page, account, "/settings");

  await expect(page.getByRole("heading", { name: "Your plan: Free" })).toBeVisible();
  const chooser = page.getByRole("group", { name: "Assistant to check" });
  await expect(chooser.getByRole("button", { name: "ChatGPT" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await chooser.getByRole("button", { name: "Claude" }).click();
  await expect(chooser.getByRole("button", { name: "Claude" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // It is what the account now says, not only what the button shows.
  const me = await api<{ organizations: { surfaces: string[] }[] }>(account, "GET", "/me");
  expect(me.organizations[0]?.surfaces).toEqual(["claude"]);
});

test("lets a subscriber change plan and locations, saying what it costs before it is done", async ({
  page,
}) => {
  const account = await createAccount();
  const organization = await api<{ id: string }>(account, "POST", "/organizations", {
    name: "Subscribed Pizza Group",
  });
  await onPlan(organization.id, "starter");
  // The local stack has no payment provider, so what it would say is supplied here.
  const billing = {
    available: true,
    subscribed: true,
    status: "active",
    has_customer: true,
    locations: 1,
    renews_at: "2026-11-09T00:00:00.000Z",
    paying: { price_cents: 2900, extra_location_price_cents: 1000, monthly_cents: 2900 },
    price_change: null,
    pending: null as null | Record<string, unknown>,
  };
  const asked: unknown[] = [];
  await page.route("**/api/organizations/*/account", (route) =>
    route.fulfill({ json: { manual_scans_used: 0, billing } }),
  );
  await page.route("**/api/organizations/*/subscription/preview", (route) => {
    const input = route.request().postDataJSON() as { plan_key: string; locations: number };
    const upgrade = input.plan_key !== "starter" || input.locations > 1;
    return route.fulfill({
      json: {
        kind: upgrade ? "upgrade" : "downgrade",
        ...input,
        monthly_cents: 4900,
        due_now_cents: upgrade ? 2145 : null,
        effective_at: upgrade ? null : billing.renews_at,
      },
    });
  });
  await page.route("**/api/organizations/*/subscription", (route) => {
    const input = route.request().postDataJSON() as { plan_key: string; locations: number };
    asked.push(input);
    return route.fulfill({
      json: {
        kind: "upgrade",
        ...input,
        monthly_cents: 4900,
        due_now_cents: 2145,
        effective_at: null,
      },
    });
  });

  await signIn(page, account, "/settings");
  await expect(
    page.getByText("Paying $29 a month for 1 location, before tax. Renews on"),
  ).toBeVisible();
  await page.getByRole("link", { name: "Change plan or locations" }).click();

  // Their own plan is marked, and offers only a change in how many locations it pays for.
  const starter = page.getByRole("region", { name: "Starter plan" });
  await expect(starter).toContainText("Your plan");
  await expect(starter.getByRole("button", { name: "Update locations on Starter" })).toBeDisabled();
  await starter.getByRole("button", { name: "One location more" }).click();
  await expect(starter).toContainText("$39 a month");
  await expect(starter.getByRole("button", { name: "Update locations on Starter" })).toBeEnabled();

  // Going free is cancelling, which is done at the payment provider.
  await expect(
    page
      .getByRole("region", { name: "Free plan" })
      .getByRole("button", { name: "Cancel subscription" }),
  ).toBeVisible();

  // Another plan says what is charged before anything is.
  const standard = page.getByRole("region", { name: "Standard plan" });
  await standard.getByRole("button", { name: "Switch to Standard" }).click();
  await expect(standard).toContainText("Your card is charged $21.45 today");
  expect(asked).toEqual([]);
  await standard.getByRole("button", { name: "Back" }).click();
  await standard.getByRole("button", { name: "Switch to Standard" }).click();
  await standard.getByRole("button", { name: "Confirm and pay" }).click();

  await expect(page.getByText("Your new plan shows here in a moment.")).toBeVisible();
  expect(asked).toEqual([{ plan_key: "standard", locations: 3 }]);

  // A change waiting for the period to end is shown, with the way to call it off.
  billing.pending = {
    plan_key: "starter",
    locations: 1,
    monthly_cents: 2900,
    at: billing.renews_at,
  };
  await page.goto("/settings");
  await expect(page.getByText("Changes to Starter with 1 location on")).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep my current plan" })).toBeVisible();
});
