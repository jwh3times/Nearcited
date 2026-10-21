import {
  InvitationSchema,
  InvitedSchema,
  MembersSchema,
  MeSchema,
  OrganizationSchema,
} from "@nearcited/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Email } from "../src/email/report";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

/** Alice owns the organization, Bob is an admin in it, Carol a stranger and Dave is invited. */
const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const carol = "c0000000-0000-4000-8000-000000000003";
const dave = "d0000000-0000-4000-8000-000000000004";

let db: MemoryDb;
let env: Env;
let sent: { to: string[]; email: Email }[];
let sendFails: boolean;

const app = createApp({
  authenticate: async (request) => {
    const userId = request.headers.get("Authorization")?.replace("Bearer ", "");
    return userId
      ? {
          user: { id: userId, email: db.emails.get(userId) ?? null },
          store: memoryStore(db, userId),
        }
      : null;
  },
  publicStore: () => memoryStore(db, "nobody"),
  sendEmail: async (_env, to, email) => {
    if (sendFails) throw new Error("The mail service is down.");
    sent.push({ to, email });
  },
});

function call(user: string | null, method: string, path: string, body?: unknown) {
  return app.request(
    `/api${path}`,
    {
      method,
      headers: {
        ...(user ? { Authorization: `Bearer ${user}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string } }).error;

async function anOrganization() {
  const made = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  db.memberships.push({ organization_id: made.id, user_id: bob, role: "admin" });
  return made;
}

const invite = (
  user: string,
  organizationId: string,
  email = "Dave@Example.com ",
  role = "member",
) => call(user, "POST", `/organizations/${organizationId}/invitations`, { email, role });

async function invited(organizationId: string) {
  const response = await invite(alice, organizationId);
  expect(response.status).toBe(201);
  return InvitedSchema.parse(await response.json());
}

const me = async (user: string) => MeSchema.parse(await (await call(user, "GET", "/me")).json());

/** Moves the clock on, as far as the store is concerned. */
const later = (hours: number) => {
  db.now = new Date(Date.now() + hours * 3_600_000).toISOString();
};

beforeEach(() => {
  db = createMemoryDb();
  sent = [];
  sendFails = false;
  for (const [user, email] of [
    [alice, "alice@example.com"],
    [bob, "bob@example.com"],
    [carol, "carol@example.com"],
    [dave, "dave@example.com"],
  ] as const) {
    db.emails.set(user, email);
  }
  env = {
    PROVIDER_MODE: "live",
    APP_URL: "https://app.nearcited.example",
    RESEND_API_KEY: "re_test",
  } as unknown as Env;
});

describe("inviting", () => {
  it("emails the person, naming the organization and who invited them, from the request", async () => {
    const organization = await anOrganization();
    const { invitation, emailed } = await invited(organization.id);
    expect(emailed).toBe(true);
    expect(invitation).toMatchObject({
      email: "dave@example.com",
      role: "member",
      invited_by_email: "alice@example.com",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(["dave@example.com"]);
    expect(sent[0]?.email.subject).toBe(
      "alice@example.com invited you to Raleigh Pizza Group on Nearcited",
    );
    expect(sent[0]?.email.text).toContain(
      "as a member, who can see everything, run scans, and approve or decline actions.",
    );
    expect(sent[0]?.email.text).toContain("sign in with this address (dave@example.com)");
    expect(sent[0]?.email.text).toContain("https://app.nearcited.example");
  });

  it("says no email went where there is no mail service, or the send failed, and keeps it", async () => {
    const organization = await anOrganization();
    env = { ...env, RESEND_API_KEY: undefined } as unknown as Env;
    expect((await invited(organization.id)).emailed).toBe(false);
    expect(sent).toEqual([]);

    env = { ...env, RESEND_API_KEY: "re_test" } as unknown as Env;
    sendFails = true;
    const response = await invite(alice, organization.id, "eve@example.com", "admin");
    expect(response.status).toBe(201);
    expect(InvitedSchema.parse(await response.json()).emailed).toBe(false);
    expect(db.invitations.map((i) => i.email).sort()).toEqual([
      "dave@example.com",
      "eve@example.com",
    ]);
  });

  it("sends nothing for a test organization", async () => {
    db.testAccounts.add(alice);
    const organization = await anOrganization();
    expect(organization.is_test).toBe(true);
    expect((await invited(organization.id)).emailed).toBe(false);
    expect(sent).toEqual([]);
  });

  it("answers nobody but an owner", async () => {
    const organization = await anOrganization();
    db.operators.add(carol);
    for (const user of [bob, carol]) {
      expect((await invite(user, organization.id)).status, user).toBe(404);
    }
    expect(db.invitations).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("refuses an owner's role, an address that is not one, and one already in or invited", async () => {
    const organization = await anOrganization();
    expect((await invite(alice, organization.id, "dave@example.com", "owner")).status).toBe(422);
    expect((await invite(alice, organization.id, "not an address")).status).toBe(422);
    const already = await invite(alice, organization.id, "bob@example.com");
    expect(already.status).toBe(409);
    expect((await errorOf(already)).message).toBe("They are already in this organization.");
    await invited(organization.id);
    expect((await invite(alice, organization.id)).status).toBe(409);
  });

  it("writes to an address at most once an hour, cancelled or not", async () => {
    const organization = await anOrganization();
    const { invitation } = await invited(organization.id);
    await call(alice, "DELETE", `/organizations/${organization.id}/invitations/${invitation.id}`);
    const soon = await invite(alice, organization.id);
    expect(soon.status).toBe(409);
    expect((await errorOf(soon)).message).toMatch(/less than an hour ago/);
    later(2);
    expect((await invite(alice, organization.id)).status).toBe(201);
    expect(sent).toHaveLength(2);
  });

  it("stops at twenty waiting", async () => {
    const organization = await anOrganization();
    for (let n = 1; n <= 20; n++) {
      expect((await invite(alice, organization.id, `p${n}@example.com`)).status).toBe(201);
    }
    const refused = await invite(alice, organization.id, "p21@example.com");
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).message).toMatch(/Twenty invitations/);
  });
});

describe("the members of an organization", () => {
  it("every member sees who is in it, and only an owner sees the invitations", async () => {
    const organization = await anOrganization();
    await invited(organization.id);
    const read = async (user: string) =>
      MembersSchema.parse(
        await (await call(user, "GET", `/organizations/${organization.id}/members`)).json(),
      );

    const owners = await read(alice);
    expect(owners.members.map((m) => [m.email, m.role])).toEqual([
      ["alice@example.com", "owner"],
      ["bob@example.com", "admin"],
    ]);
    expect(owners.invitations?.map((i) => i.email)).toEqual(["dave@example.com"]);

    const admins = await read(bob);
    expect(admins.members).toEqual(owners.members);
    expect(admins.invitations).toBeNull();

    expect((await call(carol, "GET", `/organizations/${organization.id}/members`)).status).toBe(
      404,
    );
  });

  it("the operator reads the invitations too, and changes nothing", async () => {
    const organization = await anOrganization();
    await invited(organization.id);
    db.operators.add(carol);
    const read = MembersSchema.parse(
      await (await call(carol, "GET", `/organizations/${organization.id}/members`)).json(),
    );
    expect(read.invitations?.map((i) => i.email)).toEqual(["dave@example.com"]);
    expect(
      (await call(carol, "DELETE", `/organizations/${organization.id}/members/${bob}`)).status,
    ).toBe(404);
  });

  it("tells each person their own role", async () => {
    const organization = await anOrganization();
    expect((await me(alice)).roles).toEqual({ [organization.id]: "owner" });
    expect((await me(bob)).roles).toEqual({ [organization.id]: "admin" });
    expect((await me(carol)).roles).toEqual({});
  });
});

describe("sending again and cancelling", () => {
  it("sends again after an hour, for fourteen days from then, and emails again", async () => {
    const organization = await anOrganization();
    const { invitation } = await invited(organization.id);
    const path = `/organizations/${organization.id}/invitations/${invitation.id}/send`;

    const soon = await call(alice, "POST", path);
    expect(soon.status).toBe(409);
    expect((await errorOf(soon)).message).toMatch(/less than an hour ago/);

    later(2);
    const again = await call(alice, "POST", path);
    expect(again.status).toBe(200);
    const { invitation: resent, emailed } = InvitedSchema.parse(await again.json());
    expect(emailed).toBe(true);
    expect(Date.parse(resent.expires_at)).toBeGreaterThan(Date.parse(invitation.expires_at));
    expect(sent).toHaveLength(2);
    expect((await call(bob, "POST", path)).status).toBe(404);
  });

  it("cancels for an owner only, and a cancelled one cannot be accepted", async () => {
    const organization = await anOrganization();
    const { invitation } = await invited(organization.id);
    const path = `/organizations/${organization.id}/invitations/${invitation.id}`;
    expect((await call(bob, "DELETE", path)).status).toBe(404);
    expect((await call(alice, "DELETE", path)).status).toBe(204);
    expect((await call(dave, "POST", `/invitations/${invitation.id}/accept`)).status).toBe(404);
    expect((await me(dave)).invitations).toEqual([]);
  });
});

describe("accepting and declining", () => {
  it("shows the invited person their invitation, and accepting joins them with its role", async () => {
    const organization = await anOrganization();
    const { invitation } = await invited(organization.id);
    expect((await me(dave)).invitations).toEqual([
      expect.objectContaining({
        id: invitation.id,
        organization_name: "Raleigh Pizza Group",
        invited_by_email: "alice@example.com",
        role: "member",
      }),
    ]);

    const accepted = await call(dave, "POST", `/invitations/${invitation.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(InvitationSchema.parse(await accepted.json()).outcome).toBe("accepted");
    const now = await me(dave);
    expect(now.organizations.map((o) => o.id)).toEqual([organization.id]);
    expect(now.roles).toEqual({ [organization.id]: "member" });
    expect(now.invitations).toEqual([]);
  });

  it("answers nobody but the person it was sent to", async () => {
    const organization = await anOrganization();
    const { invitation } = await invited(organization.id);
    for (const user of [alice, bob, carol]) {
      expect((await call(user, "POST", `/invitations/${invitation.id}/accept`)).status).toBe(404);
      expect((await call(user, "POST", `/invitations/${invitation.id}/decline`)).status).toBe(404);
    }
  });

  it("is refused while the person has an organization of their own", async () => {
    const organization = await anOrganization();
    const { invitation } = await invited(organization.id);
    await call(dave, "POST", "/organizations", { name: "Dave's Diner" });
    const refused = await call(dave, "POST", `/invitations/${invitation.id}/accept`);
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).message).toMatch(/already belong to an organization/);
  });

  it("is refused to the operator, who joins nothing", async () => {
    const organization = await anOrganization();
    db.operators.add(dave);
    const { invitation } = await invited(organization.id);
    const refused = await call(dave, "POST", `/invitations/${invitation.id}/accept`);
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).message).toBe("This account cannot join an organization.");
  });

  it("declining ends it, and the owner sees it declined", async () => {
    const organization = await anOrganization();
    const { invitation } = await invited(organization.id);
    expect((await call(dave, "POST", `/invitations/${invitation.id}/decline`)).status).toBe(204);
    expect((await me(dave)).invitations).toEqual([]);
    const { invitations } = MembersSchema.parse(
      await (await call(alice, "GET", `/organizations/${organization.id}/members`)).json(),
    );
    expect(invitations?.map((i) => i.outcome)).toEqual(["declined"]);
  });
});

