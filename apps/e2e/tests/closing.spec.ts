import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { api, createAccount, signIn, signInWithPassword } from "../support/account";
import { SESSION_KEY } from "../support/stack";

test("an owner downloads everything, closes the account, and the account is gone", async ({
  page,
}) => {
  const account = await createAccount();
  const organization = await api<{ id: string }>(account, "POST", "/organizations", {
    name: "Closing Pizza Group",
  });
  await api(account, "POST", `/organizations/${organization.id}/locations`, {
    name: "Joe's Pizza",
    city: "Raleigh",
  });
  await signIn(page, account, "/settings");

  // Everything, first: a ZIP named for the organization, with a spreadsheet for each list.
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download everything" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(
    /^nearcited-closing-pizza-group-\d{4}-\d{2}-\d{2}\.zip$/,
  );
  // A ZIP names its files in the clear at its end.
  const zip = (await readFile(await download.path())).toString("latin1");
  expect(zip.startsWith("PK")).toBe(true);
  for (const name of ["everything.json", "locations.csv", "README.txt"]) {
    expect(zip).toContain(name);
  }

  // What closing does is said before anything is done, and the name has to be typed out.
  await page.getByRole("button", { name: "Close this account" }).click();
  const form = page.getByRole("form", { name: "Close this account" });
  await expect(form).toContainText("The rest of this month is not refunded.");
  await expect(form).toContainText("stays there until you remove it");
  const confirm = form.getByRole("button", { name: "Close the account" });
  await expect(confirm).toBeDisabled();
  await form.getByLabel("Type Closing Pizza Group to confirm").fill("Closing Pizza");
  await expect(confirm).toBeDisabled();
  await form.getByLabel("Type Closing Pizza Group to confirm").fill("Closing Pizza Group");
  await confirm.click();

  // Signed out at once, and told what happens next.
  await expect(page.getByRole("heading", { name: "Your account is being closed" })).toBeVisible();
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SESSION_KEY)).toBeNull();

  // The worker closes it within moments: the sign-in is gone, and signing in again is refused.
  await expect
    .poll(
      () =>
        signInWithPassword(account.email, account.password).then(
          () => "still there",
          () => "gone",
        ),
      { timeout: 60_000, intervals: [1_000] },
    )
    .toBe("gone");
});
