import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Deleting customer contacts once they are no longer needed (issue #294, part of #146): thirty
 * days after a request was sent, once the week of one that ended unsent is over, and at once when
 * review requests are turned off or the plan stops including them. Whom an organization asked,
 * and who opted out, stay as fingerprints, so turning review requests on again asks nobody twice.
 * Every migration runs first.
 */

const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
const shim = readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8");

const owner = "a0000000-0000-4000-8000-000000000001";
const member = "c0000000-0000-4000-8000-000000000003";

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

/** An organization of `owner`'s, with a member, on a plan that includes review requests. */
async function organizationOf(name: string) {
  const { id: org } = await one<{ id: string }>(
    "insert into public.organizations (name, created_by) values ($1, $2) returning id",
    [name, owner],
  );
  await db.query(
    `insert into public.memberships (organization_id, user_id, role)
     values ($1, $2, 'owner'), ($1, $3, 'member')`,
    [org, owner, member],
  );
  await includeReviewRequests(org);
  return org;
}

/** Puts `org` on a plan that includes review requests. */
async function includeReviewRequests(org: string) {
  await db.query("select public.apply_plan($1, 'pro', 6)", [org]);
  await db.query(
    `update public.organizations
     set allowances = allowances || '{"review_requests": 100}'::jsonb where id = $1`,
    [org],
  );
  await db.query("select public.fit_connections_to_plan($1)", [org]);
}

/** A location of `org`'s. */
async function locationOf(org: string, name: string) {
  const { id } = await one<{ id: string }>(
    `insert into public.locations (organization_id, name, city, time_zone, primary_category)
     values ($1, $2, 'Raleigh', $3, 'Pizza restaurant') returning id`,
    [org, name, ZONE],
  );
  await db.query(
    "insert into public.listings (location_id, site, url) values ($1, 'google.com', 'https://g.page/r/joes/review')",
    [id],
  );
  return id;
}

/** Turns review requests on for `location`, as its owner. The connection's ID. */
async function turnOn(location: string) {
  const connection = crypto.randomUUID();
  await as("authenticated", owner, () =>
    db.query("select 1 from public.turn_on_review_requests($1, $2, 'google.com', $3, true)", [
      location,
      connection,
      "owner@joespizza.com",
    ]),
  );
  return connection;
}

/** The day `days` from today in the location's time zone, as a date. */
const localDay = (days: number) =>
  one<{ day: string }>(
    `select to_char((now() at time zone $1)::date + $2::integer, 'YYYY-MM-DD') as day`,
    [ZONE, days],
  ).then((row) => row.day);

/** What the worker makes of a receipt to `connection` naming `customer`, for a job today. */
const receive = (connection: string, customer: string) =>
  as("service_role", null, async () =>
    one<{ outcome: string }>(
      "select public.receive_receipt($1, 'orders@square.example', $2, $3::date) as outcome",
      [connection, customer, await localDay(0)],
    ),
  ).then((row) => row.outcome);

/** A ready contact of `connection`'s for a job today. Its ID. */
async function contactOf(connection: string, customer: string) {
  await receive(connection, customer);
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

/** What the worker's proposing makes of one contact, whose address has `fingerprint`. */
const propose = (contact: string, fingerprint: string) =>
  as("service_role", null, () =>
    one<{ outcome: string }>(
      "select public.propose_review_request($1, $2, 'Ask a customer for a review', 'The wording') as outcome",
      [contact, fingerprint],
    ),
  ).then((row) => row.outcome);

/** The review request proposed for `contact`. Its ID. */
const requestOf = (contact: string) =>
  one<{ id: string }>("select id from public.actions where contact_id = $1", [contact]).then(
    (row) => row.id,
  );

/** Approves `contact`'s request, as a member, and makes it due now. Its ID. */
async function approved(contact: string) {
  const id = await requestOf(contact);
  await as("authenticated", member, () =>
    db.query("select 1 from public.approve_action($1)", [id]),
  );
  await db.query("update public.actions set due_at = now() - interval '1 minute' where id = $1", [
    id,
  ]);
  return id;
}

/** Carries out `contact`'s request as the worker would, ending `outcome`. Its ID. */
async function carriedOut(contact: string, fingerprint: string, outcome: "done" | "failed") {
  const id = await approved(contact);
  await as("service_role", null, async () => {
    await db.query("select public.claim_action($1)", [id]);
    if (outcome === "done") await db.query("select public.mark_asked($1, $2)", [id, fingerprint]);
    await db.query("select public.finish_action($1, $2, 'The email provider refused it.')", [
      id,
      outcome,
    ]);
  });
  return id;
}

/** What the worker's daily deleting of spent contacts deletes. How many. */
const dropSpent = () =>
  as("service_role", null, () =>
    one<{ dropped: number }>("select public.drop_spent_contacts() as dropped"),
  ).then((row) => row.dropped);

const kept = async (contact: string) =>
  (await rows("select 1 from public.customer_contacts where id = $1", [contact])).length > 0;

describe("deleting customer contacts once they are no longer needed", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(shim);
    for (const file of readdirSync(migrationsDir).sort()) {
      await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }
    await db.query(
      `insert into auth.users (id, email) values
        ($1, 'owner@example.com'), ($2, 'member@example.com')`,
      [owner, member],
    );
  });
  afterAll(async () => {
    await db.close();
  });

  it("deletes a contact thirty days after its request was sent, and asks the address no second time", async () => {
    const org = await organizationOf("Raleigh Pizza Group");
    const joes = await turnOn(await locationOf(org, "Joe's Pizza"));
    const sent = await contactOf(joes, "jane@example.org");
    const recent = await contactOf(joes, "recent@example.org");
    await propose(sent, "f-jane");
    await propose(recent, "f-recent");
    const id = await carriedOut(sent, "f-jane", "done");
    await carriedOut(recent, "f-recent", "done");

    // Sent 29 days ago: kept. Sent 30 days ago: gone.
    await db.query("update public.actions set done_at = now() - interval '29 days' where id = $1", [
      id,
    ]);
    expect(await dropSpent()).toBe(0);
    expect(await kept(sent)).toBe(true);
    await db.query("update public.actions set done_at = now() - interval '30 days' where id = $1", [
      id,
    ]);
    expect(await dropSpent()).toBe(1);
    expect(await kept(sent)).toBe(false);
    expect(await kept(recent)).toBe(true);
    // The request stays on record, with nothing of the customer's.
    expect(await one("select status, contact_id from public.actions where id = $1", [id])).toEqual({
      status: "done",
      contact_id: null,
    });

    // The same customer's next receipt asks nobody.
    const again = await contactOf(joes, "jane@example.org");
    expect(await propose(again, "f-jane")).toBe("asked_before");
  });

  it("deletes a contact whose request ended unsent once the week after the job is over, and not while it could be asked for again", async () => {
    const org = await organizationOf("Durham Pizza Group");
    const joes = await turnOn(await locationOf(org, "Joe's Pizza Durham"));
    const declined = await contactOf(joes, "declined@example.org");
    const failed = await contactOf(joes, "failed@example.org");
    const waiting = await contactOf(joes, "waiting@example.org");
    for (const [contact, fingerprint] of [
      [declined, "f-declined"],
      [failed, "f-failed"],
      [waiting, "f-waiting"],
    ] as const) {
      await propose(contact, fingerprint);
    }
    const no = await requestOf(declined);
    await as("authenticated", member, () =>
      db.query("select 1 from public.decline_action($1, null)", [no]),
    );
    await carriedOut(failed, "f-failed", "failed");

    // Within its week a failed request can be asked for again, so all three are kept.
    expect(await dropSpent()).toBe(0);

    // Once the week is over, the declined, the failed and the lapsed are each gone.
    await db.query(
      "update public.actions set lapses_at = now() - interval '1 minute' where contact_id = any($1)",
      [[declined, failed, waiting]],
    );
    await as("service_role", null, () => db.query("select public.lapse_actions()"));
    expect(await dropSpent()).toBe(3);
    for (const contact of [declined, failed, waiting]) expect(await kept(contact)).toBe(false);
  });

  it("turned off, lapses the location's waiting requests and deletes every contact of it at once, and asks nobody twice when turned on again", async () => {
    const org = await organizationOf("Cary Pizza Group");
    const location = await locationOf(org, "Joe's Pizza Cary");
    const joes = await turnOn(location);
    const other = await turnOn(await locationOf(org, "Joe's Pizza Apex"));
    const sent = await contactOf(joes, "sent@example.org");
    const proposed = await contactOf(joes, "proposed@example.org");
    const due = await contactOf(joes, "due@example.org");
    const notYet = await contactOf(joes, "not-yet@example.org");
    const elsewhere = await contactOf(other, "elsewhere@example.org");
    await propose(sent, "f-sent");
    await propose(proposed, "f-proposed");
    await propose(due, "f-due");
    await propose(elsewhere, "f-elsewhere");
    const sentId = await carriedOut(sent, "f-sent", "done");
    const proposedId = await requestOf(proposed);
    const dueId = await approved(due);
    const elsewhereId = await requestOf(elsewhere);

    await as("authenticated", owner, () =>
      db.query("select 1 from public.request_connection_removal($1)", [joes]),
    );

    // Every contact of the location is gone at once, sent or not; the other location's stays.
    expect(
      await rows("select 1 from public.customer_contacts where location_id = $1", [location]),
    ).toEqual([]);
    expect(await kept(notYet)).toBe(false);
    expect(await kept(elsewhere)).toBe(true);
    // What was waiting, approved or not, lapses; what was sent stays sent.
    const statuses = await rows<{ id: string; status: string; lapse_reason: string | null }>(
      "select id, status, lapse_reason from public.actions where id = any($1) order by id",
      [[sentId, proposedId, dueId, elsewhereId]],
    );
    expect(Object.fromEntries(statuses.map((a) => [a.id, [a.status, a.lapse_reason]]))).toEqual({
      [sentId]: ["done", null],
      [proposedId]: ["lapsed", "turned_off"],
      [dueId]: ["lapsed", "turned_off"],
      [elsewhereId]: ["proposed", null],
    });
    // The receipt address stops receiving.
    expect(await receive(joes, "late@example.org")).toBe("not_on");

    // The worker finishes turning them off, and they are turned on again.
    await as("service_role", null, () =>
      db.query("select public.finish_connection_removal($1)", [joes]),
    );
    const again = await turnOn(location);
    expect(await propose(await contactOf(again, "sent@example.org"), "f-sent")).toBe(
      "asked_before",
    );
  });

  it("does the same at every location once the plan stops including review requests", async () => {
    const org = await organizationOf("Wake Pizza Group");
    const north = await turnOn(await locationOf(org, "Joe's Pizza North"));
    const south = await turnOn(await locationOf(org, "Joe's Pizza South"));
    const sent = await contactOf(north, "sent-north@example.org");
    const waiting = await contactOf(south, "waiting-south@example.org");
    await propose(sent, "f-sent-north");
    await propose(waiting, "f-waiting-south");
    await carriedOut(sent, "f-sent-north", "done");
    const waitingId = await requestOf(waiting);

    // A plan without review requests.
    await db.query("select public.apply_plan($1, 'pro', 6)", [org]);

    expect(
      await rows("select 1 from public.customer_contacts where organization_id = $1", [org]),
    ).toEqual([]);
    expect(
      await one("select status, lapse_reason from public.actions where id = $1", [waitingId]),
    ).toEqual({ status: "lapsed", lapse_reason: "turned_off" });
    expect(await receive(south, "late@example.org")).toBe("not_on");

    // Back on a plan that includes them, the address asked is still not asked again.
    await includeReviewRequests(org);
    expect(await propose(await contactOf(south, "sent-north@example.org"), "f-sent-north")).toBe(
      "asked_before",
    );
  });

  it("removes an organization's contacts with it when its account is closed", async () => {
    const org = await organizationOf("Closing Pizza Group");
    const joes = await turnOn(await locationOf(org, "Joe's Pizza Closing"));
    const contact = await contactOf(joes, "closing@example.org");
    await propose(contact, "f-closing");

    await as("service_role", null, () =>
      db.query("delete from public.organizations where id = $1", [org]),
    );
    expect(await kept(contact)).toBe(false);
  });
});