describe("roles, removing and leaving", () => {
  it("an owner changes a role, and nobody else can", async () => {
    const organization = await anOrganization();
    const path = `/organizations/${organization.id}/members/${bob}`;
    expect((await call(bob, "PATCH", path, { role: "owner" })).status).toBe(404);
    expect((await call(alice, "PATCH", path, { role: "owner" })).status).toBe(204);
    expect((await me(bob)).roles).toEqual({ [organization.id]: "owner" });
  });

  it("keeps an owner: the last cannot step down, be removed or leave", async () => {
    const organization = await anOrganization();
    for (const response of [
      await call(alice, "PATCH", `/organizations/${organization.id}/members/${alice}`, {
        role: "admin",
      }),
      await call(alice, "DELETE", `/organizations/${organization.id}/members/${alice}`),
      await call(alice, "POST", `/organizations/${organization.id}/leave`),
    ]) {
      expect(response.status).toBe(409);
      expect((await errorOf(response)).message).toMatch(/needs an owner/);
    }
    expect((await me(alice)).roles).toEqual({ [organization.id]: "owner" });
  });

  it("an owner removes someone, and they are left with no organization", async () => {
    const organization = await anOrganization();
    const path = `/organizations/${organization.id}/members/${bob}`;
    expect((await call(carol, "DELETE", path)).status).toBe(404);
    expect((await call(alice, "DELETE", path)).status).toBe(204);
    expect((await me(bob)).organizations).toEqual([]);
  });

  it("anyone else may leave", async () => {
    const organization = await anOrganization();
    expect((await call(carol, "POST", `/organizations/${organization.id}/leave`)).status).toBe(404);
    expect((await call(bob, "POST", `/organizations/${organization.id}/leave`)).status).toBe(204);
    expect((await me(bob)).organizations).toEqual([]);
  });
});
