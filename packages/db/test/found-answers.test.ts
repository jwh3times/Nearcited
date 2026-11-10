import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { FOUND_ASSISTANTS } from "@nearcited/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Found answers (issue #148,
 * `docs/adr/0033-a-found-answer-is-counted-on-the-way-to-the-review-form.md`): what a customer
 * tapped for "How did you find us?" on the way from a review request to the review form. Only the
 * worker counts one, the first for each request; a member reads their location's by month, the
 * operator reads every one and the deployment's opens and go-ons, and no API role writes any of it.
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

/** A location of `org`'s with review requests on. Its id and its connection's. */
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
  return { location, connection };
}

/** A review request proposed for a new customer of `connection`'s. Its action's id. */
async function requestTo(connection: string, customer: string) {
  await as("service_role", null, () =>
    db.query(
      "select public.receive_receipt($1, 'orders@square.example', $2, (now() at time zone $3)::date)",
      [connection, customer, ZONE],
    ),
  );
  await db.query("update public.receipt_senders set status = 'confirmed'");
  await db.query("update public.customer_contacts set status = 'ready'");
  const { id: contact } = await one<{ id: string }>(
    `select c.id from public.customer_contacts c
     join public.review_request_settings s on s.location_id = c.location_id
     where c.address = $1 and s.connection_id = $2`,
    [customer, connection],
  );
  await as("service_role", null, () =>
    db.query(
      "select public.propose_review_request($1, $2, 'Ask a customer for a review', 'The wording')",
      [contact, `fingerprint-of-${customer}`],
    ),
  );
  return (
    await one<{ id: string }>("select id from public.actions where contact_id = $1", [contact])
  ).id;
}

const answer = (action: string, given: string, assistant: string | null, sample = false) =>
  as("service_role", null, () =>
    one<{ outcome: string }>("select public.record_found_answer($1, $2, $3, $4) as outcome", [
      action,
      given,
      assistant,
      sample,
    ]),
  ).then((row) => row.outcome);

const opened = () =>
  as("service_role", null, () => db.query("select public.record_found_opened()"));

type Found = { month: string; answer: string; assistant: string | null; count: number };

const readAs = (userId: string, location: string, sample = false) =>
  as("authenticated", userId, () =>
    rows<Found>(
      "select month, answer, assistant, count from public.location_found_answers($1, $2) order by answer, assistant",
      [location, sample],
    ),
  );

/** This month as the location's page counts it. */
const thisMonth = async () =>
  (
    await one<{ month: string }>("select to_char(now() at time zone $1, 'YYYY-MM') as month", [
      ZONE,
    ])
  ).month;

