import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Review requests as actions (issue #292, part of #146): a customer contact becomes one proposal
 * that a member approves, sent at 10:00 in the location's time zone the morning after the job, and
 * never to an address the organization asked within twelve months or that opted out of it. Every
 * migration runs first.
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

/** An organization of `by`'s on a plan, with `allowed` review requests a month for each location. */
async function organizationOf(name: string, by: string, allowed: number | true = 100) {
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
     set allowances = allowances || jsonb_build_object('review_requests', $2::jsonb)
     where id = $1`,
    [org, JSON.stringify(allowed)],
  );
  return org;
}

/** A location of `org`'s with review requests on, as `by` turned them on. */
async function askingLocation(org: string, by: string, name = "Joe's Pizza") {
  const { id: location } = await one<{ id: string }>(
    `insert into public.locations (organization_id, name, city, time_zone, primary_category)
     values ($1, $2, 'Raleigh', $3, 'Pizza restaurant') returning id`,
    [org, name, ZONE],
  );
  await db.query(
    "insert into public.listings (location_id, site, url) values ($1, 'google.com', 'https://g.page/r/joes/review')",
    [location],
  );
  const connection = crypto.randomUUID();
  await as("authenticated", by, () =>
    db.query("select 1 from public.turn_on_review_requests($1, $2, 'google.com', $3, true)", [
      location,
      connection,
      "owner@joespizza.com",
    ]),
  );
  return { location, connection };
}

/** The day `days` from today in the location's time zone, as a date. */
const localDay = (days: number) =>
  one<{ day: string }>(
    `select to_char((now() at time zone $1)::date + $2::integer, 'YYYY-MM-DD') as day`,
    [ZONE, days],
  ).then((row) => row.day);

/** A ready contact of `connection`'s, for a job on `day`. Its ID. */
async function contactOf(connection: string, customer: string, day: string) {
  await as("service_role", null, async () => {
    await db.query("select public.receive_receipt($1, 'orders@square.example', $2, $3::date)", [
      connection,
      customer,
      day,
    ]);
  });
  await db.query("update public.receipt_senders set status = 'confirmed'");
  await db.query("update public.customer_contacts set status = 'ready'");
  const { id } = await one<{ id: string }>(
    `select c.id from public.customer_contacts c
     join public.review_request_settings s on s.location_id = c.location_id
     where c.address = $1 and c.job_day = $2::date and s.connection_id = $3`,
    [customer, day, connection],
  );
  return id;
}

/** What the worker's proposing makes of one contact, with the wording its location has, if any. */
const propose = (contact: string, fingerprint: string, wording: string | null = "The wording") =>
  as("service_role", null, () =>
    one<{ outcome: string }>(
      "select public.propose_review_request($1, $2, 'Ask j•••@example.org for a review', $3) as outcome",
      [contact, fingerprint, wording],
    ),
  ).then((row) => row.outcome);

interface ActionRow {
  id: string;
  kind: string;
  status: string;
  contact_id: string | null;
  proposed_text: string | null;
  not_before: string;
  lapses_at: string;
  due_at: string | null;
}

const actionOf = (contact: string) =>
  one<ActionRow>(
    `select id, kind, status, contact_id, proposed_text,
       to_char(not_before at time zone $2, 'YYYY-MM-DD HH24:MI') as not_before,
       to_char(lapses_at at time zone $2, 'YYYY-MM-DD HH24:MI') as lapses_at,
       to_char(due_at at time zone $2, 'YYYY-MM-DD HH24:MI') as due_at
     from public.actions where contact_id = $1`,
    [contact, ZONE],
  );

describe("review requests as actions", () => {
  let org: string;
  let joes: { location: string; connection: string };

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
    joes = await askingLocation(org, owner);
  });
  afterAll(async () => {
    await db.close();
  });

  it("makes a contact one proposal, sent at 10:00 the morning after the job and lapsing a week after it", async () => {
    const yesterday = await localDay(-1);
    const contact = await contactOf(joes.connection, "jane@example.org", yesterday);
    expect(await propose(contact, "f1")).toBe("proposed");

    const action = await actionOf(contact);
    expect(action).toMatchObject({
      kind: "review_request",
      status: "proposed",
      proposed_text: "The wording",
      not_before: `${await localDay(0)} 10:00`,
      lapses_at: `${await localDay(6)} 10:00`,
      due_at: null,
    });
    // One contact, one proposal.
    expect(await propose(contact, "f1")).toBe("already_proposed");
  });

  it("is due at 10:00 the morning after the job, or at the next 10:00 when approved later", async () => {
    const early = await contactOf(joes.connection, "early@example.org", await localDay(0));
    const late = await contactOf(joes.connection, "late@example.org", await localDay(-3));
    await propose(early, "f-early");
    await propose(late, "f-late");
    for (const contact of [early, late]) {
      const { id } = await actionOf(contact);
      await as("authenticated", member, () =>
        db.query("select 1 from public.approve_action($1)", [id]),
      );
    }

    // Approved before its morning: then.
    expect((await actionOf(early)).due_at).toBe(`${await localDay(1)} 10:00`);
    // Approved after its morning had passed: the next 10:00 on the location's clock.
    const { before_ten } = await one<{ before_ten: boolean }>(
      "select (now() at time zone $1)::time < time '10:00' as before_ten",
      [ZONE],
    );
    expect((await actionOf(late)).due_at).toBe(`${await localDay(before_ten ? 0 : 1)} 10:00`);
  });

  it("is not taken to be carried out before it is due", async () => {
    const contact = await contactOf(joes.connection, "waits@example.org", await localDay(0));
    await propose(contact, "f-waits");
    const { id } = await actionOf(contact);
    await as("authenticated", member, () =>
      db.query("select 1 from public.approve_action($1)", [id]),
    );
    const claim = () =>
      as("service_role", null, () =>
        one<{ attempt: number }>("select public.claim_action($1) as attempt", [id]),
      ).then((row) => row.attempt);

    expect(await claim()).toBe(0);
    expect(await actionOf(contact)).toMatchObject({ status: "approved" });
    const { attempts } = await one<{ attempts: number }>(
      "select attempts from public.actions where id = $1",
      [id],
    );
    expect(attempts).toBe(0);

    // Once its morning comes, it is.
    await db.query("update public.actions set due_at = now() - interval '1 minute' where id = $1", [
      id,
    ]);
    expect(await claim()).toBe(1);
  });

  it("asks nobody the organization asked within twelve months, from any of its locations", async () => {
    const shop = await askingLocation(org, owner, "Joe's Pizza North");
    const first = await contactOf(joes.connection, "twice@example.org", await localDay(0));
    await propose(first, "f-twice");
    const { id } = await actionOf(first);
    await as("service_role", null, () => db.query("select public.mark_asked($1, 'f-twice')", [id]));

    // The same customer at the organization's other shop, the next day.
    const again = await contactOf(shop.connection, "twice@example.org", await localDay(1));
    expect(await propose(again, "f-twice")).toBe("asked_before");
    expect(await rows("select 1 from public.customer_contacts where id = $1", [again])).toEqual([]);

    const record = () =>
      as("service_role", null, () =>
        one<{ asked_by: string | null; asked_recently: boolean; opted_out: boolean }>(
          "select * from public.asking_record($1, 'f-twice')",
          [org],
        ),
      );
    expect(await record()).toEqual({ asked_by: id, asked_recently: true, opted_out: false });

    // Thirteen months on, they may be asked again.
    await db.query(
      "update public.asked_addresses set asked_at = now() - interval '13 months' where fingerprint = 'f-twice'",
    );
    expect(await record()).toEqual({ asked_by: id, asked_recently: false, opted_out: false });
    const later = await contactOf(shop.connection, "twice@example.org", await localDay(0));
    expect(await propose(later, "f-twice")).toBe("proposed");
  });

  it("asks nobody who opted out of the organization, and another organization still may", async () => {
    await db.query(
      "insert into public.opted_out_addresses (organization_id, fingerprint) values ($1, 'f-no')",
      [org],
    );
    const here = await contactOf(joes.connection, "no@example.org", await localDay(0));
    expect(await propose(here, "f-no")).toBe("opted_out");
    expect(await rows("select 1 from public.customer_contacts where id = $1", [here])).toEqual([]);

    const otherOrg = await organizationOf("Durham Tacos", stranger);
    const tacos = await askingLocation(otherOrg, stranger, "Durham Tacos");
    const there = await contactOf(tacos.connection, "no@example.org", await localDay(0));
    expect(await propose(there, "f-no")).toBe("proposed");
  });

  it("asks nobody more once the month's allowance is spoken for, counting each one not asked", async () => {
    const small = await organizationOf("One Shop", stranger, 1);
    await db.query("update public.organizations set max_locations = 1 where id = $1", [small]);
    const shop = await askingLocation(small, stranger, "One Shop");
    const first = await contactOf(shop.connection, "first@example.org", await localDay(0));
    const second = await contactOf(shop.connection, "second@example.org", await localDay(0));

    // The first waits for a yes, which already speaks for the month's one.
    expect(await propose(first, "f-first")).toBe("proposed");
    expect(await propose(second, "f-second")).toBe("allowance_used");
    expect(await rows("select 1 from public.customer_contacts where id = $1", [second])).toEqual(
      [],
    );
    expect(
      await rows("select reason, count from public.receipt_drops where location_id = $1", [
        shop.location,
      ]),
    ).toEqual([{ reason: "allowance_used", count: 1 }]);
  });

  it("waits with no wording to send, and deletes the contact once its week is over", async () => {
    const waits = await contactOf(joes.connection, "waits-wording@example.org", await localDay(0));
    expect(await propose(waits, "f-waits-wording", null)).toBe("no_wording");
    expect(
      await rows("select 1 from public.customer_contacts where id = $1", [waits]),
    ).toHaveLength(1);
    expect(await rows("select 1 from public.actions where contact_id = $1", [waits])).toEqual([]);

    const over = await contactOf(joes.connection, "over-wording@example.org", await localDay(-8));
    expect(await propose(over, "f-over-wording", null)).toBe("too_late");
    expect(await rows("select 1 from public.customer_contacts where id = $1", [over])).toEqual([]);
  });

  it("counts toward the month nothing that waited past its week", async () => {
    const small = await organizationOf("One Late Shop", stranger, 1);
    await db.query("update public.organizations set max_locations = 1 where id = $1", [small]);
    const shop = await askingLocation(small, stranger, "One Late Shop");
    const first = await contactOf(shop.connection, "lapsing@example.org", await localDay(0));
    expect(await propose(first, "f-lapsing")).toBe("proposed");
    // Its week is over, and the daily run has not lapsed it yet.
    await db.query(
      "update public.actions set lapses_at = now() - interval '1 minute' where contact_id = $1",
      [first],
    );
    const second = await contactOf(shop.connection, "after@example.org", await localDay(0));
    expect(await propose(second, "f-after")).toBe("proposed");
  });

  it("is not approved, and lapses unsent, once a week after the job has passed", async () => {
    const contact = await contactOf(joes.connection, "unanswered@example.org", await localDay(0));
    await propose(contact, "f-unanswered");
    const { id } = await actionOf(contact);
    await db.query(
      "update public.actions set lapses_at = now() - interval '1 minute' where id = $1",
      [id],
    );
    await expect(
      as("authenticated", member, () => db.query("select 1 from public.approve_action($1)", [id])),
    ).rejects.toThrow(/no longer waiting for a yes/);
    await as("service_role", null, () => db.query("select public.lapse_actions()"));
    expect(await actionOf(contact)).toMatchObject({ status: "lapsed", due_at: null });
  });

  it("proposes nothing where the plan does not include review requests, and keeps the contact", async () => {
    const off = await organizationOf("No Asking", stranger);
    const shop = await askingLocation(off, stranger, "No Asking");
    const contact = await contactOf(shop.connection, "kept@example.org", await localDay(0));
    await db.query(
      "update public.organizations set allowances = allowances - 'review_requests' where id = $1",
      [off],
    );
    expect(await propose(contact, "f-kept")).toBe("not_included");
    expect(
      await rows("select 1 from public.customer_contacts where id = $1", [contact]),
    ).toHaveLength(1);
  });

  /** Approves the contact's request as a member, makes it due and has the worker end it so. */
  async function carriedOut(contact: string, outcome: "done" | "failed") {
    const { id } = await actionOf(contact);
    await as("authenticated", member, () =>
      db.query("select 1 from public.approve_action($1)", [id]),
    );
    await db.query("update public.actions set due_at = now() - interval '1 minute' where id = $1", [
      id,
    ]);
    await as("service_role", null, async () => {
      await db.query("select public.claim_action($1)", [id]);
      await db.query("select public.finish_action($1, $2, 'The email provider refused it.')", [
        id,
        outcome,
      ]);
    });
    return id;
  }

  it("cannot be taken back once it was sent", async () => {
    const contact = await contactOf(joes.connection, "sent@example.org", await localDay(0));
    await propose(contact, "f-sent");
    const id = await carriedOut(contact, "done");
    await expect(
      as("authenticated", member, () =>
        db.query("select 1 from public.take_back_action($1)", [id]),
      ),
    ).rejects.toThrow(/cannot be taken back/);
  });

  it("asked for again after failing, goes at its own time, and not once its week is over", async () => {
    const contact = await contactOf(joes.connection, "retry@example.org", await localDay(0));
    await propose(contact, "f-retry");
    const failed = await carriedOut(contact, "failed");
    const [again] = await as("authenticated", member, () =>
      rows<{ id: string }>("select id from public.retry_action($1)", [failed]),
    );
    const retried = await one<ActionRow>(
      `select id, kind, status, contact_id,
         to_char(not_before at time zone $2, 'YYYY-MM-DD HH24:MI') as not_before,
         to_char(lapses_at at time zone $2, 'YYYY-MM-DD HH24:MI') as lapses_at,
         to_char(due_at at time zone $2, 'YYYY-MM-DD HH24:MI') as due_at
       from public.actions where id = $1`,
      [again?.id, ZONE],
    );
    expect(retried).toMatchObject({
      status: "approved",
      contact_id: contact,
      not_before: `${await localDay(1)} 10:00`,
      lapses_at: `${await localDay(7)} 10:00`,
      due_at: `${await localDay(1)} 10:00`,
    });

    // One that failed after its week is not asked for again.
    const old = await contactOf(joes.connection, "late-retry@example.org", await localDay(0));
    await propose(old, "f-late-retry");
    const oldFailed = await carriedOut(old, "failed");
    await db.query(
      "update public.actions set lapses_at = now() - interval '1 minute' where id = $1",
      [oldFailed],
    );
    await expect(
      as("authenticated", member, () =>
        db.query("select 1 from public.retry_action($1)", [oldFailed]),
      ),
    ).rejects.toThrow(/week after the job is over/);
  });

  it("put back to waiting when standing permission ends, keeps its own week", async () => {
    const contact = await contactOf(joes.connection, "permitted@example.org", await localDay(0));
    await propose(contact, "f-permitted");
    const { id } = await actionOf(contact);
    // As standing permission would have approved it.
    const { permission } = await one<{ permission: string }>(
      `insert into public.standing_permissions (organization_id, kind, given_by)
       values ($1, 'review_request', $2) returning id as permission`,
      [org, owner],
    );
    await db.query(
      "update public.actions set status = 'approved', approved_at = now(), approved_under = $2 where id = $1",
      [id, permission],
    );
    await as("service_role", null, () => db.query("select public.return_to_waiting($1)", [id]));
    expect(await actionOf(contact)).toMatchObject({
      status: "proposed",
      lapses_at: `${await localDay(7)} 10:00`,
      due_at: null,
    });
    await db.query(
      "update public.standing_permissions set ended_at = now(), end_reason = 'switched_off' where id = $1",
      [permission],
    );
  });

  it("keeps the fingerprints from every API role, the operator included", async () => {
    for (const [role, user] of [
      ["authenticated", owner],
      ["authenticated", member],
      ["authenticated", operator],
      ["authenticated", stranger],
      ["anon", null],
    ] as const) {
      for (const table of ["asked_addresses", "opted_out_addresses"]) {
        await expect(
          as(role, user, () => db.query(`select * from public.${table}`)),
          `${role} ${user} ${table}`,
        ).rejects.toThrow(/permission denied/);
      }
      await expect(
        as(role, user, () => db.query("select public.mark_asked(gen_random_uuid(), 'f')")),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(role, user, () =>
          db.query("select * from public.asking_record(gen_random_uuid(), 'f')"),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(role, user, () => db.query("select * from public.contacts_to_ask()")),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(role, user, () =>
          db.query("select public.propose_review_request(gen_random_uuid(), 'f', 'a', 'b')"),
        ),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("asks nobody once the week after the job is over, and keeps nothing of them", async () => {
    const contact = await contactOf(joes.connection, "old@example.org", await localDay(-8));
    expect(await propose(contact, "f-old")).toBe("too_late");
    expect(await rows("select 1 from public.customer_contacts where id = $1", [contact])).toEqual(
      [],
    );
    expect(
      await rows("select 1 from public.actions where subject = $1", [`contact:${contact}`]),
    ).toEqual([]);
  });
});
