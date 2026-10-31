import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { MOST_PAGES_A_DAY, VISIT_ASSISTANTS } from "@nearcited/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Visits from assistants as a business's Google Analytics property counts them (issue #144): the
 * worker matches each property a sign-in reaches to the location whose website one of its streams
 * measures, and keeps a count for a day, a location, an assistant and a page, which a member reads
 * and nobody but the worker writes.
 */

const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
const shim = readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8");

const owner = "a0000000-0000-4000-8000-000000000001";
const stranger = "b0000000-0000-4000-8000-000000000002";
const operator = "e0000000-0000-4000-8000-000000000005";
const signIn = "c1000000-0000-4000-8000-000000000001";
const sample = "c1000000-0000-4000-8000-000000000002";

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

const worker = <T>(sql: string, params: unknown[] = []) =>
  as("service_role", null, () => rows<T>(sql, params));

const REACHED = JSON.stringify([
  { id: "properties/1", label: "Joe's", hosts: ["joes.example"] },
  { id: "properties/2", label: "Shop", hosts: ["shop.other.example", "another.example"] },
  { id: "properties/3", label: "Nobody's", hosts: ["nobody.example"] },
]);
const match =
  "select location_id, property_id, read_through::text from public.match_analytics_properties($1, $2::jsonb)";
const record =
  "select public.record_analytics_visits($1, $2::date, $3::date, $4::jsonb, $5, $6) as kept";
const kept = (location: string) =>
  rows<{ day: string; assistant: string; path: string; count: number }>(
    "select day::text, assistant, path, count from public.analytics_visits where location_id = $1 order by day, assistant, path",
    [location],
  );
const visit = (day: string, assistant: string, path: string, count: number) => ({
  day,
  assistant,
  path,
  count,
});

