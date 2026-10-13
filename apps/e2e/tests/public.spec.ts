import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { BUILT_URL } from "../support/stack";

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

test("shows the price list to a visitor, and takes them to sign in when they choose a plan", async ({
  page,
}) => {
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { name: "Pricing", level: 1 })).toBeVisible();
  await expect(page).toHaveTitle("Pricing | Nearcited");
  for (const name of ["Free", "Starter", "Standard", "Pro", "Enterprise"]) {
    await expect(page.getByRole("region", { name: `${name} plan` })).toBeVisible();
  }
  await expect(page.getByRole("region", { name: "Free plan" })).toContainText("$0 a month");

  await page.getByRole("button", { name: "Choose Starter" }).click();
  await expect(page.getByLabel("Work email")).toBeVisible();
});

test("serves the licence of every package the app includes, beside the app", async ({
  request,
}) => {
  const response = await request.get(`${BUILT_URL}/third-party-licenses.md`);
  const text = await response.text();
  // An address with no file behind it is answered with the app's own page, so the file is
  // known by what it says. It is written when the web app is built.
  expect(text, "Build the web app: pnpm --filter @nearcited/web build").toMatch(/^# Licenses/);

  // Every package the web app depends on is in it, under its own name, with its licence.
  const { dependencies } = JSON.parse(
    readFileSync(join(import.meta.dirname, "../../web/package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  const bundled = Object.keys(dependencies).filter((name) => !name.startsWith("@nearcited/"));
  expect(bundled.length).toBeGreaterThan(0);
  const headings = text.split("\n").filter((line) => line.startsWith("## "));
  for (const name of bundled) {
    expect(
      headings.filter((heading) => heading.startsWith(`## ${name} - `)),
      name,
    ).toHaveLength(1);
  }
  // Each heading names the licence, and the words of one are there to read.
  for (const heading of headings) expect(heading).toMatch(/ - \S+ \(.+\)$/);
  expect(text).toContain("Permission is hereby granted");

  // And the app's own page says where the file is.
  const page = await (await request.get(`${BUILT_URL}/`)).text();
  expect(page).toContain("/third-party-licenses.md");
});
