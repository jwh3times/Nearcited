import { expect, test } from "@playwright/test";
import { freshEmail } from "../support/account";
import { signInLink } from "../support/mailbox";

test("signs in with the link that is emailed, and starts a new account at onboarding", async ({
  page,
}) => {
  const email = freshEmail("link");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /is it you\?/ })).toBeVisible();

  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();

  await page.goto(await signInLink(email));
  await expect(
    page.getByRole("heading", { name: "What should we call your organization?" }),
  ).toBeVisible();
});

test("says what is wrong with an email address before sending anything", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Work email").fill("not-an-address");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter an email address, like you@company.com");
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeHidden();
});