describe("sessions from assistants, read from Google Analytics", () => {
  let org: string;
  let main: string;
  let riverside: string;
  let shop: string;
  let elsewhere: string;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(shim);
    for (const file of readdirSync(migrationsDir).sort()) {
      await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }
    await db.query(
      "insert into auth.users (id, email) values ($1, 'owner@example.com'), ($2, 'stranger@example.com'), ($3, 'operator@example.com')",
      [owner, stranger, operator],
    );
    await db.query("insert into public.platform_roles (user_id, role) values ($1, 'operator')", [
      operator,
    ]);
    ({ id: org } = await one<{ id: string }>(
      "insert into public.organizations (name, created_by, allowances, max_locations) values ('Joe''s', $1, '{\"visits\": true}', 10) returning id",
      [owner],
    ));
    await db.query(
      "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'owner')",
      [org, owner],
    );
    const located = async (name: string, website: string | null) =>
      (
        await one<{ id: string }>(
          "insert into public.locations (organization_id, name, city, website) values ($1, $2, 'Raleigh', $3) returning id",
          [org, name, website],
        )
      ).id;
    main = await located("Main Street", "https://www.joes.example/");
    // The same website, made after: the property is Main Street's.
    riverside = await located("Riverside", "https://joes.example/riverside");
    shop = await located("Shop", "https://shop.other.example");
    elsewhere = await located("Elsewhere", "https://somewhere.example");
    await db.query(
      "insert into public.connections (id, organization_id, kind, label) values ($1, $3, 'google_analytics', 'Google Analytics'), ($2, $3, 'sample', 'Sample')",
      [signIn, sample, org],
    );
  });
  afterAll(async () => {
    await db.close();
  });

  describe("the kind of connection", () => {
    it("needs the visits allowance, and no new kind of allowance", async () => {
      expect(
        await rows(
          "select allowance from public.connection_kind_allowances where kind = 'google_analytics'",
        ),
      ).toEqual([{ allowance: "visits" }]);
      expect(await rows("select key from public.allowance_kinds where key = 'analytics'")).toEqual(
        [],
      );
    });

    it("is made by an owner through create_connection(), and refused without the allowance", async () => {
      const make = (id: string) =>
        as("authenticated", owner, () =>
          db.query(
            "select id from public.create_connection($1, $2, 'google_analytics', 'Google Analytics', 'sealed')",
            [org, id],
          ),
        );
      const id = "c1000000-0000-4000-8000-000000000003";
      expect((await make(id)).rows).toEqual([{ id }]);
      await db.query("delete from public.connections where id = $1", [id]);
      await db.query("update public.organizations set allowances = '{}' where id = $1", [org]);
      await expect(make(id)).rejects.toThrow(/does not include/);
      await db.query(
        "update public.organizations set allowances = '{\"visits\": true}' where id = $1",
        [org],
      );
    });
  });

  describe("the plan", () => {
    it("pauses the connection when it stops including visits, like any other kind", async () => {
      const [{ id: other } = { id: "" }] = await rows<{ id: string }>(
        "insert into public.organizations (name, created_by) values ('Other', $1) returning id",
        [owner],
      );
      await db.query("select public.apply_plan($1, 'standard')", [other]);
      const connection = "c1000000-0000-4000-8000-000000000004";
      await db.query(
        "insert into public.connections (id, organization_id, kind, label) values ($1, $2, 'google_analytics', 'Google Analytics')",
        [connection, other],
      );
      await db.query("select public.apply_plan($1, 'free')", [other]);
      expect(
        await rows("select status from public.connections where id = $1", [connection]),
      ).toEqual([{ status: "paused" }]);
      await db.query("select public.apply_plan($1, 'standard')", [other]);
      expect(
        await rows("select status from public.connections where id = $1", [connection]),
      ).toEqual([{ status: "working" }]);
    });
  });

  describe("matching properties", () => {
    it("is the worker's alone", async () => {
      for (const user of [owner, operator]) {
        await expect(
          as("authenticated", user, () => db.query(match, [signIn, REACHED])),
          user,
        ).rejects.toThrow(/permission denied/);
      }
    });

    it("matches each property to the first location whose website a stream of it measures", async () => {
      const matched = await worker(match, [signIn, REACHED]);
      expect(matched).toHaveLength(2);
      expect(matched).toEqual(
        expect.arrayContaining([
          {
            location_id: main,
            property_id: "properties/1",
            read_through: null,
          },
          {
            location_id: shop,
            property_id: "properties/2",
            read_through: null,
          },
        ]),
      );
      // What the sign-in reaches is kept as choices, without the hosts.
      const [{ choices } = { choices: null }] = await rows<{ choices: unknown }>(
        "select choices from public.connections where id = $1",
        [signIn],
      );
      expect(choices).toEqual([
        { id: "properties/1", label: "Joe's" },
        { id: "properties/2", label: "Shop" },
        { id: "properties/3", label: "Nobody's" },
      ]);
      // Reading again matches the same, and nothing twice.
      expect(await worker(match, [signIn, REACHED])).toHaveLength(2);
    });

    it("takes away a match whose property is gone or no longer measures the website", async () => {
      await db.query(
        "update public.locations set website = 'https://shop.moved.example' where id = $1",
        [shop],
      );
      expect(
        (await worker<{ location_id: string }>(match, [signIn, REACHED])).map((m) => m.location_id),
      ).toEqual([main]);
      expect(
        await worker(match, [
          signIn,
          JSON.stringify([{ id: "properties/2", label: "Shop", hosts: ["shop.other.example"] }]),
        ]),
      ).toEqual([]);
      await db.query(
        "update public.locations set website = 'https://shop.other.example' where id = $1",
        [shop],
      );
      expect(await worker(match, [signIn, REACHED])).toHaveLength(2);
    });

    it("gives one property to one location, and a location one property", async () => {
      const both = JSON.stringify([
        { id: "properties/1", label: "Joe's", hosts: ["joes.example"] },
        { id: "properties/9", label: "Joe's again", hosts: ["joes.example"] },
      ]);
      const matched = await worker<{ property_id: string }>(match, [signIn, both]);
      expect(matched.map((m) => m.property_id)).toEqual(["properties/1"]);
      await worker(match, [signIn, REACHED]);
    });

    it("refuses what is not a list of things with an id, a label and hosts", async () => {
      await expect(worker(match, [signIn, '[{"id": "properties/1"}]'])).rejects.toThrow();
      await expect(
        worker(match, [signIn, '[{"id": "properties/1", "label": "Joe\'s"}]']),
      ).rejects.toThrow();
    });

    it("answers nothing for a connection of another kind, or one not working", async () => {
      expect(await worker(match, [sample, REACHED])).toEqual([]);
      await db.query("update public.connections set status = 'paused' where id = $1", [signIn]);
      expect(await worker(match, [signIn, REACHED])).toEqual([]);
      await db.query("update public.connections set status = 'working' where id = $1", [signIn]);
    });

    it("refuses an owner who matches a property by hand", async () => {
      await expect(
        as("authenticated", owner, () =>
          db.query("select * from public.match_connection_location($1, $2, 'properties/1')", [
            signIn,
            riverside,
          ]),
        ),
      ).rejects.toThrow(/matched to the location whose website it measures/);
    });
  });

  describe("the counts", () => {
    beforeEach(async () => {
      await db.query("delete from public.analytics_visits");
      await db.query("update public.connection_locations set read_through = null");
    });

    it("are written by the worker alone, and by no API role directly", async () => {
      const counts = JSON.stringify([visit("2026-10-27", "chatgpt", "/", 3)]);
      for (const user of [owner, operator]) {
        await expect(
          as("authenticated", user, () =>
            db.query(record, [main, "2026-10-27", "2026-10-28", counts, signIn, false]),
          ),
          user,
        ).rejects.toThrow(/permission denied/);
      }
      for (const [role, user] of [
        ["authenticated", owner],
        ["anon", null],
      ] as const) {
        for (const sql of [
          "insert into public.analytics_visits (location_id, day, assistant, path, count) values ($1, current_date, 'chatgpt', '/', 1)",
          "update public.analytics_visits set count = 9 where location_id = $1",
          "delete from public.analytics_visits where location_id = $1",
        ]) {
          await expect(
            as(role, user, () => db.query(sql, [main])),
            `${role} ${sql}`,
          ).rejects.toThrow(/permission denied/);
        }
      }
    });

    it("replace the days read, never add to them, and note the last day read", async () => {
      const first = [
        visit("2026-10-26", "chatgpt", "/", 3),
        visit("2026-10-27", "chatgpt", "/", 3),
        visit("2026-10-27", "claude", "/menu", 2),
      ];
      expect(
        await worker(record, [
          main,
          "2026-10-26",
          "2026-10-27",
          JSON.stringify(first),
          signIn,
          false,
        ]),
      ).toEqual([{ kept: 3 }]);
      const again = [visit("2026-10-27", "chatgpt", "/", 5), visit("2026-10-28", "gemini", "/", 1)];
      await worker(record, [
        main,
        "2026-10-27",
        "2026-10-28",
        JSON.stringify(again),
        signIn,
        false,
      ]);
      expect(await kept(main)).toEqual([
        { day: "2026-10-26", assistant: "chatgpt", path: "/", count: 3 },
        { day: "2026-10-27", assistant: "chatgpt", path: "/", count: 5 },
        { day: "2026-10-28", assistant: "gemini", path: "/", count: 1 },
      ]);
      expect(await worker(match, [signIn, REACHED])).toContainEqual(
        expect.objectContaining({ location_id: main, read_through: "2026-10-28" }),
      );
    });

    it("are never the line's: what the line counted is left as it was", async () => {
      await db.query(
        "insert into public.visits (location_id, day, assistant, path, count) values ($1, '2026-10-27', 'chatgpt', '/', 7)",
        [main],
      );
      await worker(record, [
        main,
        "2026-10-27",
        "2026-10-27",
        JSON.stringify([visit("2026-10-27", "chatgpt", "/", 2)]),
        signIn,
        false,
      ]);
      expect(
        await rows<{ count: number }>("select count from public.visits where location_id = $1", [
          main,
        ]),
      ).toEqual([{ count: 7 }]);
      await db.query("delete from public.visits where location_id = $1", [main]);
    });

    it("keep only known assistants, pages from their first slash and days in the run", async () => {
      const counts = [
        visit("2026-10-27", "chatgpt", "/kept", 1),
        visit("2026-10-27", "ChatGPT", "/", 1),
        visit("2026-10-27", "google", "/", 1),
        visit("2026-10-27", "chatgpt", "no-slash", 1),
        visit("2026-10-27", "chatgpt", "/zero", 0),
        visit("2026-10-29", "chatgpt", "/later", 1),
        visit("2026-10-27", "chatgpt", `/${"a".repeat(300)}`, 1),
      ];
      await worker(record, [
        main,
        "2026-10-27",
        "2026-10-28",
        JSON.stringify(counts),
        signIn,
        false,
      ]);
      expect((await kept(main)).map((row) => row.path)).toEqual([`/${"a".repeat(199)}`, "/kept"]);
    });

    it("are kept for every assistant the shared list names, and for no other", async () => {
      const counts = VISIT_ASSISTANTS.map((assistant) => visit("2026-10-27", assistant, "/", 1));
      await worker(record, [
        main,
        "2026-10-27",
        "2026-10-27",
        JSON.stringify(counts),
        signIn,
        false,
      ]);
      expect((await kept(main)).map((row) => row.assistant).sort()).toEqual(
        [...VISIT_ASSISTANTS].sort(),
      );
      await expect(
        db.query(
          "insert into public.analytics_visits (location_id, day, assistant, path, count) values ($1, current_date, 'google', '/', 1)",
          [main],
        ),
      ).rejects.toThrow(/violates check constraint/);
    });

    it("stop at the line's bound of pages a day, counting the least visited together", async () => {
      const counts = [
        ...Array.from({ length: MOST_PAGES_A_DAY + 3 }, (_, at) =>
          visit("2026-10-27", "chatgpt", `/p${String(at).padStart(2, "0")}`, at + 1),
        ),
        // Google named no page for these: they are counted together from the start.
        visit("2026-10-27", "chatgpt", "", 10),
      ];
      await worker(record, [
        main,
        "2026-10-27",
        "2026-10-27",
        JSON.stringify(counts),
        signIn,
        false,
      ]);
      const rowsKept = await kept(main);
      expect(rowsKept).toHaveLength(MOST_PAGES_A_DAY + 1);
      expect(rowsKept.find((row) => row.path === "")).toEqual({
        day: "2026-10-27",
        assistant: "chatgpt",
        path: "",
        count: 1 + 2 + 3 + 10,
      });
    });

    it("are not written for a location the property is not matched to", async () => {
      const counts = JSON.stringify([visit("2026-10-27", "chatgpt", "/", 3)]);
      expect(
        await worker(record, [riverside, "2026-10-27", "2026-10-27", counts, signIn, false]),
      ).toEqual([{ kept: 0 }]);
      expect(await kept(riverside)).toEqual([]);
      // Sample counts are made up for a location, with no property.
      expect(
        await worker(record, [riverside, "2026-10-27", "2026-10-27", counts, null, true]),
      ).toEqual([{ kept: 1 }]);
    });

    it("are refused for more than a month of days", async () => {
      await expect(
        worker(record, [main, "2026-08-01", "2026-10-28", "[]", signIn, false]),
      ).rejects.toThrow(/at most a month/);
    });
  });

  describe("reading them", () => {
    const read = "select public.location_analytics_visits($1, $2::date, $3) as read";

    beforeAll(async () => {
      await db.query("delete from public.analytics_visits");
      const counts = [
        visit("2026-10-27", "chatgpt", "/", 3),
        visit("2026-10-27", "chatgpt", "/menu", 1),
        visit("2026-10-28", "chatgpt", "/", 2),
        visit("2026-10-28", "gemini", "/", 7),
        visit("2026-10-28", "gemini", "", 4),
      ];
      await worker(record, [
        main,
        "2026-10-27",
        "2026-10-28",
        JSON.stringify(counts),
        signIn,
        false,
      ]);
      await worker(record, [
        main,
        "2026-10-20",
        "2026-10-20",
        JSON.stringify([visit("2026-10-20", "chatgpt", "/old", 9)]),
        signIn,
        false,
      ]);
    });

    it("adds them up for a member, in the shape of what the line reported", async () => {
      const [mine] = await as("authenticated", owner, () =>
        rows<{ read: unknown }>(read, [main, "2026-10-21", false]),
      );
      expect(mine?.read).toEqual({
        days: [
          { day: "2026-10-27", assistant: "chatgpt", count: 4 },
          { day: "2026-10-28", assistant: "chatgpt", count: 2 },
          { day: "2026-10-28", assistant: "gemini", count: 11 },
        ],
        pages: [
          { path: "/", count: 12 },
          { path: "/menu", count: 1 },
        ],
        other_pages: 4,
      });
      // Sample counts and real ones are read apart.
      const [sampled] = await as("authenticated", owner, () =>
        rows<{ read: { days: unknown[] } }>(read, [main, "2026-10-21", true]),
      );
      expect(sampled?.read.days).toEqual([]);
    });

    it("reads nothing for someone who is not a member, and everything for the operator", async () => {
      const [theirs] = await as("authenticated", stranger, () =>
        rows<{ read: { days: unknown[] } }>(read, [main, "2026-10-01", false]),
      );
      expect(theirs?.read).toMatchObject({ days: [], pages: [], other_pages: 0 });
      expect(
        await as("authenticated", stranger, () =>
          rows("select * from public.analytics_visits where location_id = $1", [main]),
        ),
      ).toEqual([]);
      await expect(
        as("anon", null, () => db.query(read, [main, "2026-10-01", false])),
      ).rejects.toThrow(/permission denied/);
      expect(
        await as("authenticated", operator, () =>
          rows("select * from public.analytics_visits where location_id = $1", [main]),
        ),
      ).toHaveLength(6);
    });

    it("are in the owner's export, and stay when the connection goes, and go with the location", async () => {
      const [exported] = await as("authenticated", owner, () =>
        rows<{ export: { analytics_visits: { count: number }[] } }>(
          "select public.export_organization($1) as export",
          [org],
        ),
      );
      expect(exported?.export.analytics_visits).toHaveLength(6);
      await db.query("delete from public.connection_locations where connection_id = $1", [signIn]);
      expect(await kept(main)).toHaveLength(6);
      await db.query("delete from public.locations where id = $1", [elsewhere]);
      await db.query("delete from public.locations where id = $1", [main]);
      expect(await kept(main)).toEqual([]);
    });
  });
});
