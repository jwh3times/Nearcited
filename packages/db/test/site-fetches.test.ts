import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { MOST_FETCHED_PAGES_A_DAY } from "@nearcited/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Fetches of a business's own site, read from its Cloudflare zone (issue #156): the worker
 * matches each zone a token reaches to the location whose website it holds, and keeps a count for
 * a day, a location, a fetcher and a page, which a member reads and nobody but the worker writes.
 */

const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
const shim = readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8");

const owner = "a0000000-0000-4000-8000-000000000001";
const stranger = "b0000000-0000-4000-8000-000000000002";
const operator = "e0000000-0000-4000-8000-000000000005";
const token = "c1000000-0000-4000-8000-000000000001";
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

const ZONES = JSON.stringify([
  { id: "zone-joes", label: "joes.example" },
  { id: "zone-other", label: "other.example" },
]);
const match =
  "select location_id, zone_id, zone, read_through::text from public.match_cloudflare_zones($1, $2::jsonb)";
const record =
  "select public.record_site_fetches($1, $2::date, $3::date, $4::jsonb, $5, $6) as kept";
const kept = (location: string) =>
  rows<{ day: string; fetcher: string; path: string; count: number }>(
    "select day::text, fetcher, path, count from public.site_fetches where location_id = $1 order by day, fetcher, path",
    [location],
  );
const fetch = (day: string, fetcher: string, path: string, count: number) => ({
  day,
  fetcher,
  path,
  count,
});