describe("found answers", () => {
  let org: string;
  let north: { location: string; connection: string };
  let other: { location: string; connection: string };

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
    other = await askingLocation(
      await organizationOf("Durham Tacos", stranger),
      stranger,
      "Durham Tacos",
    );
  });
  afterAll(async () => {
    await db.close();
  });

  it("counts the first answer for a request and no later one, for the location by month", async () => {
    const jane = await requestTo(north.connection, "jane@example.org");
    const ann = await requestTo(north.connection, "ann@example.org");
    expect(await answer(jane, "assistant", "chatgpt")).toBe("counted");
    expect(await answer(jane, "search", null)).toBe("already");
    expect(await answer(ann, "assistant", "chatgpt")).toBe("counted");

    expect(await readAs(member, north.location)).toEqual([
      { month: await thisMonth(), answer: "assistant", assistant: "chatgpt", count: 2 },
    ]);
  });

  it("knows every assistant a customer may name, as the shared list has them", async () => {
    for (const assistant of FOUND_ASSISTANTS) {
      const action = await requestTo(other.connection, `${assistant}@example.org`);
      expect(await answer(action, "assistant", assistant), assistant).toBe("counted");
    }
  });

  it("counts nothing for a request that is not there", async () => {
    expect(await answer(crypto.randomUUID(), "search", null)).toBe("gone");
  });

  it("keeps made-up answers apart from real ones", async () => {
    const sam = await requestTo(north.connection, "sam@example.org");
    expect(await answer(sam, "been_before", null, true)).toBe("counted");
    expect(await readAs(owner, north.location, true)).toEqual([
      { month: await thisMonth(), answer: "been_before", assistant: null, count: 1 },
    ]);
    expect((await readAs(owner, north.location)).map((found) => found.answer)).not.toContain(
      "been_before",
    );
  });

  it("counts the deployment's opens and go-ons, and no made-up answer among them", async () => {
    const before = await as("authenticated", operator, () =>
      rows<{ opened: number; went_on: number }>(
        "select opened, went_on from public.found_question_counts",
      ),
    );
    await opened();
    await opened();
    const lee = await requestTo(north.connection, "lee@example.org");
    await answer(lee, "skipped", null);
    await answer(lee, "search", null);
    await answer(await requestTo(north.connection, "kim@example.org"), "search", null, true);

    const after = await as("authenticated", operator, () =>
      one<{ month: string; opened: number; went_on: number }>(
        "select to_char(month, 'YYYY-MM') as month, opened, went_on from public.found_question_counts",
      ),
    );
    expect(after.month).toBe(
      (await one<{ m: string }>("select to_char(now() at time zone 'UTC', 'YYYY-MM') as m")).m,
    );
    expect(after.opened - (before[0]?.opened ?? 0)).toBe(2);
    expect(after.went_on - (before[0]?.went_on ?? 0)).toBe(2);
  });

  it("refuses an answer that names an assistant it is not, or an assistant for another answer", async () => {
    const pat = await requestTo(north.connection, "pat@example.org");
    await expect(answer(pat, "search", "chatgpt")).rejects.toThrow();
    await expect(answer(pat, "assistant", "askjeeves")).rejects.toThrow();
    await expect(answer(pat, "liked_the_sign", null)).rejects.toThrow();
  });

  it("is read by the location's members and the operator, and by nobody else", async () => {
    expect(await readAs(stranger, north.location)).toEqual([]);
    expect(await readAs(operator, north.location)).not.toEqual([]);
    expect(
      await as("authenticated", stranger, () =>
        rows("select 1 from public.found_answers where location_id = $1", [north.location]),
      ),
    ).toEqual([]);
    await expect(
      as("anon", null, () => db.query("select 1 from public.found_answers")),
    ).rejects.toThrow(/permission denied/);
  });

  it("lets no API role write a count, or read which requests were answered", async () => {
    for (const userId of [owner, operator]) {
      await expect(
        as("authenticated", userId, () =>
          db.query(
            "insert into public.found_answers (location_id, month, answer, count) values ($1, date_trunc('month', now())::date, 'search', 9)",
            [north.location],
          ),
        ),
      ).rejects.toThrow();
      await expect(
        as("authenticated", userId, () => db.query("select 1 from public.found_answered")),
      ).rejects.toThrow();
      await expect(
        as("authenticated", userId, () =>
          db.query("update public.found_question_counts set opened = 0"),
        ),
      ).rejects.toThrow();
      await expect(
        as("authenticated", userId, () =>
          db.query("select public.record_found_answer($1, 'search', null, false)", [
            crypto.randomUUID(),
          ]),
        ),
      ).rejects.toThrow();
      await expect(
        as("authenticated", userId, () => db.query("select public.record_found_opened()")),
      ).rejects.toThrow();
    }
    await expect(
      as("anon", null, () => db.query("select public.record_found_opened()")),
    ).rejects.toThrow();
  });

  it("shows the deployment's counts to the operator alone", async () => {
    for (const userId of [owner, member, stranger]) {
      expect(
        await as("authenticated", userId, () => rows("select 1 from public.found_question_counts")),
      ).toEqual([]);
    }
  });

  it("is in the organization's export, and goes with it", async () => {
    const { export: exported } = await as("authenticated", owner, () =>
      one<{ export: { found_answers: Found[] } }>(
        "select public.export_organization($1) as export",
        [org],
      ),
    );
    expect(exported.found_answers.length).toBeGreaterThan(0);
    expect(exported.found_answers[0]).toMatchObject({ location_id: north.location });

    const tacos = await requestTo(other.connection, "jo@example.org");
    await answer(tacos, "search", null);
    await db.query(
      "delete from public.organizations where id = (select organization_id from public.locations where id = $1)",
      [other.location],
    );
    expect(
      await rows("select 1 from public.found_answers where location_id = $1", [other.location]),
    ).toEqual([]);
    expect(await rows("select 1 from public.found_answered where action_id = $1", [tacos])).toEqual(
      [],
    );
  });
});
