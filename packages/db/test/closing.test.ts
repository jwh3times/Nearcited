import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Closing an account (issue #210): who may ask, what the ask marks, that an organization being
 * closed is out of its members' reach and out of the worker's schedule, the record the worker
 * keeps, which no API role reads, and the fingerprint that keeps a fresh free first scan from the
 * same address for thirty days.
 */

const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
const shim = readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8");

const owner = "a0000000-0000-4000-8000-000000000001";
const stranger = "b0000000-0000-4000-8000-000000000002";
const member = "c0000000-0000-4000-8000-000000000003";
const admin = "d0000000-0000-4000-8000-000000000004";
const operator = "e0000000-0000-4000-8000-000000000005";
const tester = "f0000000-0000-4000-8000-000000000006";
const again = "a1000000-0000-4000-8000-000000000007";
const other = "a2000000-0000-4000-8000-000000000008";

type Role = "anon" | "authenticated" | "service_role";

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

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await rows<T>(sql, params);
  if (!row) throw new Error(`No row: ${sql}`);
  return row;
}

/** An organization `by` made, with Bob a member and Dave an admin, a location and a connection. */
async function organizationOf(by: string, name = "Joe's Pizza") {
  const { id: org } = await as("authenticated", by, () =>
    one<{ id: string }>("select id from public.create_organization($1)", [name]),
  );
  await db.query(
    "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'admin') on conflict do nothing",
    [org, member, admin],
  );
  const { id: location } = await one<{ id: string }>(
    "insert into public.locations (organization_id, name, city) values ($1, 'Joe''s Pizza', 'Raleigh') returning id",
    [org],
  );
  await db.query(
    "insert into public.tracked_queries (location_id, kind, text) values ($1, 'ai_prompt', 'late night pizza')",
    [location],
  );
  const { id: connection } = await one<{ id: string }>(
    "insert into public.connections (id, organization_id, kind, label) values (gen_random_uuid(), $1, 'wordpress', 'joespizza.example') returning id",
    [org],
  );
  return { org, location, connection };
}

const ask = (userId: string | null, org: string, name = "Joe's Pizza") =>
  as(userId ? "authenticated" : "anon", userId, () =>
    one<{ closing_id: string | null; refused: string | null }>(
      "select * from public.request_closing($1, $2)",
      [org, name],
    ),
  );

const fingerprint = (email: string) =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