describe("fetches of a business's own site", () => {
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
      "insert into public.organizations (name, created_by, allowances, max_locations) values ('Joe''s', $1, '{\"fetches\": true}', 10) returning id",
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
    // The same website, made after: the zone is Main Street's.
    riverside = await located("Riverside", "https://joes.example/riverside");
    shop = await located("Shop", "https://shop.other.example");
    elsewhere = await located("Elsewhere", "https://somewhere.example");
    await db.query(
      "insert into public.connections (id, organization_id, kind, label) values ($1, $3, 'cloudflare', 'Cloudflare'), ($2, $3, 'sample', 'Sample')",
      [token, sample, org],
    );
  });
  afterAll(async () => {
    await db.close();
  });

  describe("matching zones", () => {
    it("is the worker's alone", async () => {
      for (const user of [owner, operator]) {
        await expect(
          as("authenticated", user, () => db.query(match, [token, ZONES])),
          user,
        ).rejects.toThrow(/permission denied/);
      }
    });

    it("matches each zone to the first location whose website it holds", async () => {
      const matched = await worker(match, [token, ZONES]);
      expect(matched).toHaveLength(2);
      expect(matched).toEqual(
        expect.arrayContaining([
          { location_id: main, zone_id: "zone-joes", zone: "joes.example", read_through: null },
          { location_id: shop, zone_id: "zone-other", zone: "other.example", read_through: null },
        ]),
      );
      expect(
        (
          await rows<{ choices: unknown }>("select choices from public.connections where id = $1", [
            token,
          ])
        )[0]?.choices,
      ).toEqual(JSON.parse(ZONES));
      // Reading again matches the same, and nothing twice.
      expect(await worker(match, [token, ZONES])).toHaveLength(2);
    });

    it("takes away a match whose zone is gone or no longer holds the website", async () => {
      await db.query(
        "update public.locations set website = 'https://shop.moved.example' where id = $1",
        [shop],
      );
      expect(
        (await worker<{ location_id: string }>(match, [token, ZONES])).map((m) => m.location_id),
      ).toEqual([main]);
      expect(
        await worker(match, [
          token,
          JSON.stringify([{ id: "zone-other", label: "other.example" }]),
        ]),
      ).toEqual([]);
      await db.query(
        "update public.locations set website = 'https://shop.other.example' where id = $1",
        [shop],
      );
      expect(await worker(match, [token, ZONES])).toHaveLength(2);
    });

    it("gives a zone of its own subdomain to the location there, and the shorter zone to the next", async () => {
      const zones = JSON.stringify([
        { id: "zone-joes", label: "joes.example" },
        { id: "zone-shop", label: "shop.joes.example" },
      ]);
      // Made first, on the subdomain: only its own zone is its. Matched afresh.
      await db.query("delete from public.connection_locations where connection_id = $1", [token]);
      await db.query(
        "update public.locations set website = 'https://shop.joes.example' where id = $1",
        [main],
      );
      const matched = await worker<{ location_id: string; zone_id: string }>(match, [token, zones]);
      expect(matched.map((m) => [m.zone_id, m.location_id]).sort()).toEqual(
        [
          ["zone-joes", riverside],
          ["zone-shop", main],
        ].sort(),
      );
      await db.query(
        "update public.locations set website = 'https://www.joes.example/' where id = $1",
        [main],
      );
      await db.query("delete from public.connection_locations where connection_id = $1", [token]);
      expect(await worker(match, [token, ZONES])).toHaveLength(2);
    });

    it("answers nothing for a connection of another kind, or one not working", async () => {
      expect(await worker(match, [sample, ZONES])).toEqual([]);
      await db.query("update public.connections set status = 'paused' where id = $1", [token]);
      expect(await worker(match, [token, ZONES])).toEqual([]);
      await db.query("update public.connections set status = 'working' where id = $1", [token]);
    });

    it("refuses an owner who matches a zone by hand", async () => {
      await expect(
        as("authenticated", owner, () =>
          db.query("select * from public.match_connection_location($1, $2, 'zone-joes')", [
            token,
            riverside,
          ]),
        ),
      ).rejects.toThrow(/matched to the location whose website it holds/);
    });
  });

  describe("the counts", () => {
    beforeEach(async () => {
      await db.query("delete from public.site_fetches");
      await db.query("update public.connection_locations set read_through = null");
    });

    it("are written by the worker alone, and by no API role directly", async () => {
      const counts = JSON.stringify([fetch("2026-10-27", "gptbot", "/", 3)]);
      for (const user of [owner, operator]) {
        await expect(
          as("authenticated", user, () =>
            db.query(record, [main, "2026-10-27", "2026-10-28", counts, token, false]),
          ),
          user,
        ).rejects.toThrow(/permission denied/);
      }
      for (const [role, user] of [
        ["authenticated", owner],
        ["anon", null],
      ] as const) {
        for (const sql of [
          "insert into public.site_fetches (location_id, day, fetcher, path, count) values ($1, current_date, 'gptbot', '/', 1)",
          "update public.site_fetches set count = 9 where location_id = $1",
          "delete from public.site_fetches where location_id = $1",
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
        fetch("2026-10-26", "gptbot", "/", 3),
        fetch("2026-10-27", "gptbot", "/", 3),
        fetch("2026-10-27", "claudebot", "/menu", 2),
      ];
      expect(
        await worker(record, [
          main,
          "2026-10-26",
          "2026-10-27",
          JSON.stringify(first),
          token,
          false,
        ]),
      ).toEqual([{ kept: 3 }]);
      // The day before read again, with Cloudflare's later figure, and the day after.
      const again = [
        fetch("2026-10-27", "gptbot", "/", 5),
        fetch("2026-10-28", "bingbot", "/", 1.4),
      ];
      await worker(record, [main, "2026-10-27", "2026-10-28", JSON.stringify(again), token, false]);
      expect(await kept(main)).toEqual([
        { day: "2026-10-26", fetcher: "gptbot", path: "/", count: 3 },
        { day: "2026-10-27", fetcher: "gptbot", path: "/", count: 5 },
        { day: "2026-10-28", fetcher: "bingbot", path: "/", count: 1 },
      ]);
      expect(await worker(match, [token, ZONES])).toContainEqual(
        expect.objectContaining({ location_id: main, read_through: "2026-10-28" }),
      );
    });

    it("keep only known fetchers, pages from their first slash and days in the run", async () => {
      const counts = [
        fetch("2026-10-27", "gptbot", "/kept", 1),
        fetch("2026-10-27", "GPTBot", "/", 1),
        fetch("2026-10-27", "mozilla", "/", 1),
        fetch("2026-10-27", "gptbot", "no-slash", 1),
        fetch("2026-10-27", "gptbot", "/zero", 0),
        fetch("2026-10-29", "gptbot", "/later", 1),
        fetch("2026-10-27", "gptbot", `/${"a".repeat(300)}`, 1),
      ];
      await worker(record, [
        main,
        "2026-10-27",
        "2026-10-28",
        JSON.stringify(counts),
        token,
        false,
      ]);
      expect((await kept(main)).map((row) => row.path)).toEqual([`/${"a".repeat(199)}`, "/kept"]);
    });

    it("stop at fifty pages a day, counting the least fetched together", async () => {
      const counts = Array.from({ length: MOST_FETCHED_PAGES_A_DAY + 3 }, (_, at) =>
        fetch("2026-10-27", "googlebot", `/p${String(at).padStart(2, "0")}`, at + 1),
      );
      await worker(record, [
        main,
        "2026-10-27",
        "2026-10-27",
        JSON.stringify(counts),
        token,
        false,
      ]);
      const rowsKept = await kept(main);
      expect(rowsKept).toHaveLength(MOST_FETCHED_PAGES_A_DAY + 1);
      expect(rowsKept.find((row) => row.path === "")).toEqual({
        day: "2026-10-27",
        fetcher: "googlebot",
        path: "",
        count: 1 + 2 + 3,
      });
    });

    it("are not written for a location the zone is not matched to", async () => {
      const counts = JSON.stringify([fetch("2026-10-27", "gptbot", "/", 3)]);
      expect(
        await worker(record, [riverside, "2026-10-27", "2026-10-27", counts, token, false]),
      ).toEqual([{ kept: 0 }]);
      expect(await kept(riverside)).toEqual([]);
      // Sample counts are made up for a location, with no zone.
      expect(
        await worker(record, [riverside, "2026-10-27", "2026-10-27", counts, null, true]),
      ).toEqual([{ kept: 1 }]);
    });

    it("are refused for more than a month of days", async () => {
      await expect(
        worker(record, [main, "2026-08-01", "2026-10-28", "[]", token, false]),
      ).rejects.toThrow(/at most a month/);
    });
  });

  describe("reading them", () => {
    const read = "select public.location_site_fetches($1, $2::date, $3) as read";

    beforeAll(async () => {
      await db.query("delete from public.site_fetches");
      const counts = [
        fetch("2026-10-27", "gptbot", "/", 3),
        fetch("2026-10-27", "gptbot", "/menu", 1),
        fetch("2026-10-28", "gptbot", "/", 2),
        fetch("2026-10-28", "googlebot", "/", 7),
      ];
      await worker(record, [
        main,
        "2026-10-27",
        "2026-10-28",
        JSON.stringify(counts),
        token,
        false,
      ]);
      await worker(record, [
        main,
        "2026-10-20",
        "2026-10-20",
        JSON.stringify([fetch("2026-10-20", "gptbot", "/old", 9)]),
        token,
        false,
      ]);
    });

    it("adds them up for a member, by day, by page and from a day on", async () => {
      const [mine] = await as("authenticated", owner, () =>
        rows<{ read: unknown }>(read, [main, "2026-10-21", false]),
      );
      expect(mine?.read).toEqual({
        days: [
          { day: "2026-10-27", fetcher: "gptbot", count: 4 },
          { day: "2026-10-28", fetcher: "googlebot", count: 7 },
          { day: "2026-10-28", fetcher: "gptbot", count: 2 },
        ],
        pages: [
          { fetcher: "googlebot", path: "/", count: 7 },
          { fetcher: "gptbot", path: "/", count: 5 },
          { fetcher: "gptbot", path: "/menu", count: 1 },
        ],
        other_pages: [],
        read_through: "2026-10-28",
      });
      // Sample counts and real ones are read apart.
      const [sampled] = await as("authenticated", owner, () =>
        rows<{ read: { days: unknown[] } }>(read, [main, "2026-10-21", true]),
      );
      expect(sampled?.read.days).toEqual([]);
    });

    it("reads nothing for someone who is not a member, and everything for the operator", async () => {
      const [theirs] = await as("authenticated", stranger, () =>
        rows<{ read: { days: unknown[]; read_through: unknown } }>(read, [
          main,
          "2026-10-01",
          false,
        ]),
      );
      expect(theirs?.read).toMatchObject({ days: [], read_through: null });
      expect(
        await as("authenticated", stranger, () =>
          rows("select * from public.site_fetches where location_id = $1", [main]),
        ),
      ).toEqual([]);
      await expect(
        as("anon", null, () => db.query(read, [main, "2026-10-01", false])),
      ).rejects.toThrow(/permission denied/);
      const operatorReads = await as("authenticated", operator, () =>
        rows("select * from public.site_fetches where location_id = $1", [main]),
      );
      expect(operatorReads).toHaveLength(5);
    });

    it("leave the counts in place when the connection goes, and go with the location", async () => {
      await db.query("delete from public.connection_locations where connection_id = $1", [token]);
      expect(await kept(main)).toHaveLength(5);
      await db.query("delete from public.locations where id = $1", [elsewhere]);
      await db.query("delete from public.locations where id = $1", [main]);
      expect(await kept(main)).toEqual([]);
    });
  });
});
