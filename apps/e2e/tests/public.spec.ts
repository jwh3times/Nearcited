import { expect, test } from "@playwright/test";

for (const [path, heading] of [
  ["/privacy", "Privacy policy"],
  ["/terms", "Terms of service"],
  ["/bot", "Our crawler"],
] as const) {
  test(`shows ${path} to someone who is not signed in`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    await expect(page).toHaveTitle(`${heading} | Nearcited`);
    await expect(page.getByRole("link", { name: "Contact" })).toHaveAttribute(
      "href",
      /^mailto:support@/,
    );
  });
}

test("links the policies from the sign-in page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "privacy policy" }).click();
  await expect(page.getByRole("heading", { name: "Privacy policy", level: 1 })).toBeVisible();
});

test("says a report is gone when its link names none", async ({ page }) => {
  await page.goto(`/audit/${"ab".repeat(32)}`);
  await expect(
    page.getByRole("heading", { name: "This report is no longer available" }),
  ).toBeVisible();
});
