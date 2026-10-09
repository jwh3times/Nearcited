import { describe, expect, it } from "vitest";
import { type AccountFacts, buildAccounts } from "../src/operator";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const user = (id: string, daysAgo: number, lastSignIn: number | null = daysAgo) => ({
  user_id: id,
  email: `${id}@example.com`,
  created_at: ago(daysAgo),
  last_sign_in_at: lastSignIn === null ? null : ago(lastSignIn),
});

const facts = (): AccountFacts => ({
  now: NOW,
  accounts: [
    user("new", 1),
    user("named", 3),
    user("placed", 5),
    user("scanned", 30, 20),
    user("active", 40, 1),
    user("robot", 2),
    user("boss", 60, 0),
  ],
  roles: { robot: "test", boss: "operator" },
  memberships: [
    { user_id: "named", organization_id: "o-named" },
    { user_id: "placed", organization_id: "o-placed" },
    { user_id: "scanned", organization_id: "o-scanned" },
    { user_id: "active", organization_id: "o-active" },
    { user_id: "robot", organization_id: "o-robot" },
    { user_id: "boss", organization_id: "o-boss" },
  ],
  organizations: [
    { id: "o-named", name: "Named" },
    { id: "o-placed", name: "Placed" },
    { id: "o-scanned", name: "Scanned" },
    { id: "o-active", name: "Active" },
    { id: "o-robot", name: "Smoke test" },
    { id: "o-boss", name: "The operator's" },
  ],
  locations: [
    { organization_id: "o-placed", last_scanned_at: null },
    { organization_id: "o-scanned", last_scanned_at: ago(20) },
    { organization_id: "o-active", last_scanned_at: ago(30) },
    { organization_id: "o-active", last_scanned_at: ago(2) },
    { organization_id: "o-robot", last_scanned_at: ago(0) },
    { organization_id: "o-boss", last_scanned_at: ago(1) },
  ],
});

describe("buildAccounts", () => {
  it("says how far each account has got, newest first", () => {
    const { accounts } = buildAccounts(facts());
    expect(accounts.map((account) => [account.email, account.stage])).toEqual([
      ["new@example.com", "signed_up"],
      ["robot@example.com", "active"],
      ["named@example.com", "organization"],
      ["placed@example.com", "location"],
      ["scanned@example.com", "scanned"],
      ["active@example.com", "active"],
      ["boss@example.com", "active"],
    ]);
    expect(accounts[2]).toEqual({
      user_id: "named",
      email: "named@example.com",
      created_at: ago(3),
      last_sign_in_at: ago(3),
      platform_role: null,
      organization_id: "o-named",
      organization_name: "Named",
      stage: "organization",
    });
  });

  it("counts everyone who got at least as far as each stage, leaving test accounts out", () => {
    // Six real accounts: the operator is a customer too, and the robot is not counted.
    expect(buildAccounts(facts()).funnel).toEqual([
      { stage: "signed_up", count: 6 },
      { stage: "organization", count: 5 },
      { stage: "location", count: 4 },
      { stage: "scanned", count: 3 },
      { stage: "active", count: 2 },
    ]);
  });

  it("handles an account whose email or last sign-in is unknown", () => {
    const some = facts();
    some.accounts = [{ user_id: "ghost", email: null, created_at: ago(1), last_sign_in_at: null }];
    expect(buildAccounts(some).accounts[0]).toMatchObject({
      email: null,
      last_sign_in_at: null,
      stage: "signed_up",
    });
  });
});