describe("closing an account", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(shim);
    for (const file of readdirSync(migrationsDir).sort()) {
      await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }
    await db.query(
      `insert into auth.users (id, email) values
        ($1, 'Owner@Example.com'), ($2, 'stranger@example.com'), ($3, 'member@example.com'),
        ($4, 'admin@example.com'), ($5, 'operator@example.com'), ($6, 'tester@example.com'),
        ($7, 'other@example.com')`,
      [owner, stranger, member, admin, operator, tester, other],
    );
    await db.query(
      "insert into public.platform_roles (user_id, role) values ($1, 'operator'), ($2, 'test')",
      [operator, tester],
    );
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.query("delete from public.closings");
    await db.query("delete from public.organizations");
  });

  it("is asked by an owner who types the name, and marks the organization and its connections", async () => {
    const { org, connection } = await organizationOf(owner);
    const asked = await ask(owner, org, "  Joe's Pizza ");
    expect(asked.refused).toBeNull();
    expect(asked.closing_id).toEqual(expect.any(String));

    const kept = await one<{
      organization_name: string;
      owner_id: string;
      owner_email: string;
      member_emails: string[];
      fingerprint: string;
    }>("select * from public.closings where id = $1", [asked.closing_id]);
    expect(kept).toMatchObject({
      organization_name: "Joe's Pizza",
      owner_id: owner,
      owner_email: "Owner@Example.com",
      member_emails: ["admin@example.com", "member@example.com"],
      fingerprint: fingerprint("owner@example.com"),
    });
    expect(
      await one(
        "select closing_at is not null as closing from public.organizations where id = $1",
        [org],
      ),
    ).toEqual({ closing: true });
    expect(
      await one("select status, removal_reason from public.connections where id = $1", [
        connection,
      ]),
    ).toEqual({ status: "removing", removal_reason: "closing" });

    // Asking again is the same closing.
    expect((await ask(owner, org)).closing_id).toBe(asked.closing_id);
    expect(await rows("select id from public.closings")).toHaveLength(1);
  });

  it("is refused to anyone but an owner, to the operator, to a test account and to a wrong name", async () => {
    const { org } = await organizationOf(owner);
    for (const user of [member, admin, stranger]) {
      expect(await ask(user, org)).toEqual({ closing_id: null, refused: "owners_only" });
    }
    expect(await ask(owner, org, "Joe's")).toEqual({ closing_id: null, refused: "name_mismatch" });
    await expect(ask(null, org)).rejects.toThrow(/permission denied/);

    const operators = await organizationOf(operator, "The Operator's Own");
    expect(await ask(operator, operators.org, "The Operator's Own")).toEqual({
      closing_id: null,
      refused: "not_closable",
    });
    const tests = await organizationOf(tester, "Test Pizza");
    expect(await ask(tester, tests.org, "Test Pizza")).toEqual({
      closing_id: null,
      refused: "not_closable",
    });
    expect(await rows("select id from public.closings")).toEqual([]);
    expect(await rows("select id from public.organizations where closing_at is not null")).toEqual(
      [],
    );
  });

  it("keeps its record out of every API role's reach", async () => {
    const { org } = await organizationOf(owner);
    await ask(owner, org);
    for (const [role, user] of [
      ["authenticated", owner],
      ["authenticated", operator],
      ["anon", null],
    ] as const) {
      await expect(as(role, user, () => rows("select * from public.closings"))).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        as(role, user, () => rows("update public.closings set finished_at = now()")),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(role, user, () => rows("select public.claim_closing(id) from public.closings")),
      ).rejects.toThrow(/permission denied/);
    }
    expect(
      await as("service_role", null, () => rows("select id from public.closings")),
    ).toHaveLength(1);
  });

  it("puts an organization being closed out of its members' reach and the worker's schedule", async () => {
    const { org, location } = await organizationOf(owner);
    const { id: task } = await one<{ id: string }>(
      "insert into public.recommendations (location_id, rule, title, detail) values ($1, 'site_hours', 'Add your hours', 'Say when.') returning id",
      [location],
    );
    const { id: draft } = await one<{ id: string }>(
      "insert into public.drafts (location_id, recommendation_id) values ($1, $2) returning id",
      [location, task],
    );
    // Room for drafts, so that only the closing can stop one being written.
    await db.query(`update public.organizations set allowances = '{"drafts": 30}' where id = $1`, [
      org,
    ]);
    const due = () =>
      as("service_role", null, () =>
        rows<{ id: string }>("select public.locations_due_for_scan(10) as id"),
      );
    expect((await due()).map((row) => row.id)).toContain(location);

    await ask(owner, org);

    for (const user of [owner, admin, member]) {
      expect(
        await as("authenticated", user, () => rows("select id from public.organizations")),
      ).toEqual([]);
      expect(
        await as("authenticated", user, () => rows("select id from public.locations")),
      ).toEqual([]);
    }
    await expect(
      as("authenticated", owner, () =>
        rows(
          "insert into public.locations (organization_id, name, city) values ($1, 'Another', 'Cary')",
          [org],
        ),
      ),
    ).rejects.toThrow();
    expect((await due()).map((row) => row.id)).not.toContain(location);
    // No checkout or change of assistants for it either.
    expect(
      await as("authenticated", owner, () => rows("select * from public.billing_state($1)", [org])),
    ).toEqual([]);
    expect(
      await as("authenticated", owner, () =>
        rows("select id from public.choose_assistants($1, array['claude']::public.surface[])", [
          org,
        ]),
      ),
    ).toEqual([]);
    expect(
      await as("service_role", null, () =>
        one("select public.organization_held($1) as held", [org]),
      ),
    ).toEqual({ held: true });
    expect(
      await as("service_role", null, () => one("select public.claim_draft($1) as try", [draft])),
    ).toEqual({ try: 0 });
  });

  it("lets the worker delete the organization and then the owner's sign-in", async () => {
    const { org } = await organizationOf(owner);
    await ask(owner, org);
    await as("service_role", null, () =>
      rows("delete from public.organizations where id = $1", [org]),
    );
    await db.query("delete from auth.users where id = $1", [owner]);
    expect(await rows("select id from auth.users where id = $1", [owner])).toEqual([]);
    expect(
      await rows("select user_id from public.memberships where organization_id = $1", [org]),
    ).toEqual([]);
    // The record outlives them both.
    expect(
      await rows("select id from public.closings where organization_id = $1", [org]),
    ).toHaveLength(1);
  });

  it("no longer keeps a sign-in from being deleted while an organization it made is there", async () => {
    const { org } = await organizationOf(other, "Other Pizza");
    await db.query("delete from auth.users where id = $1", [other]);
    expect(await one("select created_by from public.organizations where id = $1", [org])).toEqual({
      created_by: null,
    });
  });

  it("starts an organization from a closed account's address without its free first scan, for thirty days", async () => {
    const { org } = await organizationOf(stranger, "Stranger Pizza");
    await ask(stranger, org, "Stranger Pizza");
    await db.query("delete from public.organizations where id = $1", [org]);
    await db.query("update public.closings set finished_at = now()");
    await db.query("delete from auth.users where id = $1", [stranger]);
    // The same person signs up again, the address written another way.
    await db.query("insert into auth.users (id, email) values ($1, ' STRANGER@example.com ')", [
      again,
    ]);
    const firstScan = async () => {
      const { id } = await as("authenticated", again, () =>
        one<{ id: string }>("select id from public.create_organization('Again Pizza')"),
      );
      const { first } = await one<{ first: string | null }>(
        "select first_scan_at as first from public.organizations where id = $1",
        [id],
      );
      await db.query("delete from public.organizations where id = $1", [id]);
      return first;
    };
    expect(await firstScan()).not.toBeNull();

    await db.query("update public.closings set finished_at = now() - interval '31 days'");
    expect(await firstScan()).toBeNull();
  });
});
