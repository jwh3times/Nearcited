import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { maskAddress } from "@nearcited/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Receiving copied receipts as customer contacts (issue #291): what the worker keeps of a
 * receipt, a sender held until an owner or admin confirms it, what is dropped and counted, and
 * that no API role reads a customer's full address (ADR 0031). Every migration runs first.
 */

const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
const shim = readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8");

const owner = "a0000000-0000-4000-8000-000000000001";
const stranger = "b0000000-0000-4000-8000-000000000002";
const member = "c0000000-0000-4000-8000-000000000003";
const admin = "d0000000-0000-4000-8000-000000000004";
const operator = "e0000000-0000-4000-8000-000000000005";

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

/** An organization of `by`'s on a plan, with review requests given to it by hand. */
async function organizationOf(name: string, by: string) {
  const [made] = await rows<{ id: string }>(
    "insert into public.organizations (name, created_by) values ($1, $2) returning id",
    [name, by],
  );
  const org = made?.id ?? "";
  await db.query(
    "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'owner')",
    [org, by],
  );
  await db.query("select public.apply_plan($1, 'pro', 6)", [org]);
  await db.query(
    `update public.organizations set allowances = allowances || '{"review_requests": 100}'
     where id = $1`,
    [org],
  );
  return org;
}

/** A location of `org`'s with review requests on, as `by` turned them on. Their connection's ID. */
async function askingLocation(org: string, by: string) {
  const [made] = await rows<{ id: string }>(
    `insert into public.locations (organization_id, name, city, time_zone, primary_category)
     values ($1, 'Joe''s Pizza', 'Raleigh', 'America/New_York', 'Pizza restaurant') returning id`,
    [org],
  );
  const location = made?.id ?? "";
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

const receive = (connection: string, sender: string, customer: string, day = "2026-11-03") =>
  as("service_role", null, async () => {
    const [kept] = await rows<{ outcome: string }>(
      "select public.receive_receipt($1, $2, $3, $4) as outcome",
      [connection, sender, customer, day],
    );
    return kept?.outcome;
  });

const dropped = (location: string) =>
  rows<{ reason: string; count: number }>(
    "select reason, count from public.receipt_drops where location_id = $1 order by reason",
    [location],
  );

const senderOf = async (location: string, address: string) =>
  (
    await rows<{ id: string; status: string }>(
      "select id, status from public.receipt_senders where location_id = $1 and address = $2",
      [location, address],
    )
  )[0];

describe("customer contacts", () => {
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
        ($4, 'admin@example.com'), ($5, 'operator@example.com')`,
      [owner, stranger, member, admin, operator],
    );
    await db.query("insert into public.platform_roles (user_id, role) values ($1, 'operator')", [
      operator,
    ]);
    org = await organizationOf("Raleigh Pizza Group", owner);
    await db.query(
      "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'admin')",
      [org, member, admin],
    );
    joes = await askingLocation(org, owner);
  });
  afterAll(async () => {
    await db.close();
  });

  it("are received only by the worker", async () => {
    for (const [role, user] of [
      ["authenticated", owner],
      ["authenticated", operator],
      ["anon", null],
    ] as const) {
      await expect(
        as(role, user, () =>
          db.query(
            "select public.receive_receipt($1, 'a@square.com', 'jane@example.org', '2026-11-03')",
            [joes.connection],
          ),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(role, user, () =>
          db.query("select public.record_receipt_drop($1, 'no_customer')", [joes.location]),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(role, user, () => db.query("select public.drop_expired_held_contacts()")),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("are held from a new sender until an owner or admin confirms it, and then ready", async () => {
    expect(await receive(joes.connection, "receipts@square.com", "jane@example.org")).toBe("held");
    expect(await receive(joes.connection, "receipts@square.com", "john@example.org")).toBe("held");
    // The same customer for the same day is one contact.
    expect(await receive(joes.connection, "receipts@square.com", "jane@example.org")).toBe("held");
    const sender = await senderOf(joes.location, "receipts@square.com");
    expect(sender?.status).toBe("waiting");
    expect(
      await rows("select untold from public.receipt_senders where id = $1", [sender?.id]),
    ).toEqual([{ untold: true }]);

    // Nobody but an owner or admin confirms it, the operator included.
    const confirm = "select status from public.confirm_receipt_sender($1)";
    for (const user of [member, stranger, operator]) {
      expect(await as("authenticated", user, () => rows(confirm, [sender?.id])), user).toEqual([]);
    }
    expect(await as("authenticated", admin, () => rows(confirm, [sender?.id]))).toEqual([
      { status: "confirmed" },
    ]);
    // Once.
    expect(await as("authenticated", owner, () => rows(confirm, [sender?.id]))).toEqual([]);
    expect(
      await rows(
        "select masked, job_day::text, status from public.customer_contacts where location_id = $1 order by masked",
        [joes.location],
      ),
    ).toEqual([
      { masked: "j•••@example.org", job_day: "2026-11-03", status: "ready" },
      { masked: "j•••@example.org", job_day: "2026-11-03", status: "ready" },
    ]);
    expect(
      await rows("select decided_by_email, untold from public.receipt_senders where id = $1", [
        sender?.id,
      ]),
    ).toEqual([{ decided_by_email: "admin@example.com", untold: false }]);

    // A confirmed sender's next receipt is ready at once.
    expect(await receive(joes.connection, "receipts@square.com", "ann@example.org")).toBe("ready");
  });

  it("from a declined sender are deleted, and what it sends later is dropped and counted", async () => {
    expect(await receive(joes.connection, "billing@spammy.example", "pat@example.org")).toBe(
      "held",
    );
    const sender = await senderOf(joes.location, "billing@spammy.example");
    const decline = "select status from public.decline_receipt_sender($1)";
    for (const user of [member, stranger, operator]) {
      expect(await as("authenticated", user, () => rows(decline, [sender?.id])), user).toEqual([]);
    }
    expect(await as("authenticated", owner, () => rows(decline, [sender?.id]))).toEqual([
      { status: "declined" },
    ]);
    expect(
      await rows("select 1 from public.customer_contacts where sender_id = $1", [sender?.id]),
    ).toEqual([]);
    expect(await receive(joes.connection, "billing@spammy.example", "sam@example.org")).toBe(
      "declined_sender",
    );
    expect(await dropped(joes.location)).toEqual([{ reason: "declined_sender", count: 1 }]);
  });

  it("are deleted seven days after they were held with nobody confirming their sender", async () => {
    expect(await receive(joes.connection, "new@tool.example", "kim@example.org")).toBe("held");
    expect(await receive(joes.connection, "new@tool.example", "lee@example.org")).toBe("held");
    await db.query(
      "update public.customer_contacts set received_at = now() - interval '7 days 1 minute' where address = 'kim@example.org'",
    );
    // A ready one of the same age stays.
    await db.query(
      "update public.customer_contacts set received_at = now() - interval '8 days' where address = 'ann@example.org'",
    );
    expect(
      await as("service_role", null, () =>
        rows<{ n: number }>("select public.drop_expired_held_contacts() as n"),
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      await rows<{ address: string }>(
        "select address from public.customer_contacts where address in ('kim@example.org', 'lee@example.org', 'ann@example.org') order by address",
      ),
    ).toEqual([{ address: "ann@example.org" }, { address: "lee@example.org" }]);
  });

  it("are not received for review requests that are off, and that is counted", async () => {
    const other = await askingLocation(org, owner);
    await db.query("update public.connections set status = 'paused' where id = $1", [
      other.connection,
    ]);
    expect(await receive(other.connection, "receipts@square.com", "jo@example.org")).toBe("not_on");
    await db.query("update public.connections set status = 'removing' where id = $1", [
      other.connection,
    ]);
    await db.query("select public.finish_connection_removal($1)", [other.connection]);
    expect(await receive(other.connection, "receipts@square.com", "jo@example.org")).toBe("not_on");
    expect(await dropped(other.location)).toEqual([{ reason: "not_on", count: 2 }]);
    expect(
      await rows("select 1 from public.customer_contacts where location_id = $1", [other.location]),
    ).toEqual([]);
    expect(await receive(crypto.randomUUID(), "receipts@square.com", "jo@example.org")).toBe(
      "unknown",
    );
  });

  it("count each reason a receipt is dropped for its location", async () => {
    const counting = await askingLocation(org, owner);
    await as("service_role", null, async () => {
      for (const reason of ["no_customer", "no_customer", "several_customers", "unauthenticated"]) {
        await db.query("select public.record_receipt_drop($1, $2)", [counting.location, reason]);
      }
    });
    expect(await dropped(counting.location)).toEqual([
      { reason: "no_customer", count: 2 },
      { reason: "several_customers", count: 1 },
      { reason: "unauthenticated", count: 1 },
    ]);
  });

  it("are read masked by members and the operator, and in full by no API role", async () => {
    const read = "select masked from public.customer_contacts where address is not null";
    for (const user of [owner, admin, member, operator, stranger]) {
      await expect(
        as("authenticated", user, () => db.query(read)),
        user,
      ).rejects.toThrow(/permission denied/);
      await expect(
        as("authenticated", user, () => db.query("select * from public.customer_contacts")),
        user,
      ).rejects.toThrow(/permission denied/);
    }
    await expect(as("anon", null, () => db.query(read))).rejects.toThrow(/permission denied/);

    const columns =
      "select masked, job_day::text, status from public.customer_contacts where location_id = $1 order by received_at, masked";
    for (const user of [owner, admin, member, operator]) {
      const seen = await as("authenticated", user, () =>
        rows<{ masked: string }>(columns, [joes.location]),
      );
      expect(seen.length, user).toBeGreaterThan(0);
      for (const row of seen) expect(row.masked, user).toMatch(/^.•••@/);
    }
    expect(await as("authenticated", stranger, () => rows(columns, [joes.location]))).toEqual([]);
    expect(
      await as("authenticated", stranger, () => rows("select address from public.receipt_senders")),
    ).toEqual([]);
    expect(
      await as("authenticated", stranger, () => rows("select reason from public.receipt_drops")),
    ).toEqual([]);
    await expect(
      as("anon", null, () => db.query("select address from public.receipt_senders")),
    ).rejects.toThrow(/permission denied/);
  });

  it("are written by no API role directly", async () => {
    for (const user of [owner, operator]) {
      for (const sql of [
        "update public.customer_contacts set status = 'ready'",
        "delete from public.customer_contacts",
        "insert into public.customer_contacts (organization_id, location_id, sender_id, address, job_day, status) select organization_id, location_id, id, 'x@example.org', '2026-11-03', 'ready' from public.receipt_senders limit 1",
        "update public.receipt_senders set status = 'confirmed'",
        "delete from public.receipt_senders",
        "update public.receipt_drops set count = 0",
        "delete from public.receipt_drops",
      ]) {
        await expect(
          as("authenticated", user, () => db.query(sql)),
          `${user}: ${sql}`,
        ).rejects.toThrow(/permission denied/);
      }
    }
  });

  it("are masked as the shared package masks an address", async () => {
    for (const address of ["jane.doe@gmail.com", "j@x.io", "z_z+tag@mail.example.co.uk"]) {
      const [kept] = await rows<{ masked: string }>(
        `insert into public.customer_contacts
           (organization_id, location_id, sender_id, address, job_day, status)
         select organization_id, location_id, id, $1, '2026-10-01', 'ready'
         from public.receipt_senders where location_id = $2 limit 1
         returning masked`,
        [address, joes.location],
      );
      expect(kept?.masked).toBe(maskAddress(address));
    }
  });

  it("are left out of the organization's export", async () => {
    const [exported] = await as("authenticated", owner, () =>
      rows<{ e: unknown }>("select public.export_organization($1) as e", [org]),
    );
    const text = JSON.stringify(exported?.e);
    expect(text).toContain("Joe's Pizza");
    expect(text).not.toContain("jane@example.org");
    expect(text).not.toContain("j•••@example.org");
    expect(text).not.toContain("customer_contacts");
  });

  it("go with their organization", async () => {
    const theirs = await organizationOf("Slice House", stranger);
    const slice = await askingLocation(theirs, stranger);
    expect(await receive(slice.connection, "receipts@square.com", "mo@example.org")).toBe("held");
    await db.query("delete from public.organizations where id = $1", [theirs]);
    expect(
      await rows("select 1 from public.customer_contacts where organization_id = $1", [theirs]),
    ).toEqual([]);
    expect(
      await rows("select 1 from public.receipt_senders where organization_id = $1", [theirs]),
    ).toEqual([]);
  });
});
