import { expect, type Page, test } from "@playwright/test";
import { type Account, api, createAccount, signIn } from "../support/account";

const LINE = "Joe's Pizza in Raleigh: open every day. Call ahead for large orders.";
const SUMMARY = "Set the opening line of Sample listing: Riverside";

/**
 * An account with a location matched to a sample account, and the action the worker proposed
 * for it. Set up through the API, as the Connections test covers doing it by hand.
 */
async function withProposal(): Promise<{ account: Account; locationId: string }> {
  const account = await createAccount();
  const organization = await api<{ id: string }>(account, "POST", "/organizations", {
    name: "Raleigh Pizza Group",
  });
  const location = await api<{ id: string }>(
    account,
    "POST",
    `/organizations/${organization.id}/locations`,
    { name: "Joe's Pizza", city: "Raleigh" },
  );
  const connection = await api<{ id: string }>(
    account,
    "POST",
    `/organizations/${organization.id}/connections`,
    { kind: "sample" },
  );
  // The worker reads what the account reaches, which is what a location can be matched to.
  await expect
    .poll(
      async () =>
        (
          await api<{ connections: { last_synced_at: string | null }[] }>(
            account,
            "GET",
            `/organizations/${organization.id}/connections`,
          )
        ).connections[0]?.last_synced_at ?? null,
      { timeout: 30_000 },
    )
    .not.toBeNull();
  await api(account, "PUT", `/connections/${connection.id}/locations/${location.id}`, {
    external_id: "sample-listing-2",
  });
  // The match queues another read, and the worker proposes what it could do.
  await expect
    .poll(
      async () =>
        (await api<{ waiting: unknown[] }>(account, "GET", `/locations/${location.id}/actions`))
          .waiting.length,
      { timeout: 30_000 },
    )
    .toBe(1);
  return { account, locationId: location.id };
}

const openActions = async (page: Page, account: Account, locationId: string) => {
  await signIn(page, account, `/locations/${locationId}?tab=actions`);
  await expect(page.getByRole("tab", { name: /Actions/ })).toHaveAttribute("aria-selected", "true");
};

test("shows what would be done, does it on a yes with the text changed, and keeps the record", async ({
  page,
}) => {
  const { account, locationId } = await withProposal();
  await openActions(page, account, locationId);

  // The sidebar says where something is waiting.
  await expect(page.getByRole("link", { name: /Joe's Pizza/ })).toContainText("1 waiting");
  const proposal = page.getByRole("article", { name: SUMMARY });
  await expect(proposal).toContainText("What is there now");
  await expect(proposal).toContainText("Nothing");
  await expect(proposal).toContainText("Composed by rule from this location's details");
  const text = proposal.getByRole("textbox");
  await expect(text).toHaveValue(LINE);
  await expect(proposal.getByRole("button", { name: "Approve", exact: true })).toBeVisible();

  // A member may change what it says first, and the button says that is what they approve.
  await text.fill("Joe's Pizza: open late on Fridays.");
  await proposal.getByRole("button", { name: "Approve as changed" }).click();

  // The worker carries it out without the page being reloaded.
  await expect(page.getByText("Nothing is waiting.")).toBeVisible();
  const happened = page.getByRole("region", { name: "What happened" });
  await expect(happened).toContainText("Done on", { timeout: 30_000 });
  await expect(happened).toContainText(`Approved by ${account.email}, who changed the text.`);
  await expect(happened).toContainText("Joe's Pizza: open late on Fridays.");
  // The record keeps what it replaced beside what it wrote.
  await expect(happened).toContainText("What it replaced");
  await page.reload();
  await expect(page.getByRole("link", { name: /Joe's Pizza/ })).not.toContainText("waiting");
});

test("takes back what was done, after asking, and keeps both in the record", async ({ page }) => {
  const { account, locationId } = await withProposal();
  await openActions(page, account, locationId);
  await page
    .getByRole("article", { name: SUMMARY })
    .getByRole("button", { name: "Approve", exact: true })
    .click();
  const done = page.getByRole("article", { name: SUMMARY, exact: true });
  await expect(done).toContainText("Done on", { timeout: 30_000 });

  // Asked first; saying no to the question does nothing.
  page.once("dialog", (dialog) => dialog.dismiss());
  await done.getByRole("button", { name: "Take it back" }).click();
  await expect(page.getByRole("article", { name: `Take back: ${SUMMARY}` })).toHaveCount(0);

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("put back what was there before");
    void dialog.accept();
  });
  await done.getByRole("button", { name: "Take it back" }).click();
  const back = page.getByRole("article", { name: `Take back: ${SUMMARY}` });
  await expect(back).toContainText("Done on", { timeout: 30_000 });
  await expect(back).toContainText(`Asked for by ${account.email}.`);
  // What it took away was the line the first one wrote.
  await expect(back).toContainText(LINE);
  await expect(done).toContainText("Done on");
  // Taken back, the same line is not offered again: that was a no.
  await page.reload();
  await expect(page.getByText("Nothing is waiting.")).toBeVisible();
});

test("lets a member say no, with a reason that is kept, and does nothing", async ({ page }) => {
  const { account, locationId } = await withProposal();
  await openActions(page, account, locationId);

  const proposal = page.getByRole("article", { name: SUMMARY });
  await proposal.getByRole("button", { name: "Decline", exact: true }).click();
  // Going back loses nothing.
  await proposal.getByRole("button", { name: "Back" }).click();
  await proposal.getByRole("button", { name: "Decline", exact: true }).click();
  await proposal.getByRole("textbox").last().fill("We close on Mondays.");
  await proposal.getByRole("button", { name: "Decline it" }).click();

  await expect(page.getByText("Nothing is waiting.")).toBeVisible();
  await expect(page.getByRole("region", { name: "What happened" })).toContainText(
    `Declined by ${account.email}`,
  );
  await expect(page.getByRole("region", { name: "What happened" })).toContainText(
    "We close on Mondays.",
  );
});
