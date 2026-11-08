import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Opting out of review requests, and stopping at a bounce or a complaint (issue #293, part of
 * #146). A customer's opt-out holds for every location of the organization they opted out of and
 * for no other; an address that bounced hard or complained is asked by no organization again.
 * Both are kept only as the keyed fingerprint of the address, and only the worker records them.
 * Every migration runs first.
 */

const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
const shim = readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8");

const owner = "a0000000-0000-4000-8000-000000000001";
const stranger = "b0000000-0000-4000-8000-000000000002";
const member = "c0000000-0000-4000-8000-000000000003";
const operator = "e0000000-0000-4000-8000-000000000005";

const ZONE = "America/New_York";

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
  if (row === undefined) throw new Error(`No row: ${sql}`);
  return row;
}

/** An organization of `by`'s on a plan that includes review requests. */
async function organizationOf(name: string, by: string) {
  const { id: org } = await one<{ id: string }>(
    "insert into public.organizations (name, created_by) values ($1, $2) returning id",
    [name, by],
  );
  await db.query(
    "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'owner')",
    [org, by],
  );
  await db.query("select public.apply_plan($1, 'pro', 6)", [org]);
  await db.query(
    `update public.organizations
     set allowances = allowances || '{"review_requests": 100}'::jsonb where id = $1`,
    [org],
  );
  return org;
}

/** A location of `org`'s with review requests on. */
async function askingLocation(org: string, by: string, name: string) {
  const { id: location } = await one<{ id: string }>(
    `insert into public.locations (organization_id, name, city, time_zone, primary_category)
     values ($1, $2, 'Raleigh', $3, 'Pizza restaurant') returning id`,
    [org, name, ZONE],
  );
  await db.query(
    "insert into public.listings (location_id, site, url) values ($1, 'google.com', 'https://g.page/r/x/review')",
    [location],
  );
  const connection = crypto.randomUUID();
  await as("authenticated", by, () =>
    db.query("select 1 from public.turn_on_review_requests($1, $2, 'google.com', $3, true)", [
      location,
      connection,
      "owner@example.com",
    ]),
  );
  return connection;
}

/** A ready contact of `connection`'s for a job today. Its ID. */
async function contactOf(connection: string, customer: string) {
  await as("service_role", null, () =>
    db.query(
      "select public.receive_receipt($1, 'orders@square.example', $2, (now() at time zone $3)::date)",
      [connection, customer, ZONE],
    ),
  );
  await db.query("update public.receipt_senders set status = 'confirmed'");
  await db.query("update public.customer_contacts set status = 'ready'");
  const { id } = await one<{ id: string }>(
    `select c.id from public.customer_contacts c
     join public.review_request_settings s on s.location_id = c.location_id
     where c.address = $1 and s.connection_id = $2 and c.status = 'ready'`,
    [customer, connection],
  );
  return id;
}

/** What the worker's proposing makes of one contact. */
const propose = (contact: string, fingerprint: string) =>
  as("service_role", null, () =>
    one<{ outcome: string }>(
      "select public.propose_review_request($1, $2, 'Ask a customer for a review', 'The wording') as outcome",
      [contact, fingerprint],
    ),
  ).then((row) => row.outcome);

const record = (org: string, fingerprint: string) =>
  as("service_role", null, () =>
    one<{ opted_out: boolean }>("select opted_out from public.asking_record($1, $2)", [
      org,
      fingerprint,
    ]),
  ).then((row) => row.opted_out);

const optOut = (org: string, fingerprint: string) =>
  as("service_role", null, () =>
    db.query("select public.opt_out_address($1, $2)", [org, fingerprint]),
  );

const stop = (fingerprint: string, reason: string) =>
  as("service_role", null, () =>
    db.query("select public.stop_address($1, $2)", [fingerprint, reason]),
  );

describe("opting out, and stopping at a bounce or a complaint", () => {
  let org: string;
  let north: string;
  let south: string;
  let other: string;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(shim);
    for (const file of readdirSync(migrationsDir).sort()) {
      await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }
    await db.query(
      `insert into auth.users (id, email) values
        ($1, 'owner@example.com'), ($2, 'stranger@example.com'), ($3, 'member@example.com'),
        ($4, 'operator@example.com')`,
      [owner, stranger, member, operator],
    );
    await db.query("insert into public.platform_roles (user_id, role) values ($1, 'operator')", [
      operator,
    ]);
    org = await organizationOf("Raleigh Pizza Group", owner);
    await db.query(
      "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'member')",
      [org, member],
    );
    north = await askingLocation(org, owner, "Joe's Pizza North");
    south = await askingLocation(org, owner, "Joe's Pizza South");
    other = await askingLocation(await organizationOf("Durham Tacos", stranger), stranger, "Tacos");
  });
  afterAll(async () => {
    await db.close();
  });

  it("stops proposals at every location of the organization opted out of, and at no other", async () => {
    await optOut(org, "f-out");
    // Opting out twice, from two emails, is the same as once.
    await optOut(org, "f-out");
    expect(await record(org, "f-out")).toBe(true);

    for (const shop of [north, south]) {
      const contact = await contactOf(shop, "out@example.org");
      expect(await propose(contact, "f-out")).toBe("opted_out");
      expect(await rows("select 1 from public.customer_contacts where id = $1", [contact])).toEqual(
        [],
      );
    }
    expect(await propose(await contactOf(other, "out@example.org"), "f-out")).toBe("proposed");
  });

  it("records nothing for an organization that is not there", async () => {
    await optOut(crypto.randomUUID(), "f-nobody");
    expect(
      await rows("select 1 from public.opted_out_addresses where fingerprint = 'f-nobody'"),
    ).toEqual([]);
  });

  it("stops proposals at every organization once an address bounced hard or complained", async () => {
    await stop("f-bounced", "bounce");
    await stop("f-complained", "complaint");
    await stop("f-bounced", "complaint");

    for (const [fingerprint, customer] of [
      ["f-bounced", "gone@example.org"],
      ["f-complained", "angry@example.org"],
    ] as const) {
      expect(await record(org, fingerprint)).toBe(true);
      for (const shop of [north, other]) {
        const contact = await contactOf(shop, customer);
        expect(await propose(contact, fingerprint)).toBe("stopped");
        expect(
          await rows("select 1 from public.customer_contacts where id = $1", [contact]),
        ).toEqual([]);
      }
    }
    await expect(stop("f-soft", "soft_bounce")).rejects.toThrow();
  });

  it("keeps the stopped addresses and both records from every API role, the operator included", async () => {
    for (const [role, user] of [
      ["authenticated", owner],
      ["authenticated", member],
      ["authenticated", operator],
      ["authenticated", stranger],
      ["anon", null],
    ] as const) {
      await expect(
        as(role, user, () => db.query("select * from public.stopped_addresses")),
        `${role} ${user}`,
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(role, user, () => db.query("select public.opt_out_address($1, 'f')", [org])),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(role, user, () => db.query("select public.stop_address('f', 'bounce')")),
      ).rejects.toThrow(/permission denied/);
    }
  });
});
