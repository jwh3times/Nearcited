import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Teammates (issue #10): an owner invites an address, the person signed in with it accepts or
 * declines, and every change to who is in an organization goes through a function that answers
 * an owner, or the person themselves, and keeps the organization an owner. No API role writes
 * `memberships` directly.
 */

const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
const shim = readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8");

const owner = "a0000000-0000-4000-8000-000000000001";
const stranger = "b0000000-0000-4000-8000-000000000002";
const member = "c0000000-0000-4000-8000-000000000003";
const admin = "d0000000-0000-4000-8000-000000000004";
const operator = "e0000000-0000-4000-8000-000000000005";
const invitee = "f0000000-0000-4000-8000-000000000006";

type Role = "anon" | "authenticated" | "service_role";

interface Invitation {
  id: string;
  organization_id: string;
  email: string;
  role: string;
  invited_by_email: string | null;
  sent_at: string;
  expires_at: string;
  ended_at: string | null;
  outcome: string | null;
}

let db: PGlite;

async function as<T>(role: Role, userId: string | null, run: () => Promise<T>): Promise<T> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
  await db.exec(`set role ${role}`);
  try {
    return await run();
  } finally {
    await db.exec("reset role");
  }
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

const signedIn = <T>(userId: string, sql: string, params: unknown[] = []) =>
  as("authenticated", userId, () => rows<T>(sql, params));

/** The owner's organization, with a member and an admin in it. */
async function organization(name = "Joe's Pizza") {
  const [made] = await signedIn<{ id: string }>(
    owner,
    "select id from public.create_organization($1)",
    [name],
  );
  if (!made) throw new Error("no organization");
  await db.query(
    "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'admin')",
    [made.id, member, admin],
  );
  return made.id;
}

const invite = (by: string, org: string, address: string, role = "member") =>
  signedIn<Invitation>(by, "select * from public.invite_member($1, $2, $3)", [org, address, role]);

/** The owner's invitation of the invitee, as an admin. */
async function invited(org: string) {
  const [invitation] = await invite(owner, org, "Invitee@Example.com ", "admin");
  if (!invitation) throw new Error("not invited");
  return invitation;
}

/** As if it were sent `hours` ago, and so expires fourteen days after that. */
const sentAgo = (id: string, hours: number) =>
  db.query(
    `update public.invitations
     set sent_at = now() - make_interval(hours => $2),
         expires_at = now() - make_interval(hours => $2) + interval '14 days'
     where id = $1`,
    [id, hours],
  );

const rolesIn = (org: string) =>
  rows<{ user_id: string; role: string }>(
    "select user_id, role::text from public.memberships where organization_id = $1 order by user_id",
    [org],
  );

describe("teammates", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(shim);
    for (const file of readdirSync(migrationsDir).sort()) {
      await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }
    await db.query(
      `insert into auth.users (id, email) values
        ($1, 'owner@example.com'), ($2, 'stranger@example.com'), ($3, 'member@example.com'),
        ($4, 'admin@example.com'), ($5, 'operator@example.com'), ($6, 'INVITEE@example.com')`,
      [owner, stranger, member, admin, operator, invitee],
    );
    await db.query("insert into public.platform_roles (user_id, role) values ($1, 'operator')", [
      operator,
    ]);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.query("delete from public.closings");
    await db.query("delete from public.organizations");
  });

  describe("inviting", () => {
    it("is an owner's, keeps the address as it signs in in any case, and names who sent it", async () => {
      const org = await organization();
      const invitation = await invited(org);
      expect(invitation).toMatchObject({
        organization_id: org,
        email: "invitee@example.com",
        role: "admin",
        invited_by_email: "owner@example.com",
        ended_at: null,
        outcome: null,
      });
      const days =
        (Date.parse(invitation.expires_at) - Date.parse(invitation.sent_at)) / 86_400_000;
      expect(days).toBe(14);
    });

    it("answers nobody but an owner, the operator included", async () => {
      const org = await organization();
      for (const who of [admin, member, stranger, operator]) {
        expect(await invite(who, org, "someone@example.com"), who).toEqual([]);
      }
      expect(await rows("select id from public.invitations")).toEqual([]);
    });

    it("refuses an owner's role, an address that is not one, and one already in or invited", async () => {
      const org = await organization();
      await expect(invite(owner, org, "someone@example.com", "owner")).rejects.toThrow(
        /Make them an owner once they have joined/,
      );
      await expect(invite(owner, org, "not an address")).rejects.toThrow(/not an email address/);
      await expect(invite(owner, org, " Member@Example.com")).rejects.toThrow(
        /already in this organization/,
      );
      await invited(org);
      await expect(invite(owner, org, "invitee@example.com")).rejects.toThrow(
        /already invited\. Send the invitation again/,
      );
    });

    it("stops at twenty waiting, and an expired or cancelled one leaves room", async () => {
      const org = await organization();
      const made: Invitation[] = [];
      for (let n = 1; n <= 20; n++) made.push(...(await invite(owner, org, `p${n}@example.com`)));
      await expect(invite(owner, org, "p21@example.com")).rejects.toThrow(/Twenty invitations/);

      await signedIn(owner, "select * from public.cancel_invitation($1, $2)", [org, made[0]?.id]);
      expect(await invite(owner, org, "p21@example.com")).toHaveLength(1);
      await sentAgo(made[1]?.id ?? "", 15 * 24);
      expect(await invite(owner, org, "p22@example.com")).toHaveLength(1);
      await expect(invite(owner, org, "p23@example.com")).rejects.toThrow(/Twenty invitations/);
    });

    it("replaces a declined invitation to the same address", async () => {
      const org = await organization();
      const first = await invited(org);
      await signedIn(invitee, "select * from public.decline_invitation($1)", [first.id]);
      await expect(invite(owner, org, "invitee@example.com")).rejects.toThrow(
        /less than an hour ago/,
      );
      await sentAgo(first.id, 2);
      const [again] = await invite(owner, org, "invitee@example.com");
      expect(again?.id).not.toBe(first.id);
      expect(
        await rows("select outcome from public.invitations where id = $1", [first.id]),
      ).toEqual([{ outcome: "cancelled" }]);
    });

    it("is refused for an organization being closed", async () => {
      const org = await organization();
      await db.query("update public.organizations set closing_at = now() where id = $1", [org]);
      expect(await invite(owner, org, "someone@example.com")).toEqual([]);
    });

    it("writes to an address at most once an hour, whatever became of the last", async () => {
      const org = await organization();
      const first = await invited(org);
      await signedIn(owner, "select * from public.cancel_invitation($1, $2)", [org, first.id]);
      await expect(invite(owner, org, "invitee@example.com")).rejects.toThrow(
        /less than an hour ago/,
      );
      await sentAgo(first.id, 2);
      expect(await invite(owner, org, "invitee@example.com")).toHaveLength(1);
    });
  });

  describe("sending again", () => {
    const again = (by: string, org: string, id: string) =>
      signedIn<Invitation>(by, "select * from public.send_invitation_again($1, $2)", [org, id]);

    it("waits an hour, then gives fourteen days from now and names who sent it", async () => {
      const org = await organization();
      await db.query(
        "update public.memberships set role = 'owner' where organization_id = $1 and user_id = $2",
        [org, admin],
      );
      const invitation = await invited(org);
      await expect(again(owner, org, invitation.id)).rejects.toThrow(/less than an hour ago/);
      await sentAgo(invitation.id, 2);
      const [sent] = await again(admin, org, invitation.id);
      // Fourteen days from the send, not from the first one two hours before.
      const left = Date.parse(sent?.expires_at ?? "") - Date.now();
      expect(left).toBeGreaterThan(14 * 86_400_000 - 60_000);
      expect(sent?.invited_by_email).toBe("admin@example.com");
    });

    it("brings back a declined or expired invitation", async () => {
      const org = await organization();
      const invitation = await invited(org);
      await signedIn(invitee, "select * from public.decline_invitation($1)", [invitation.id]);
      await sentAgo(invitation.id, 2);
      expect(await again(owner, org, invitation.id)).toMatchObject([
        { ended_at: null, outcome: null },
      ]);
      await sentAgo(invitation.id, 15 * 24);
      const [back] = await again(owner, org, invitation.id);
      expect(Date.parse(back?.expires_at ?? "")).toBeGreaterThan(Date.now());
    });

    it("answers nobody but an owner, and not for another organization's or an accepted one", async () => {
      const org = await organization();
      const invitation = await invited(org);
      await sentAgo(invitation.id, 2);
      for (const who of [admin, member, stranger, operator]) {
        expect(await again(who, org, invitation.id), who).toEqual([]);
      }
      await signedIn(invitee, "select * from public.accept_invitation($1)", [invitation.id]);
      expect(await again(owner, org, invitation.id)).toEqual([]);
    });
  });

  describe("cancelling", () => {
    const cancel = (by: string, org: string, id: string) =>
      signedIn<Invitation>(by, "select * from public.cancel_invitation($1, $2)", [org, id]);

    it("is an owner's, and stops the invitation being accepted", async () => {
      const org = await organization();
      const invitation = await invited(org);
      for (const who of [admin, member, stranger, operator]) {
        expect(await cancel(who, org, invitation.id), who).toEqual([]);
      }
      expect(await cancel(owner, org, invitation.id)).toMatchObject([{ outcome: "cancelled" }]);
      expect(
        await signedIn(invitee, "select * from public.accept_invitation($1)", [invitation.id]),
      ).toEqual([]);
      expect(await rolesIn(org)).not.toContainEqual(expect.objectContaining({ user_id: invitee }));
    });

    it("removes a declined one from the list, and leaves an accepted one alone", async () => {
      const org = await organization();
      const declined = await invited(org);
      await signedIn(invitee, "select * from public.decline_invitation($1)", [declined.id]);
      expect(await cancel(owner, org, declined.id)).toMatchObject([{ outcome: "cancelled" }]);

      await sentAgo(declined.id, 2);
      const [accepted] = await invite(owner, org, "invitee@example.com");
      await signedIn(invitee, "select * from public.accept_invitation($1)", [accepted?.id]);
      expect(await cancel(owner, org, accepted?.id ?? "")).toEqual([]);
    });
  });

  describe("accepting and declining", () => {
    const accept = (by: string, id: string) =>
      signedIn<Invitation>(by, "select * from public.accept_invitation($1)", [id]);

    it("joins the person signed in with the address, whatever its case, with its role", async () => {
      const org = await organization();
      const invitation = await invited(org);
      expect(await accept(invitee, invitation.id)).toMatchObject([{ outcome: "accepted" }]);
      expect(await rolesIn(org)).toContainEqual({ user_id: invitee, role: "admin" });
      expect(await signedIn(invitee, "select id from public.my_organizations()")).toEqual([
        { id: org },
      ]);
    });

    it("answers nobody but the person it was sent to", async () => {
      const org = await organization();
      const invitation = await invited(org);
      for (const who of [owner, admin, member, stranger, operator]) {
        expect(await accept(who, invitation.id), who).toEqual([]);
        expect(
          await signedIn(who, "select * from public.decline_invitation($1)", [invitation.id]),
          who,
        ).toEqual([]);
      }
      expect(await rows("select outcome from public.invitations")).toEqual([{ outcome: null }]);
    });

    it("is refused once it has expired, or the organization is being closed", async () => {
      const org = await organization();
      const invitation = await invited(org);
      await sentAgo(invitation.id, 15 * 24);
      await expect(accept(invitee, invitation.id)).rejects.toThrow(/has expired/);
      await sentAgo(invitation.id, 0);
      await db.query("update public.organizations set closing_at = now() where id = $1", [org]);
      await expect(accept(invitee, invitation.id)).rejects.toThrow(/being closed/);
    });

    it("is refused while the person belongs to another organization", async () => {
      const org = await organization();
      const invitation = await invited(org);
      await signedIn(invitee, "select id from public.create_organization('Their own')");
      await expect(accept(invitee, invitation.id)).rejects.toThrow(
        /already belong to an organization/,
      );
    });

    it("is refused to the operator and a test account, who join nothing", async () => {
      const org = await organization();
      await db.query("insert into public.platform_roles (user_id, role) values ($1, 'test')", [
        invitee,
      ]);
      try {
        const invitation = await invited(org);
        await expect(accept(invitee, invitation.id)).rejects.toThrow(/cannot join an organization/);
        const [toOperator] = await invite(owner, org, "operator@example.com");
        await expect(accept(operator, toOperator?.id ?? "")).rejects.toThrow(
          /cannot join an organization/,
        );
      } finally {
        await db.query("delete from public.platform_roles where user_id = $1", [invitee]);
      }
    });

    it("declining is refused once it has expired, or the organization is being closed", async () => {
      const org = await organization();
      const invitation = await invited(org);
      const decline = () =>
        signedIn(invitee, "select * from public.decline_invitation($1)", [invitation.id]);
      await sentAgo(invitation.id, 15 * 24);
      expect(await decline()).toEqual([]);
      await sentAgo(invitation.id, 0);
      await db.query("update public.organizations set closing_at = now() where id = $1", [org]);
      expect(await decline()).toEqual([]);
    });

    it("declining ends it, and the person goes on with no organization", async () => {
      const org = await organization();
      const invitation = await invited(org);
      expect(
        await signedIn(invitee, "select * from public.decline_invitation($1)", [invitation.id]),
      ).toMatchObject([{ outcome: "declined" }]);
      expect(await accept(invitee, invitation.id)).toEqual([]);
      expect(await signedIn(invitee, "select id from public.my_organizations()")).toEqual([]);
    });

    it("lists the person's own waiting invitations, and nobody else's", async () => {
      const org = await organization();
      const invitation = await invited(org);
      const mine = () => signedIn(invitee, "select * from public.my_invitations()");
      expect(await mine()).toMatchObject([
        {
          id: invitation.id,
          organization_id: org,
          organization_name: "Joe's Pizza",
          role: "admin",
          invited_by_email: "owner@example.com",
        },
      ]);
      for (const who of [owner, stranger, operator]) {
        expect(await signedIn(who, "select * from public.my_invitations()"), who).toEqual([]);
      }
      await sentAgo(invitation.id, 15 * 24);
      expect(await mine()).toEqual([]);
      await sentAgo(invitation.id, 0);
      await db.query("update public.organizations set closing_at = now() where id = $1", [org]);
      expect(await mine()).toEqual([]);
    });
  });

  describe("roles, removing and leaving", () => {
    const change = (by: string, org: string, who: string, role: string) =>
      signedIn(by, "select * from public.change_member_role($1, $2, $3)", [org, who, role]);
    const remove = (by: string, org: string, who: string) =>
      signedIn(by, "select * from public.remove_member($1, $2)", [org, who]);
    const leave = (by: string, org: string) =>
      signedIn(by, "select * from public.leave_organization($1)", [org]);

    it("an owner changes a role, owner included, and nobody else can", async () => {
      const org = await organization();
      for (const who of [admin, member, stranger, operator]) {
        expect(await change(who, org, member, "admin"), who).toEqual([]);
        expect(await change(who, org, who, "owner"), who).toEqual([]);
      }
      expect(await change(owner, org, member, "owner")).toMatchObject([{ role: "owner" }]);
      expect(await change(owner, org, admin, "member")).toMatchObject([{ role: "member" }]);
    });

    it("keeps an owner, by every path that could lose the last", async () => {
      const org = await organization();
      await expect(change(owner, org, owner, "admin")).rejects.toThrow(/needs an owner/);
      await expect(remove(owner, org, owner)).rejects.toThrow(/needs an owner/);
      await expect(leave(owner, org)).rejects.toThrow(/needs an owner/);
      expect(await rolesIn(org)).toContainEqual({ user_id: owner, role: "owner" });

      // With a second owner, either may step down or go.
      await change(owner, org, admin, "owner");
      expect(await change(owner, org, owner, "member")).toMatchObject([{ role: "member" }]);
      await expect(leave(admin, org)).rejects.toThrow(/needs an owner/);
    });

    it("an owner removes someone, who keeps their sign-in, and nobody else can", async () => {
      const org = await organization();
      for (const who of [admin, member, stranger, operator]) {
        expect(await remove(who, org, member), who).toEqual([]);
      }
      expect(await remove(owner, org, member)).toMatchObject([{ user_id: member }]);
      expect(await rolesIn(org)).not.toContainEqual(expect.objectContaining({ user_id: member }));
      expect(await rows("select id from auth.users where id = $1", [member])).toHaveLength(1);
      // Gone, they may make an organization of their own.
      expect(
        await signedIn(member, "select id from public.create_organization('Their own')"),
      ).toHaveLength(1);
    });

    it("anyone but the last owner may leave, and a stranger leaves nothing", async () => {
      const org = await organization();
      expect(await leave(stranger, org)).toEqual([]);
      expect(await leave(member, org)).toMatchObject([{ user_id: member }]);
      expect(await leave(admin, org)).toMatchObject([{ user_id: admin }]);
      expect(await rolesIn(org)).toEqual([{ user_id: owner, role: "owner" }]);
    });

    it("writes nothing to memberships directly, an owner's request included", async () => {
      const org = await organization();
      for (const sql of [
        "insert into public.memberships (organization_id, user_id, role) values ($1, 'b0000000-0000-4000-8000-000000000002', 'owner')",
        "update public.memberships set role = 'member' where organization_id = $1",
        "delete from public.memberships where organization_id = $1",
      ]) {
        await expect(
          as("authenticated", owner, () => db.query(sql, [org])),
          sql,
        ).rejects.toThrow(/permission denied/);
      }
    });
  });

  describe("who sees what", () => {
    it("every member and the operator see who is in it, with their addresses", async () => {
      const org = await organization();
      const members = (who: string) =>
        signedIn<{ email: string; role: string }>(
          who,
          "select email, role::text from public.organization_members($1)",
          [org],
        );
      const expected = [
        { email: "owner@example.com", role: "owner" },
        { email: "admin@example.com", role: "admin" },
        { email: "member@example.com", role: "member" },
      ];
      for (const who of [owner, admin, member, operator]) {
        expect(await members(who), who).toEqual(expected);
      }
      expect(await members(stranger)).toEqual([]);
    });

    it("each person reads their own role, and the operator only its own", async () => {
      const org = await organization();
      const roles = (who: string) =>
        signedIn(who, "select organization_id, role::text from public.my_roles()");
      expect(await roles(owner)).toEqual([{ organization_id: org, role: "owner" }]);
      expect(await roles(admin)).toEqual([{ organization_id: org, role: "admin" }]);
      expect(await roles(operator)).toEqual([]);
      expect(await roles(stranger)).toEqual([]);
    });

    it("only owners and the operator read invitations", async () => {
      const org = await organization();
      await invited(org);
      const read = (who: string) => signedIn(who, "select email from public.invitations");
      expect(await read(owner)).toEqual([{ email: "invitee@example.com" }]);
      expect(await read(operator)).toEqual([{ email: "invitee@example.com" }]);
      for (const who of [admin, member, stranger, invitee])
        expect(await read(who), who).toEqual([]);
      await expect(
        as("authenticated", owner, () => db.query("update public.invitations set role = 'member'")),
      ).rejects.toThrow(/permission denied/);
    });

    it("the export holds the invitations", async () => {
      const org = await organization();
      await invited(org);
      const [exported] = await signedIn<{ export: { invitations: Invitation[] } }>(
        owner,
        "select public.export_organization($1) as export",
        [org],
      );
      expect(exported?.export.invitations).toMatchObject([
        { email: "invitee@example.com", role: "admin", invited_by_email: "owner@example.com" },
      ]);
    });
  });
});
