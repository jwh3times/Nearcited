import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { CONFIDENTIAL_KINDS, isConfidentialCategory } from "@nearcited/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Turning review requests on for a location (issue #290): the allowance no plan includes yet, who
 * turns them on and reads them, what is refused, and that a replaced receipt address is nobody's.
 * Every migration runs first.
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

/** An organization of `by`'s on a plan, with review requests given to it by hand when `given`. */
async function organizationOf(name: string, by: string, given = true) {
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
  if (given) {
    await db.query(
      `update public.organizations set allowances = allowances || '{"review_requests": 100}'
       where id = $1`,
      [org],
    );
  }
  return org;
}

/** A location of `org`'s with a time zone and a review link on Google, unless told otherwise. */
async function locationOf(
  org: string,
  { zone = "America/New_York", category = "Pizza restaurant", google = true } = {},
) {
  const [made] = await rows<{ id: string }>(
    `insert into public.locations (organization_id, name, city, time_zone, primary_category)
     values ($1, 'Joe''s Pizza', 'Raleigh', $2, $3) returning id`,
    [org, zone, category],
  );
  const id = made?.id ?? "";
  if (google) {
    await db.query(
      "insert into public.listings (location_id, site, url) values ($1, 'google.com', 'https://g.page/r/joes/review')",
      [id],
    );
  }
  return id;
}

const turnOn =
  "select id, kind, label, status, connected_by_email from public.turn_on_review_requests($1, $2, $3, $4, $5)";
const on = (location: string, site = "google.com", confirmed: boolean | null = true) => [
  location,
  crypto.randomUUID(),
  site,
  " Owner@Example.com ",
  confirmed,
];

