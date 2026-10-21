import { expect, test } from "@playwright/test";
import { api, createAccount, signIn } from "../support/account";

test("an owner invites a teammate, who accepts, sees the locations, and is removed", async ({
  page,
  browser,
}) => {
  const owner = await createAccount();
  const teammate = await createAccount();
  const organization = await api<{ id: string }>(owner, "POST", "/organizations", {
    name: "Teammates Pizza Group",
  });
  await api(owner, "POST", `/organizations/${organization.id}/locations`, {
    name: "Joe's Pizza",
    city: "Raleigh",
  });

  // The owner invites the teammate's address, in another case, as a member.
  await signIn(page, owner, "/settings");
  const members = page.getByRole("region", { name: "Members" });
  await expect(members.getByText(owner.email)).toBeVisible();
  const invite = members.getByRole("form", { name: "Invite someone" });
  await invite.getByLabel("Email address").fill(teammate.email.toUpperCase());
  await invite.getByRole("button", { name: "Invite" }).click();
  await expect(invite.getByRole("status")).toContainText(`Invited ${teammate.email}`);
  await expect(members.getByText(/^Member · Waiting until /)).toBeVisible();

  // Signed in with that address, the teammate is asked before anything else, and accepts.
  const theirs = await (await browser.newContext()).newPage();
  await signIn(theirs, teammate);
  await expect(theirs.getByRole("heading", { name: "You are invited" })).toBeVisible();
  await expect(
    theirs.getByText(`${owner.email} invited you to Teammates Pizza Group as a member.`),
  ).toBeVisible();
  await theirs.getByRole("button", { name: "Accept" }).click();
  await expect(theirs.getByRole("heading", { name: "Locations" })).toBeVisible();
  await expect(theirs.getByRole("main").getByText("Joe's Pizza")).toBeVisible();

  // The owner sees them in, and removes them.
  await page.reload();
  const row = members.getByRole("listitem").filter({ hasText: teammate.email });
  await expect(row.getByRole("combobox", { name: `Role of ${teammate.email}` })).toHaveValue(
    "member",
  );
  // The last owner cannot step down or go: no role to change and no button on their own row.
  const own = members.getByRole("listitem").filter({ hasText: owner.email });
  await expect(own.getByRole("combobox")).toHaveCount(0);
  await expect(own.getByRole("button", { name: "Leave" })).toHaveCount(0);
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(row).toContainText("They lose access at once.");
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(members.getByText(teammate.email)).toHaveCount(0);

  // Gone, they land where an account with no organization starts.
  await theirs.reload();
  await expect(theirs.getByLabel("Organization name")).toBeVisible();
});
