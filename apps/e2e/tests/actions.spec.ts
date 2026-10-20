import { expect, type Page, test } from "@playwright/test";
import { type Account, api, createAccount, onPlan, signIn } from "../support/account";

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
  // There is nothing left of it to take back.
  await expect(done.getByRole("button", { name: "Take it back" })).toHaveCount(0);
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

/** A location's actions, as the API answers. */
const actionsAt = (account: Account, locationId: string) =>
  api<{
    waiting: { id: string }[];
    record: { status: string; summary: string }[];
  }>(account, "GET", `/locations/${locationId}/actions`);

test("after three approvals, does the next one without a yes until it is switched off", async ({
  page,
}) => {
  const account = await createAccount();
  const organization = await api<{ id: string }>(account, "POST", "/organizations", {
    name: "Raleigh Pizza Group",
  });
  // A plan that includes standing permission, with room for three locations.
  await onPlan(organization.id, "pro");
  const connection = await api<{ id: string }>(
    account,
    "POST",
    `/organizations/${organization.id}/connections`,
    { kind: "sample" },
  );
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
  // Three locations, each matched to a sample listing, each with its opening line proposed and
  // approved as proposed.
  const locations: string[] = [];
  for (const [n, name] of ["Joe's Pizza", "Joe's Pizza Uptown", "Joe's Pizza Downtown"].entries()) {
    const location = await api<{ id: string }>(
      account,
      "POST",
      `/organizations/${organization.id}/locations`,
      { name, city: "Raleigh" },
    );
    locations.push(location.id);
    await api(account, "PUT", `/connections/${connection.id}/locations/${location.id}`, {
      external_id: `sample-listing-${n + 1}`,
    });
    await expect
      .poll(async () => (await actionsAt(account, location.id)).waiting.length, {
        timeout: 30_000,
      })
      .toBe(1);
    const [waiting] = (await actionsAt(account, location.id)).waiting;
    await api(account, "POST", `/actions/${waiting?.id}/approve`, {});
    await expect
      .poll(async () => (await actionsAt(account, location.id)).record[0]?.status, {
        timeout: 30_000,
      })
      .toBe("done");
  }
  const [first = ""] = locations;
  await signIn(page, account, `/locations/${first}?tab=actions`);

  // Offered, asked about first, and given for every location.
  const standing = page.getByRole("region", { name: "Standing permission" });
  await expect(standing).toContainText("Stop asking: set the opening line of a sample listing?");
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("at every location of your organization");
    void dialog.accept();
  });
  await standing.getByRole("button", { name: "Do these without asking" }).click();
  await expect(standing).toContainText(
    "Done without asking: set the opening line of a sample listing",
  );
  await expect(standing).toContainText(`Given by ${account.email}`);

  // The location's details change, and its line is proposed again: done without a yes.
  await api(account, "PATCH", `/locations/${first}`, {
    name: "Joe's Pizza and Subs",
    city: "Raleigh",
  });
  await api(account, "DELETE", `/connections/${connection.id}/locations/${first}`);
  await api(account, "PUT", `/connections/${connection.id}/locations/${first}`, {
    external_id: "sample-listing-1",
  });
  // The worker does it on its own time, and nobody is asked.
  await expect
    .poll(
      async () =>
        (await actionsAt(account, first)).record.filter((action) => action.status === "done")
          .length,
      { timeout: 30_000 },
    )
    .toBe(2);
  await page.reload();
  const happened = page.getByRole("region", { name: "What happened" });
  await expect(happened).toContainText(
    `without waiting for a yes, under the standing permission ${account.email} gave on`,
  );
  await expect(happened).toContainText("Joe's Pizza and Subs in Raleigh");
  await expect(page.getByText("Nothing is waiting.")).toBeVisible();

  // Switched off, it is offered again: three still count.
  page.once("dialog", (dialog) => void dialog.accept());
  await standing.getByRole("button", { name: "Switch it off" }).click();
  await expect(standing).toContainText("Stop asking: set the opening line of a sample listing?");
});
