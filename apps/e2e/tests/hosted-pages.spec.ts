import { expect, test } from "@playwright/test";
import { api, createAccount, onPlan, signIn, withLiveSubdomain } from "../support/account";

/** The local stack runs on sample data, where an answer subdomain is made but never registered. */
test("sets up an answer subdomain: the record to add, the wait for it, and the page once it works", async ({
  page,
}) => {
  const account = await createAccount();
  // A name is held by one connection across every account, so each run has a domain of its own.
  const domain = `joes-${crypto.randomUUID().slice(0, 8)}.example`;
  const organization = await api<{ id: string }>(account, "POST", "/organizations", {
    name: "Raleigh Pizza Group",
  });
  // Pages on the business's own domain come with Pro.
  await onPlan(organization.id, "pro");
  const location = await api<{ id: string }>(
    account,
    "POST",
    `/organizations/${organization.id}/locations`,
    { name: "Joe's Pizza", city: "Raleigh", website: `https://www.${domain}/menu` },
  );
  await signIn(page, account, `/locations/${location.id}?tab=website`);

  const card = page.locator("section", {
    has: page.getByRole("heading", { name: "Pages on your own domain" }),
  });
  await expect(card).toContainText("a subdomain of your own domain");
  const name = card.getByLabel("Subdomain");
  await expect(name).toHaveValue("answers");
  await expect(card).toContainText(`Your pages would be at answers.${domain}`);
  await name.fill("help desk");
  await expect(card.getByRole("button", { name: "Set up the subdomain" })).toBeDisabled();
  await name.fill("answers");
  await card.getByRole("button", { name: "Set up the subdomain" }).click();

  // The one record to add, which points at a target of this subdomain's own.
  const record = card.getByRole("list", { name: "The record to add" });
  await expect(record).toContainText("CNAME");
  await expect(record).toContainText("answers");
  await expect(record).toContainText(/[a-z0-9]{12}\.pages\.nearcited\.com/);
  await expect(card).toContainText(`answers.${domain}`);
  await expect(card).toContainText("DNS only");
  await card.getByText("Where to add a record, at the common providers").click();
  for (const registrar of ["GoDaddy", "Namecheap", "Squarespace Domains", "Cloudflare"]) {
    await expect(card.getByRole("link", { name: registrar, exact: true })).toBeVisible();
  }
  await expect(
    card.getByRole("status").filter({ hasText: "Waiting for the record" }),
  ).toBeVisible();

  // The worker finds the record and Cloudflare issues the certificate.
  const hosted = await api<{ subdomain: { connection_id: string } }>(
    account,
    "GET",
    `/locations/${location.id}/hosted-pages`,
  );
  await withLiveSubdomain(hosted.subdomain.connection_id);
  await page.reload();
  await expect(card).toContainText(`Working. Pages approved here go up at answers.${domain}`);
  await expect(card).toContainText(
    `<a href="https://answers.${domain}/">Answers to common questions</a>`,
  );
  await expect(card.getByRole("button", { name: "Copy the link" })).toBeVisible();

  // It is removed as any connection is, from the Connections page.
  await card.getByRole("link", { name: "Connections" }).click();
  const connected = page.getByRole("article", { name: `answers.${domain}` });
  await expect(connected).toContainText("Joe's Pizza");
  await expect(connected.getByRole("combobox")).toHaveCount(0);
});