describe("review requests", () => {
  let org: string;
  let joes: string;

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
    joes = await locationOf(org);
  });
  afterAll(async () => {
    await db.close();
  });

  it("are a counted allowance that no plan includes, and a kind of connection that needs it", async () => {
    expect(
      await rows("select counted from public.allowance_kinds where key = 'review_requests'"),
    ).toEqual([{ counted: true }]);
    expect(await rows("select key from public.plans where allowances ? 'review_requests'")).toEqual(
      [],
    );
    expect(
      await rows(
        "select allowance from public.connection_kind_allowances where kind = 'review_requests'",
      ),
    ).toEqual([{ allowance: "review_requests" }]);
  });

  it("are turned on only by an owner or admin, with no sign-in and a new receipt address", async () => {
    for (const user of [stranger, member, operator]) {
      expect(await as("authenticated", user, () => rows(turnOn, on(joes))), user).toEqual([]);
    }
    await expect(as("anon", null, () => db.query(turnOn, on(joes)))).rejects.toThrow(
      /permission denied/,
    );

    const args = on(joes);
    expect(await as("authenticated", admin, () => rows(turnOn, args))).toEqual([
      {
        id: args[1],
        kind: "review_requests",
        label: "Joe's Pizza",
        status: "working",
        connected_by_email: "admin@example.com",
      },
    ]);
    const [kept] = await rows<{ receipt_address: string; site: string; reply_to: string }>(
      "select receipt_address, site, reply_to from public.review_request_settings where connection_id = $1",
      [args[1]],
    );
    expect(kept?.receipt_address).toMatch(/^[0-9a-f]{32}$/);
    expect(kept).toMatchObject({ site: "google.com", reply_to: "owner@example.com" });
    expect(
      await rows("select location_id from public.connection_locations where connection_id = $1", [
        args[1],
      ]),
    ).toEqual([{ location_id: joes }]);
    expect(
      await rows("select 1 from public.connection_secrets where connection_id = $1", [args[1]]),
    ).toEqual([]);
    // Once for a location.
    await expect(as("authenticated", owner, () => db.query(turnOn, on(joes)))).rejects.toThrow(
      /on for this location already/,
    );
  });

  it("are refused without a time zone, for a confidential category, without the word, and for a site with no listing", async () => {
    const noZone = await locationOf(org, { zone: null as unknown as string });
    const clinic = await locationOf(org, { category: "Family dental clinic" });
    const plain = await locationOf(org);
    // Listings on BBB and Trustpilot whose addresses give no review form.
    const formless = await locationOf(org, { google: false });
    await db.query(
      `insert into public.listings (location_id, site, url) values
        ($1, 'bbb.org', 'https://www.bbb.org/ca/on/toronto/profile/joes'),
        ($1, 'trustpilot.com', 'https://www.trustpilot.com/categories/pizza')`,
      [formless],
    );
    for (const [args, why] of [
      [on(noZone), /time zone/],
      [on(clinic), /confidential/],
      [on(plain, "google.com", false), /Confirm that your customer list/],
      [on(plain, "google.com", null), /Confirm that your customer list/],
      [on(plain, "bbb.org"), /listing to be reviewed on/],
      [on(formless, "bbb.org"), /listing to be reviewed on/],
      [on(formless, "trustpilot.com"), /listing to be reviewed on/],
      [on(plain, "yelp.com"), /listing to be reviewed on/],
      [[plain, crypto.randomUUID(), "google.com", "not an address", true], /reply goes to/],
    ] as const) {
      await expect(as("authenticated", owner, () => db.query(turnOn, [...args]))).rejects.toThrow(
        why,
      );
    }
  });

  it("are refused where the organization's plan does not include them", async () => {
    const theirs = await organizationOf("Slice House", stranger, false);
    const slice = await locationOf(theirs);
    await expect(as("authenticated", stranger, () => db.query(turnOn, on(slice)))).rejects.toThrow(
      /does not include review requests/,
    );
    // Nor is one made as any other connection is.
    await db.query(
      `update public.organizations set allowances = allowances || '{"review_requests": 100}'
       where id = $1`,
      [theirs],
    );
    await expect(
      as("authenticated", stranger, () =>
        db.query("select public.create_connection($1, $2, 'review_requests', 'x', 'sealed')", [
          theirs,
          crypto.randomUUID(),
        ]),
      ),
    ).rejects.toThrow(/turn_on_review_requests/);
    await db.query("delete from public.organizations where id = $1", [theirs]);
  });

  it("are read by members and the operator, and by no stranger, and written by no one directly", async () => {
    const read = "select location_id, site from public.review_request_settings";
    for (const user of [owner, member, admin, operator]) {
      expect(await as("authenticated", user, () => rows(read)), user).toEqual([
        { location_id: joes, site: "google.com" },
      ]);
    }
    expect(await as("authenticated", stranger, () => rows(read))).toEqual([]);
    await expect(as("anon", null, () => db.query(read))).rejects.toThrow(/permission denied/);
    for (const user of [owner, operator]) {
      await expect(
        as("authenticated", user, () =>
          db.query("update public.review_request_settings set site = 'bbb.org'"),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as("authenticated", user, () => db.query("delete from public.review_request_settings")),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("give a new receipt address when an owner or admin replaces it, and the old one is nobody's", async () => {
    const address = async () =>
      (
        await rows<{ receipt_address: string }>(
          "select receipt_address from public.review_request_settings where location_id = $1 and released_at is null",
          [joes],
        )
      )[0]?.receipt_address;
    const before = await address();
    const replace = "select receipt_address from public.replace_receipt_address($1)";
    for (const user of [stranger, member, operator]) {
      expect(await as("authenticated", user, () => rows(replace, [joes])), user).toEqual([]);
    }
    expect(await address()).toBe(before);

    const [made] = await as("authenticated", owner, () =>
      rows<{ receipt_address: string }>(replace, [joes]),
    );
    expect(made?.receipt_address).toMatch(/^[0-9a-f]{32}$/);
    expect(made?.receipt_address).not.toBe(before);
    expect(await address()).toBe(made?.receipt_address);
    expect(
      await rows("select 1 from public.review_request_settings where receipt_address = $1", [
        before,
      ]),
    ).toEqual([]);
  });

  it("are turned off as a connection is removed, which lets the receipt address go", async () => {
    const [held] = await rows<{ connection_id: string }>(
      "select connection_id from public.review_request_settings where location_id = $1 and released_at is null",
      [joes],
    );
    const id = held?.connection_id ?? "";
    await as("authenticated", admin, () =>
      db.query("select public.request_connection_removal($1)", [id]),
    );
    // While it is being turned off, its address is not replaced.
    expect(
      await as("authenticated", owner, () =>
        rows("select 1 from public.replace_receipt_address($1)", [joes]),
      ),
    ).toEqual([]);
    await db.query("select public.finish_connection_removal($1)", [id]);
    expect(
      await rows<{ released: boolean }>(
        "select released_at is not null as released from public.review_request_settings where connection_id = $1",
        [id],
      ),
    ).toEqual([{ released: true }]);
    // And they can be turned on again, with another address.
    expect(await as("authenticated", owner, () => rows(turnOn, on(joes)))).toHaveLength(1);
  });

  it("are turned off with their location", async () => {
    const gone = await locationOf(org);
    const [made] = await as("authenticated", owner, () => rows<{ id: string }>(turnOn, on(gone)));
    await db.query("delete from public.locations where id = $1", [gone]);
    expect(
      await rows("select status, removal_reason from public.connections where id = $1", [made?.id]),
    ).toEqual([{ status: "removing", removal_reason: "location" }]);
  });

  it("tell a confidential category as the shared package does", async () => {
    const said = async (category: string) =>
      (
        await rows<{ confidential: boolean }>(
          "select public.is_confidential_category($1) as confidential",
          [category],
        )
      )[0]?.confidential;
    for (const category of [
      ...CONFIDENTIAL_KINDS,
      ...CONFIDENTIAL_KINDS.map((kind) => `${kind.toUpperCase()}S near me`),
      "Pizza restaurant",
      "Lawn care service",
      "Health food store",
      "Paralegal services",
    ]) {
      expect(await said(category), category).toBe(isConfidentialCategory(category));
    }
  });
});
