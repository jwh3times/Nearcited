import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Applies the real migrations to an in-process Postgres and exercises the policies as
 * different users. The tests in this file run in order and build on each other's rows.
 */

const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
const shim = readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8");

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";

type Role = "anon" | "authenticated" | "service_role";

let db: PGlite;
let orgId: string;
let locationId: string;
let queryId: string;
let scanId: string;

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

beforeAll(async () => {
  db = new PGlite();
  await db.exec(shim);
  for (const file of readdirSync(migrationsDir).sort()) {
    await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  await db.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [
    alice,
    "alice@example.com",
    bob,
    "bob@example.com",
  ]);
});

describe("organizations", () => {
  it("cannot be inserted directly", async () => {
    await expect(
      as("authenticated", alice, () =>
        db.query("insert into public.organizations (name, created_by) values ('Sneaky', $1)", [
          alice,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("are created through create_organization, which makes the caller the owner", async () => {
    const [org] = await as("authenticated", alice, () =>
      rows<{ id: string; name: string }>(
        "select * from public.create_organization('  Raleigh Pizza Group ')",
      ),
    );
    expect(org?.name).toBe("Raleigh Pizza Group");
    orgId = org?.id ?? "";

    // A new organization starts on the free plan, with that plan's limits copied onto it.
    const [fresh] = await rows(
      "select plan_key, max_locations, max_queries_per_location, max_manual_scans_per_month, scan_every_days, emails_report, surfaces::text[] as surfaces, first_scan_at from public.organizations where id = $1",
      [orgId],
    );
    expect(fresh).toEqual({
      plan_key: "free",
      max_locations: 1,
      max_queries_per_location: 2,
      max_manual_scans_per_month: 0,
      scan_every_days: 14,
      emails_report: false,
      surfaces: ["chatgpt"],
      first_scan_at: null,
    });
    // The rest of this file is about what the limits do, not which plan set them, so this
    // organization's are set by hand from here on.
    await db.query(
      `update public.organizations
       set plan_key = null, max_queries_per_location = 10, max_manual_scans_per_month = 150,
           scan_every_days = 2, emails_report = true, surfaces = null
       where id = $1`,
      [orgId],
    );

    const memberships = await rows<{ user_id: string; role: string }>(
      "select user_id, role from public.memberships where organization_id = $1",
      [orgId],
    );
    expect(memberships).toEqual([{ user_id: alice, role: "owner" }]);
  });

  it("are invisible to non-members", async () => {
    const seenByAlice = await as("authenticated", alice, () =>
      rows("select id from public.organizations"),
    );
    const seenByBob = await as("authenticated", bob, () =>
      rows("select id from public.organizations"),
    );
    expect(seenByAlice).toHaveLength(1);
    expect(seenByBob).toHaveLength(0);
  });

  it("cannot be joined by adding yourself", async () => {
    await expect(
      as("authenticated", bob, () =>
        db.query(
          "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'owner')",
          [orgId, bob],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("locations and tracked queries", () => {
  it("can be added by a member", async () => {
    const [location] = await as("authenticated", alice, () =>
      rows<{ id: string }>(
        "insert into public.locations (organization_id, name, city) values ($1, 'Joe''s Pizza', 'Raleigh') returning id",
        [orgId],
      ),
    );
    locationId = location?.id ?? "";

    const [query] = await as("authenticated", alice, () =>
      rows<{ id: string }>(
        "insert into public.tracked_queries (location_id, kind, text) values ($1, 'ai_prompt', 'best pizza in Raleigh') returning id",
        [locationId],
      ),
    );
    queryId = query?.id ?? "";
    expect(locationId).not.toBe("");
    expect(queryId).not.toBe("");
  });

  it("scans a new location daily unless told otherwise", async () => {
    const [location] = await as("authenticated", alice, () =>
      rows<{ scan_frequency: string }>(
        "select scan_frequency from public.locations where id = $1",
        [locationId],
      ),
    );
    expect(location?.scan_frequency).toBe("daily");
  });

  it("can be retired by a member but not deleted", async () => {
    const [retired] = await as("authenticated", alice, () =>
      rows<{ is_active: boolean }>(
        "update public.tracked_queries set is_active = false where id = $1 returning is_active",
        [queryId],
      ),
    );
    expect(retired?.is_active).toBe(false);
    await as("authenticated", alice, () =>
      db.query("update public.tracked_queries set is_active = true where id = $1", [queryId]),
    );

    await expect(
      as("authenticated", alice, () =>
        db.query("delete from public.tracked_queries where id = $1", [queryId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("cannot be read or written by a non-member", async () => {
    expect(
      await as("authenticated", bob, () => rows("select id from public.locations")),
    ).toHaveLength(0);
    expect(
      await as("authenticated", bob, () => rows("select id from public.tracked_queries")),
    ).toHaveLength(0);

    await expect(
      as("authenticated", bob, () =>
        db.query(
          "insert into public.locations (organization_id, name, city) values ($1, 'Planted', 'Raleigh')",
          [orgId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);

    await expect(
      as("authenticated", bob, () =>
        db.query(
          "insert into public.tracked_queries (location_id, kind, text) values ($1, 'ai_prompt', 'x')",
          [locationId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);

    // An update that matches no visible row changes nothing rather than erroring.
    await as("authenticated", bob, () =>
      db.query("update public.locations set name = 'Defaced' where id = $1", [locationId]),
    );
    const [location] = await rows<{ name: string }>(
      "select name from public.locations where id = $1",
      [locationId],
    );
    expect(location?.name).toBe("Joe's Pizza");
  });

  it("are closed to signed-out visitors", async () => {
    await expect(
      as("anon", null, () => db.query("select id from public.locations")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("scans", () => {
  it("lists a never-scanned location with an active query as due", async () => {
    const due = await as("service_role", null, () =>
      rows<{ id: string }>("select public.locations_due_for_scan() as id"),
    );
    expect(due.map((row) => row.id)).toEqual([locationId]);
  });

  it("can be queued by a member as a manual scan", async () => {
    const [scan] = await as("authenticated", alice, () =>
      rows<{ id: string; status: string }>(
        "insert into public.scans (location_id, trigger, requested_by) values ($1, 'manual', $2) returning id, status",
        [locationId, alice],
      ),
    );
    expect(scan?.status).toBe("queued");
    scanId = scan?.id ?? "";
  });

  it("skips a location that already has a scan in flight", async () => {
    const due = await as("service_role", null, () =>
      rows("select public.locations_due_for_scan() as id"),
    );
    expect(due).toHaveLength(0);
  });

  it.each([
    ["a finished status", "status", "'succeeded'"],
    ["the scheduled trigger", "trigger", "'scheduled'"],
    ["a score", "visibility_score", "99"],
    ["a sample-data label", "sample_data", "true"],
  ])("cannot be inserted by a member with %s", async (_label, column, value) => {
    const columns = ["location_id", "requested_by", ...(column === "trigger" ? [] : ["trigger"])];
    const values = ["$1", "$2", ...(column === "trigger" ? [] : ["'manual'"])];
    await expect(
      as("authenticated", alice, () =>
        db.query(
          `insert into public.scans (${[...columns, column].join(", ")}) values (${[...values, value].join(", ")})`,
          [locationId, alice],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("allows one scan in flight per location, whoever asks", async () => {
    const insert =
      "insert into public.scans (location_id, trigger, requested_by) values ($1, $2, $3)";
    await expect(
      as("authenticated", alice, () => db.query(insert, [locationId, "manual", alice])),
    ).rejects.toThrow(/scans_one_in_flight_idx/);
    await expect(
      as("service_role", null, () => db.query(insert, [locationId, "scheduled", null])),
    ).rejects.toThrow(/scans_one_in_flight_idx/);

    // A running scan still counts. Once it finishes, the next one is allowed.
    await db.query("update public.scans set status = 'running' where id = $1", [scanId]);
    await expect(
      as("service_role", null, () => db.query(insert, [locationId, "scheduled", null])),
    ).rejects.toThrow(/scans_one_in_flight_idx/);

    await db.query("update public.scans set status = 'failed' where id = $1", [scanId]);
    const [next] = await as("service_role", null, () =>
      rows<{ id: string }>(`${insert} returning id`, [locationId, "scheduled", null]),
    );
    expect(next?.id).toBeTruthy();
    // Put things back as the tests that follow expect: the original scan queued, the extra gone.
    await db.query("delete from public.scans where id = $1", [next?.id]);
    await db.query("update public.scans set status = 'queued' where id = $1", [scanId]);
  });

  it("cannot be queued in someone else's name or for someone else's location", async () => {
    await expect(
      as("authenticated", alice, () =>
        db.query(
          "insert into public.scans (location_id, trigger, requested_by) values ($1, 'manual', $2)",
          [locationId, bob],
        ),
      ),
    ).rejects.toThrow(/row-level security/);

    await expect(
      as("authenticated", bob, () =>
        db.query(
          "insert into public.scans (location_id, trigger, requested_by) values ($1, 'manual', $2)",
          [locationId, bob],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot be updated by a member", async () => {
    await expect(
      as("authenticated", alice, () =>
        db.query("update public.scans set status = 'succeeded' where id = $1", [scanId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("worker functions", () => {
  const results = (mentioned: boolean) =>
    JSON.stringify([
      {
        tracked_query_id: queryId,
        surface: "chatgpt",
        mentioned,
        position: mentioned ? 2 : null,
        competitors: ["Tony's Slice House"],
        cited_urls: [],
        answer_excerpt: "Try Tony's Slice House.",
      },
    ]);
  const recommendation = (rule: string) => ({ rule, title: `Title ${rule}`, detail: "Detail" });

  it("are not callable by signed-in users", async () => {
    await expect(
      as("authenticated", alice, () =>
        db.query("select public.complete_scan($1, 50, '[]'::jsonb, '[]'::jsonb)", [scanId]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as("authenticated", alice, () => db.query("select public.locations_due_for_scan()")),
    ).rejects.toThrow(/permission denied/);
  });

  it("complete_scan stores results, the score, and recommendations together", async () => {
    await as("service_role", null, () =>
      db.query("select public.complete_scan($1, 80.0, $2::jsonb, $3::jsonb)", [
        scanId,
        results(true),
        JSON.stringify([recommendation("add_website"), recommendation("absent:gemini")]),
      ]),
    );

    const [scan] = await rows<{ status: string; visibility_score: string; finished_at: unknown }>(
      "select status, visibility_score, finished_at from public.scans where id = $1",
      [scanId],
    );
    expect(scan?.status).toBe("succeeded");
    expect(Number(scan?.visibility_score)).toBe(80);
    expect(scan?.finished_at).not.toBeNull();

    const [location] = await rows<{ last_scanned_at: unknown }>(
      "select last_scanned_at from public.locations where id = $1",
      [locationId],
    );
    expect(location?.last_scanned_at).not.toBeNull();
  });

  it("complete_scan replaces results when a scan is re-run", async () => {
    await as("service_role", null, () =>
      db.query("select public.complete_scan($1, 0, $2::jsonb, $3::jsonb)", [
        scanId,
        results(false),
        JSON.stringify([recommendation("add_website"), recommendation("absent:gemini")]),
      ]),
    );
    const stored = await rows<{ mentioned: boolean; position: number | null }>(
      'select mentioned, "position" from public.scan_results where scan_id = $1',
      [scanId],
    );
    expect(stored).toEqual([{ mentioned: false, position: null }]);
  });

  it("complete_scan fails for an unknown scan", async () => {
    await expect(
      as("service_role", null, () =>
        db.query(
          "select public.complete_scan('00000000-0000-4000-8000-000000000000', 0, '[]'::jsonb, '[]'::jsonb)",
        ),
      ),
    ).rejects.toThrow(/not found/);
  });

  it("lets members read results and recommendations, and nobody else", async () => {
    const read = (user: string, table: string) =>
      as("authenticated", user, () => rows(`select id from public.${table}`));

    expect(await read(alice, "scan_results")).toHaveLength(1);
    expect(await read(alice, "recommendations")).toHaveLength(2);
    expect(await read(bob, "scans")).toHaveLength(0);
    expect(await read(bob, "scan_results")).toHaveLength(0);
    expect(await read(bob, "recommendations")).toHaveLength(0);
  });

  it("lets members change a recommendation's status and nothing else", async () => {
    await as("authenticated", alice, () =>
      db.query(
        "update public.recommendations set status = 'dismissed' where location_id = $1 and rule = 'absent:gemini'",
        [locationId],
      ),
    );
    await expect(
      as("authenticated", alice, () =>
        db.query("update public.recommendations set title = 'Rewritten' where location_id = $1", [
          locationId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("resolves rules that stop firing, reopens ones that fire again, and keeps dismissals", async () => {
    const statuses = async () =>
      Object.fromEntries(
        (
          await rows<{ rule: string; status: string }>(
            "select rule, status from public.recommendations where location_id = $1",
            [locationId],
          )
        ).map((row) => [row.rule, row.status]),
      );
    const rerun = (rules: string[]) =>
      as("service_role", null, () =>
        db.query("select public.complete_scan($1, 0, $2::jsonb, $3::jsonb)", [
          scanId,
          results(false),
          JSON.stringify(rules.map(recommendation)),
        ]),
      );

    await rerun(["absent:gemini"]);
    expect(await statuses()).toEqual({ add_website: "done", "absent:gemini": "dismissed" });

    await rerun(["add_website", "absent:gemini"]);
    expect(await statuses()).toEqual({ add_website: "open", "absent:gemini": "dismissed" });
  });
});

describe("usage caps", () => {
  /** Limits are set by whoever manages plans, never by a member. Here that is the test itself. */
  const setLimits = (limits: string) =>
    db.query(`update public.organizations set ${limits} where id = $1`, [orgId]);
  const addLocation = (name: string) =>
    as("authenticated", alice, () =>
      rows<{ id: string }>(
        "insert into public.locations (organization_id, name, city) values ($1, $2, 'Raleigh') returning id",
        [orgId, name],
      ),
    );
  const addQuery = (location: string, text: string) =>
    as("authenticated", alice, () =>
      rows<{ id: string }>(
        "insert into public.tracked_queries (location_id, kind, text) values ($1, 'ai_prompt', $2) returning id",
        [location, text],
      ),
    );
  const manualScan = (location: string) =>
    as("authenticated", alice, () =>
      rows<{ id: string }>(
        "insert into public.scans (location_id, trigger, requested_by) values ($1, 'manual', $2) returning id",
        [location, alice],
      ),
    );
  let second = "";

  it("are the organization's own columns", async () => {
    const [org] = await rows<Record<string, number>>(
      "select max_locations, max_queries_per_location, max_manual_scans_per_month from public.organizations where id = $1",
      [orgId],
    );
    expect(org).toEqual({
      max_locations: 1,
      max_queries_per_location: 10,
      max_manual_scans_per_month: 150,
    });
  });

  it("refuse a location past the limit, naming the limit", async () => {
    await expect(addLocation("Second Shop")).rejects.toThrow(/can have 1 location /);

    await setLimits("max_locations = 2");
    const [location] = await addLocation("Second Shop");
    second = location?.id ?? "";
    expect(second).not.toBe("");
    await expect(addLocation("Third Shop")).rejects.toThrow(/can have 2 locations /);
  });

  it("tell a non-member they are a non-member, not that a limit was reached", async () => {
    await expect(
      as("authenticated", bob, () =>
        db.query(
          "insert into public.locations (organization_id, name, city) values ($1, 'Planted', 'Raleigh')",
          [orgId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("count only active prompts, so retiring one makes room and restoring one needs it", async () => {
    await setLimits("max_queries_per_location = 1");
    const [first] = await addQuery(second, "first prompt");
    await expect(addQuery(second, "second prompt")).rejects.toThrow(/can have 1 active prompt /);

    const retire = (active: boolean) =>
      as("authenticated", alice, () =>
        db.query("update public.tracked_queries set is_active = $1 where id = $2", [
          active,
          first?.id,
        ]),
      );
    await retire(false);
    await addQuery(second, "second prompt");
    await expect(retire(true)).rejects.toThrow(/can have 1 active prompt /);
  });

  it("limit manual scans across the organization, and leave scheduled scans alone", async () => {
    const [{ used } = { used: 0 }] = await rows<{ used: number }>(
      `select count(*)::int as used from public.scans s join public.locations l on l.id = s.location_id
       where l.organization_id = $1 and s.trigger = 'manual' and s.requested_by is not null
         and s.created_at > (select first_scan_at from public.organizations where id = $1)`,
      [orgId],
    );
    await setLimits(`max_manual_scans_per_month = ${used}`);
    await expect(manualScan(second)).rejects.toThrow(/by hand/);

    // The schedule is not a member asking, so it is not counted.
    const [scheduled] = await as("service_role", null, () =>
      rows<{ id: string }>(
        "insert into public.scans (location_id, trigger) values ($1, 'scheduled') returning id",
        [second],
      ),
    );
    expect(scheduled?.id).toBeTruthy();
    await db.query("update public.scans set status = 'failed' where id = $1", [scheduled?.id]);

    await setLimits(`max_manual_scans_per_month = ${used + 1}`);
    const [allowed] = await manualScan(second);
    expect(allowed?.id).toBeTruthy();
  });

  it("count scans by hand over the calendar month, so last month's are forgotten", async () => {
    await db.query(
      "update public.scans set status = 'failed' where status in ('queued', 'running')",
    );
    const [{ used } = { used: 0 }] = await rows<{ used: number }>(
      "select manual_scans_used as used from public.organizations where id = $1",
      [orgId],
    );
    expect(used).toBeGreaterThan(0);
    await setLimits(`max_manual_scans_per_month = ${used}`);
    await expect(manualScan(second)).rejects.toThrow(/by hand/);
    // A refused scan is not counted.
    expect(
      await rows("select manual_scans_used as used from public.organizations where id = $1", [
        orgId,
      ]),
    ).toEqual([{ used }]);

    // The count is for one month. When it is last month's, none of this month's are used.
    await db.query(
      "update public.organizations set manual_scans_month = (date_trunc('month', now()) - interval '1 day')::date where id = $1",
      [orgId],
    );
    const [allowed] = await manualScan(second);
    expect(allowed?.id).toBeTruthy();
    expect(
      await rows("select manual_scans_used as used from public.organizations where id = $1", [
        orgId,
      ]),
    ).toEqual([{ used: 1 }]);
    await db.query("update public.scans set status = 'failed' where id = $1", [allowed?.id]);
    await setLimits("max_manual_scans_per_month = 150");
  });

  it("keep the month's count when the location that was scanned is deleted", async () => {
    const erin = "e1000000-0000-4000-8000-00000000e001";
    await db.query("insert into auth.users (id, email) values ($1, 'erin@example.com')", [erin]);
    const asErin = <T>(sql: string, params: unknown[] = []) =>
      as("authenticated", erin, () => rows<T>(sql, params));
    const [org] = await asErin<{ id: string }>(
      "select id from public.create_organization('Erin''s Eatery')",
    );
    await as("service_role", null, () =>
      db.query("select public.apply_plan($1, 'starter')", [org?.id]),
    );
    const addLocation = async () =>
      (
        await asErin<{ id: string }>(
          "insert into public.locations (organization_id, name, city) values ($1, 'Eatery', 'Raleigh') returning id",
          [org?.id],
        )
      )[0]?.id;
    const scan = async (location: string | undefined) => {
      const [made] = await asErin<{ id: string }>(
        "insert into public.scans (location_id, trigger, requested_by) values ($1, 'manual', $2) returning id",
        [location, erin],
      );
      await db.query("update public.scans set status = 'succeeded' where id = $1", [made?.id]);
    };

    // The first ever is free; Starter then allows two a month.
    let location = await addLocation();
    await scan(location);
    await scan(location);
    await scan(location);
    await expect(scan(location)).rejects.toThrow(/2 scans by hand/);

    // Deleting the location takes its scans with it, and used to take the count too.
    await asErin("delete from public.locations where id = $1", [location]);
    location = await addLocation();
    await expect(scan(location)).rejects.toThrow(/2 scans by hand/);
    // Nor can a member reset the count themselves.
    await expect(
      asErin("update public.organizations set manual_scans_used = 0 where id = $1", [org?.id]),
    ).rejects.toThrow(/permission denied/);
    await db.query("delete from public.organizations where id = $1", [org?.id]);
  });

  describe("an organization with more than its plan allows", () => {
    const frank = "f1000000-0000-4000-8000-00000000f001";
    let org = "";
    const places: string[] = [];
    const asFrank = <T>(sql: string, params: unknown[] = []) =>
      as("authenticated", frank, () => rows<T>(sql, params));
    const plan = (key: string, locations: number | null = null) =>
      as("service_role", null, () =>
        db.query("select public.apply_plan($1, $2, $3)", [org, key, locations]),
      );
    const paused = async () =>
      (
        await rows<{ name: string; paused_by_plan: boolean }>(
          "select name, paused_by_plan from public.locations where organization_id = $1 order by created_at, id",
          [org],
        )
      ).map((row) => `${row.name}:${row.paused_by_plan ? "paused" : "in use"}`);
    const prompts = async (location: string | undefined) =>
      (
        await rows<{ text: string; is_active: boolean; set_aside_by_plan: boolean }>(
          "select text, is_active, set_aside_by_plan from public.tracked_queries where location_id = $1 order by created_at, id",
          [location],
        )
      ).map(
        (row) =>
          `${row.text}:${row.is_active ? "active" : row.set_aside_by_plan ? "set aside" : "retired"}`,
      );

    beforeAll(async () => {
      await db.query("insert into auth.users (id, email) values ($1, 'frank@example.com')", [
        frank,
      ]);
      org =
        (await asFrank<{ id: string }>("select id from public.create_organization('Frank''s')"))[0]
          ?.id ?? "";
      await plan("standard");
      for (const name of ["First", "Second", "Third"]) {
        const [row] = await asFrank<{ id: string }>(
          "insert into public.locations (organization_id, name, city, created_at) values ($1, $2, 'Raleigh', now() + ($3 || ' seconds')::interval) returning id",
          [org, name, String(places.length)],
        );
        places.push(row?.id ?? "");
      }
      for (const [at, text] of ["p1", "p2", "p3", "p4"].entries()) {
        await asFrank(
          "insert into public.tracked_queries (location_id, kind, text, created_at) values ($1, 'ai_prompt', $2, now() + ($3 || ' seconds')::interval)",
          [places[0], text, String(at)],
        );
      }
      // One the owner retired themselves, which no plan brings back.
      await asFrank(
        "update public.tracked_queries set is_active = false where location_id = $1 and text = 'p2'",
        [places[0]],
      );
    });
    afterAll(async () => {
      await db.query("delete from public.organizations where id = $1", [org]);
    });

    it("keeps the oldest location and the oldest prompts in use, and deletes nothing", async () => {
      await plan("free");
      expect(await paused()).toEqual(["First:in use", "Second:paused", "Third:paused"]);
      // Free tracks two: p1 and p3 are the two oldest still active. p4 is set aside.
      expect(await prompts(places[0])).toEqual([
        "p1:active",
        "p2:retired",
        "p3:active",
        "p4:set aside",
      ]);
    });

    it("scans a paused location neither on the schedule nor by hand", async () => {
      await asFrank(
        "insert into public.tracked_queries (location_id, kind, text) values ($1, 'ai_prompt', 'second prompt')",
        [places[1]],
      );
      const due = await as("service_role", null, () =>
        rows<{ id: string }>(
          "select locations_due_for_scan as id from public.locations_due_for_scan(1000)",
        ),
      );
      const ids = due.map((row) => row.id);
      expect(ids).toContain(places[0]);
      expect(ids).not.toContain(places[1]);
      await expect(
        asFrank(
          "insert into public.scans (location_id, trigger, requested_by) values ($1, 'manual', $2)",
          [places[1], frank],
        ),
      ).rejects.toThrow(/This location is paused/);
    });

    it("does not let a member unpause a location or set a prompt aside by writing the row", async () => {
      await asFrank(
        "update public.locations set paused_by_plan = false, name = 'Second' where id = $1",
        [places[1]],
      );
      await asFrank(
        "update public.tracked_queries set set_aside_by_plan = true where location_id = $1 and text = 'p1'",
        [places[0]],
      );
      expect(await paused()).toEqual(["First:in use", "Second:paused", "Third:paused"]);
      expect((await prompts(places[0]))[0]).toBe("p1:active");
    });

    it("lets a member swap which location is in use, naming the one to pause", async () => {
      const activate = (location: string | undefined, insteadOf: string | null = null) =>
        asFrank<{ id: string; paused_by_plan: boolean }>(
          "select id, paused_by_plan from public.activate_location($1, $2)",
          [location, insteadOf],
        );
      await expect(activate(places[2])).rejects.toThrow(/covers 1 location\. Choose one to pause/);
      // Naming one that is not in use, or not theirs, is no choice at all.
      await expect(activate(places[2], places[1])).rejects.toThrow(/Choose one to pause/);
      expect(await activate(places[2], places[0])).toEqual([
        { id: places[2], paused_by_plan: false },
      ]);
      expect(await paused()).toEqual(["First:paused", "Second:paused", "Third:in use"]);
      // One already in use is simply returned.
      expect(await activate(places[2])).toEqual([{ id: places[2], paused_by_plan: false }]);
      // A stranger gets nothing and changes nothing.
      expect(
        await as("authenticated", alice, () =>
          rows("select id from public.activate_location($1, $2)", [places[0], places[2]]),
        ),
      ).toEqual([]);
      expect(await paused()).toEqual(["First:paused", "Second:paused", "Third:in use"]);
    });

    it("lets a member swap prompts by retiring one and restoring another", async () => {
      const set = (text: string, active: boolean) =>
        asFrank(
          "update public.tracked_queries set is_active = $3 where location_id = $1 and text = $2",
          [places[0], text, active],
        );
      await expect(set("p4", true)).rejects.toThrow(/can have 2 active prompts/);
      await set("p1", false);
      await set("p4", true);
      // Restored by hand, so it is no longer something the plan set aside.
      expect(await prompts(places[0])).toEqual([
        "p1:retired",
        "p2:retired",
        "p3:active",
        "p4:active",
      ]);
    });

    it("brings back what was paused when the plan grows, keeping the owner's swap", async () => {
      await plan("starter", 2);
      // The one the owner chose stays in use; the older of the paused two joins it.
      expect(await paused()).toEqual(["First:in use", "Second:paused", "Third:in use"]);
      await plan("standard");
      expect(await paused()).toEqual(["First:in use", "Second:in use", "Third:in use"]);
      // Prompts the owner retired stay retired, whatever room there is.
      expect(await prompts(places[0])).toEqual([
        "p1:retired",
        "p2:retired",
        "p3:active",
        "p4:active",
      ]);
    });

    it("restores prompts the plan set aside, oldest first, as far as there is room", async () => {
      for (const text of ["p5", "p6", "p7"]) {
        await asFrank(
          "insert into public.tracked_queries (location_id, kind, text, created_at) values ($1, 'ai_prompt', $2, now() + interval '1 minute' + ($3 || ' seconds')::interval)",
          [places[0], text, text.slice(1)],
        );
      }
      await plan("free");
      expect(await prompts(places[0])).toEqual([
        "p1:retired",
        "p2:retired",
        "p3:active",
        "p4:active",
        "p5:set aside",
        "p6:set aside",
        "p7:set aside",
      ]);
      await db.query("update public.organizations set max_queries_per_location = 4 where id = $1", [
        org,
      ]);
      await as("service_role", null, () => db.query("select public.fit_to_plan($1)", [org]));
      expect(await prompts(places[0])).toEqual([
        "p1:retired",
        "p2:retired",
        "p3:active",
        "p4:active",
        "p5:active",
        "p6:active",
        "p7:set aside",
      ]);
      await expect(
        as("authenticated", frank, () => db.query("select public.fit_to_plan($1)", [org])),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it("let a new organization run its first scan on a plan that allows none by hand, once", async () => {
    const carol = "c0000000-0000-4000-8000-00000000ca01";
    await db.query("insert into auth.users (id, email) values ($1, 'carol@example.com')", [carol]);
    const asCarol = <T>(sql: string, params: unknown[] = []) =>
      as("authenticated", carol, () => rows<T>(sql, params));
    const [org] = await asCarol<{ id: string }>(
      "select id from public.create_organization('Carol''s Cafe')",
    );
    const [location] = await asCarol<{ id: string }>(
      "insert into public.locations (organization_id, name, city) values ($1, 'Cafe', 'Raleigh') returning id",
      [org?.id],
    );
    const scan =
      "insert into public.scans (location_id, trigger, requested_by) values ($1, 'manual', $2) returning id";

    const [first] = await asCarol<{ id: string }>(scan, [location?.id, carol]);
    expect(first?.id).toBeTruthy();
    const [after] = await rows<{ first_scan_at: string | null }>(
      "select first_scan_at from public.organizations where id = $1",
      [org?.id],
    );
    expect(after?.first_scan_at).not.toBeNull();
    await db.query("update public.scans set status = 'succeeded' where id = $1", [first?.id]);

    // The free plan allows none after that, and says why in words an owner can act on.
    await expect(asCarol(scan, [location?.id, carol])).rejects.toThrow(
      /does not include scans started by hand/,
    );
    // Its own limits: one location, two prompts.
    await expect(
      asCarol(
        "insert into public.locations (organization_id, name, city) values ($1, 'Second', 'Raleigh')",
        [org?.id],
      ),
    ).rejects.toThrow(/can have 1 location /);
    const prompt =
      "insert into public.tracked_queries (location_id, kind, text) values ($1, 'ai_prompt', $2)";
    await asCarol(prompt, [location?.id, "one"]);
    await asCarol(prompt, [location?.id, "two"]);
    await expect(asCarol(prompt, [location?.id, "three"])).rejects.toThrow(
      /can have 2 active prompts /,
    );
  });

  it("let an owner choose the assistants their plan covers, and nobody else", async () => {
    const dave = "d0000000-0000-4000-8000-00000000da01";
    await db.query("insert into auth.users (id, email) values ($1, 'dave@example.com')", [dave]);
    const [org] = await as("authenticated", dave, () =>
      rows<{ id: string }>("select id from public.create_organization('Dave''s Diner')"),
    );
    // A second person in the organization who is not its owner.
    await db.query(
      "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'member')",
      [org?.id, bob],
    );
    const choose = (user: string, chosen: string) =>
      as("authenticated", user, () =>
        rows<{ surfaces: string[] }>(
          `select surfaces::text[] as surfaces from public.choose_assistants($1, '${chosen}')`,
          [org?.id],
        ),
      );

    // The free plan checks one. Its owner picks which, and may pick again.
    expect(await choose(dave, "{claude}")).toEqual([{ surfaces: ["claude"] }]);
    expect(await choose(dave, "{chatgpt}")).toEqual([{ surfaces: ["chatgpt"] }]);
    await expect(choose(dave, "{chatgpt,claude}")).rejects.toThrow(/checks 1 assistant\./);
    await expect(choose(dave, "{}")).rejects.toThrow(/checks 1 assistant\./);
    await expect(choose(dave, "{gemini}")).rejects.toThrow(/ChatGPT and Claude/);
    // A member who is not the owner, a stranger and a signed-out caller change nothing.
    expect(await choose(bob, "{claude}")).toEqual([]);
    expect(await choose(alice, "{claude}")).toEqual([]);
    await expect(
      as("anon", null, () =>
        db.query("select public.choose_assistants($1, '{claude}')", [org?.id]),
      ),
    ).rejects.toThrow(/permission denied/);
    // And the column itself is still not a member's to write.
    await expect(
      as("authenticated", dave, () =>
        db.query("update public.organizations set surfaces = '{chatgpt,claude}' where id = $1", [
          org?.id,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);

    // On a plan that checks both there is nothing to choose but both, in one order.
    await as("service_role", null, () =>
      db.query("select public.apply_plan($1, 'standard')", [org?.id]),
    );
    expect(await choose(dave, "{claude,chatgpt,claude}")).toEqual([
      { surfaces: ["chatgpt", "claude"] },
    ]);
    await expect(choose(dave, "{claude}")).rejects.toThrow(/checks 2 assistants\./);

    // An organization whose settings were made by hand has no plan to choose within.
    await db.query("update public.organizations set plan_key = null where id = $1", [org?.id]);
    await expect(choose(dave, "{claude}")).rejects.toThrow(/were set for it/);
    await db.query("delete from public.organizations where id = $1", [org?.id]);
  });

  describe("cannot be got around", () => {
    const gina = "ab000000-0000-4000-8000-00000000ab02";
    const asGina = <T>(sql: string, params: unknown[] = []) =>
      as("authenticated", gina, () => rows<T>(sql, params));
    let org = "";
    let first = "";

    beforeAll(async () => {
      await db.query("insert into auth.users (id, email) values ($1, 'gina@example.com')", [gina]);
      org =
        (await asGina<{ id: string }>("select id from public.create_organization('Gina''s')"))[0]
          ?.id ?? "";
      first =
        (
          await asGina<{ id: string }>(
            "insert into public.locations (organization_id, name, city) values ($1, 'First', 'Raleigh') returning id",
            [org],
          )
        )[0]?.id ?? "";
    });

    it("by making a second organization, which would be a second free plan", async () => {
      await expect(asGina("select id from public.create_organization('Another')")).rejects.toThrow(
        /already has an organization/,
      );
      // Belonging to someone else's counts too: an account has one organization, not one of its own.
      const guest = "ab000000-0000-4000-8000-00000000ab03";
      await db.query("insert into auth.users (id, email) values ($1, 'guest@example.com')", [
        guest,
      ]);
      await db.query(
        "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'member')",
        [org, guest],
      );
      await expect(
        as("authenticated", guest, () => db.query("select public.create_organization('Mine')")),
      ).rejects.toThrow(/already has an organization/);
      expect(
        await rows("select count(*)::int as n from public.memberships where user_id in ($1, $2)", [
          gina,
          guest,
        ]),
      ).toEqual([{ n: 2 }]);
    });

    it("except by the operator and a test account, who may have several", async () => {
      for (const [user, role] of [
        ["ab000000-0000-4000-8000-00000000ab04", "operator"],
        ["ab000000-0000-4000-8000-00000000ab05", "test"],
      ] as const) {
        await db.query("insert into auth.users (id, email) values ($1, $2)", [
          user,
          `${role}2@example.com`,
        ]);
        await db.query("insert into public.platform_roles (user_id, role) values ($1, $2)", [
          user,
          role,
        ]);
        const made = [];
        for (const name of ["One", "Two"]) {
          made.push(
            ...(await as("authenticated", user, () =>
              rows<{ is_test: boolean; plan_key: string | null }>(
                "select is_test, plan_key from public.create_organization($1)",
                [name],
              ),
            )),
          );
        }
        // The operator's are ordinary organizations on the free plan. A test account's are test ones.
        expect(made, role).toEqual(
          role === "test"
            ? [
                { is_test: true, plan_key: null },
                { is_test: true, plan_key: null },
              ]
            : [
                { is_test: false, plan_key: "free" },
                { is_test: false, plan_key: "free" },
              ],
        );
        await db.query("delete from public.organizations where created_by = $1", [user]);
        await db.query("delete from public.platform_roles where user_id = $1", [user]);
      }
    });

    it("by deleting the organization to start again", async () => {
      await expect(asGina("delete from public.organizations where id = $1", [org])).rejects.toThrow(
        /permission denied/,
      );
      expect(
        await rows("select count(*)::int as n from public.organizations where id = $1", [org]),
      ).toEqual([{ n: 1 }]);
    });

    it("by moving a location into an organization, or a prompt onto a location", async () => {
      // Another organization she belongs to, as a member invited to it would.
      await db.query(
        "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'member')",
        [orgId, gina],
      );
      const [theirs] = await rows<{ id: string }>(
        "select id from public.locations where organization_id = $1 limit 1",
        [orgId],
      );
      await expect(
        asGina("update public.locations set organization_id = $1 where id = $2", [org, theirs?.id]),
      ).rejects.toThrow(/cannot be moved to another organization/);

      await asGina(
        "insert into public.tracked_queries (location_id, kind, text) values ($1, 'ai_prompt', 'g1'), ($1, 'ai_prompt', 'g2')",
        [first],
      );
      await db.query(
        "insert into public.tracked_queries (location_id, kind, text, is_active) values ($1, 'ai_prompt', 'elsewhere', false)",
        [theirs?.id],
      );
      await expect(
        asGina("update public.tracked_queries set location_id = $1 where text = 'elsewhere'", [
          first,
        ]),
      ).rejects.toThrow(/cannot be moved to another location/);
      // Everything else about either row is still hers to change.
      await asGina("update public.locations set name = 'First, renamed' where id = $1", [first]);
      await asGina("update public.tracked_queries set text = 'g1, reworded' where text = 'g1'");
      expect(
        await rows(
          "select count(*)::int as n from public.tracked_queries where location_id = $1 and is_active",
          [first],
        ),
      ).toEqual([{ n: 2 }]);

      await db.query("delete from public.tracked_queries where text = 'elsewhere'");
      await db.query("delete from public.memberships where user_id = $1 and organization_id = $2", [
        gina,
        orgId,
      ]);
    });

    afterAll(async () => {
      await db.query("delete from public.organizations where id = $1", [org]);
    });
  });

  it("are copied from a plan only by the worker", async () => {
    for (const [role, user] of [
      ["anon", null],
      ["authenticated", alice],
    ] as const) {
      await expect(
        as(role, user, () => db.query("select public.apply_plan($1, 'enterprise')", [orgId])),
      ).rejects.toThrow(/permission denied/);
    }
    const [bobs] = await as("authenticated", bob, () =>
      rows<{ id: string }>("select id from public.create_organization('Plan test')"),
    );
    const applied = (plan: string, locations: number | null) =>
      as("service_role", null, () =>
        rows<Record<string, unknown>>(
          "select plan_key, max_locations, max_queries_per_location, max_manual_scans_per_month, scan_every_days, emails_report, surfaces::text[] as surfaces from public.apply_plan($1, $2, $3)",
          [bobs?.id, plan, locations],
        ),
      );
    // More locations than the plan includes are the ones paid for; fewer never lowers it.
    expect((await applied("standard", 5))[0]).toEqual({
      plan_key: "standard",
      max_locations: 5,
      max_queries_per_location: 10,
      max_manual_scans_per_month: 10,
      scan_every_days: 2,
      emails_report: true,
      surfaces: ["chatgpt", "claude"],
    });
    expect((await applied("standard", 1))[0]).toMatchObject({ max_locations: 3 });
    // One assistant: ChatGPT unless the organization had already chosen its one.
    expect((await applied("starter", null))[0]).toMatchObject({ surfaces: ["chatgpt"] });
    await db.query("update public.organizations set surfaces = '{claude}' where id = $1", [
      bobs?.id,
    ]);
    expect((await applied("free", null))[0]).toMatchObject({
      plan_key: "free",
      surfaces: ["claude"],
      emails_report: false,
    });
    await expect(applied("no_such_plan", null)).rejects.toThrow(/no plan called/);
    await db.query("delete from public.organizations where id = $1", [bobs?.id]);
  });

  it("cannot be raised by a member, who can still rename the organization", async () => {
    for (const column of [
      "max_locations",
      "max_queries_per_location",
      "max_manual_scans_per_month",
    ]) {
      await expect(
        as("authenticated", alice, () =>
          db.query(`update public.organizations set ${column} = 999 where id = $1`, [orgId]),
        ),
        column,
      ).rejects.toThrow(/permission denied/);
    }
    const [renamed] = await as("authenticated", alice, () =>
      rows<{ name: string }>(
        "update public.organizations set name = 'Renamed' where id = $1 returning name",
        [orgId],
      ),
    );
    expect(renamed?.name).toBe("Renamed");
  });

  it("keep the trigger functions closed to callers", async () => {
    await expect(
      as("authenticated", alice, () => db.query("select public.enforce_location_limit()")),
    ).rejects.toThrow(/permission denied|trigger/);
  });
});

describe("plan settings", () => {
  let cadenceOrg = "";
  let cadenceLocation = "";
  const due = async () =>
    (
      await as("service_role", null, () =>
        rows<{ id: string }>("select public.locations_due_for_scan() as id"),
      )
    )
      .map((row) => row.id)
      .includes(cadenceLocation);
  const scannedHoursAgo = (hours: number) =>
    db.query(
      "update public.locations set last_scanned_at = now() - make_interval(hours => $1) where id = $2",
      [hours, cadenceLocation],
    );

  it("start a new organization on its plan's cadence", async () => {
    // Bob has no organization yet, so this one starts with nothing else in it.
    const [org] = await as("authenticated", bob, () =>
      rows<{ id: string; scan_every_days: number; surfaces: string[] | null }>(
        "select * from public.create_organization('Cadence Org')",
      ),
    );
    cadenceOrg = org?.id ?? "";
    // The free plan's cadence. The tests below are about cadence itself, so it is then set by
    // hand to every two days on every surface.
    expect(org).toMatchObject({ scan_every_days: 14, plan_key: "free" });
    await db.query(
      "update public.organizations set plan_key = null, scan_every_days = 2, surfaces = null, max_queries_per_location = 10 where id = $1",
      [cadenceOrg],
    );

    const [location] = await as("authenticated", bob, () =>
      rows<{ id: string }>(
        "insert into public.locations (organization_id, name, city) values ($1, 'Cadence Shop', 'Raleigh') returning id",
        [cadenceOrg],
      ),
    );
    cadenceLocation = location?.id ?? "";
    await as("authenticated", bob, () =>
      db.query(
        "insert into public.tracked_queries (location_id, kind, text) values ($1, 'ai_prompt', 'x')",
        [cadenceLocation],
      ),
    );
    expect(await due()).toBe(true);
  });

  it("scan a location as often as its organization's plan says", async () => {
    // Every two days: a scan 30 hours ago is too recent, one 45 hours ago is not.
    await scannedHoursAgo(30);
    expect(await due()).toBe(false);
    await scannedHoursAgo(45);
    expect(await due()).toBe(true);

    // Daily: the same 30 hours is now overdue, and 21 hours counts as a day.
    await db.query("update public.organizations set scan_every_days = 1 where id = $1", [
      cadenceOrg,
    ]);
    await scannedHoursAgo(30);
    expect(await due()).toBe(true);
    await scannedHoursAgo(21);
    expect(await due()).toBe(true);
    await scannedHoursAgo(10);
    expect(await due()).toBe(false);
  });

  it("let a location ask for less than its plan allows, or be paused, but never more", async () => {
    const setFrequency = (frequency: string) =>
      as("authenticated", bob, () =>
        db.query("update public.locations set scan_frequency = $1 where id = $2", [
          frequency,
          cadenceLocation,
        ]),
      );
    await scannedHoursAgo(72);
    await setFrequency("weekly");
    expect(await due()).toBe(false);
    await scannedHoursAgo(24 * 7);
    expect(await due()).toBe(true);
    await setFrequency("off");
    expect(await due()).toBe(false);

    // On a plan slower than daily, asking for daily changes nothing.
    await db.query("update public.organizations set scan_every_days = 5 where id = $1", [
      cadenceOrg,
    ]);
    await setFrequency("daily");
    await scannedHoursAgo(72);
    expect(await due()).toBe(false);
  });

  it("cannot be changed by a member", async () => {
    for (const change of ["scan_every_days = 1", "surfaces = array['chatgpt']::public.surface[]"]) {
      await expect(
        as("authenticated", bob, () =>
          db.query(`update public.organizations set ${change} where id = $1`, [cadenceOrg]),
        ),
        change,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("are read by members and nobody else", async () => {
    const select = "select surfaces from public.organizations where id = $1";
    expect(await as("authenticated", bob, () => rows(select, [cadenceOrg]))).toHaveLength(1);
    expect(await as("authenticated", alice, () => rows(select, [cadenceOrg]))).toHaveLength(0);
  });
});

describe("audits", () => {
  const part = JSON.stringify({ cells: [] });
  let auditId: string;
  let token: string;

  const read = (role: Role, userId: string | null, value: string) =>
    as(role, userId, async () => {
      const [row] = await rows<{ audit: Record<string, unknown> | null }>(
        "select public.get_audit($1) as audit",
        [value],
      );
      return row?.audit ?? null;
    });

  it("are created with the secret key, each with its own long token", async () => {
    const [audit] = await as("service_role", null, () =>
      rows<{ id: string; token: string; status: string; samples: number }>(
        `insert into public.audits (business_name, city, region, prompts)
         values ('Joe''s Pizza', 'Raleigh', 'NC', array['best pizza', 'late night food'])
         returning id, token, status, samples`,
      ),
    );
    expect(audit).toMatchObject({ status: "queued", samples: 5 });
    expect(audit?.token).toMatch(/^[0-9a-f]{64}$/);
    auditId = audit?.id ?? "";
    token = audit?.token ?? "";
  });

  it("cannot be read, listed, created or changed through the table by anyone else", async () => {
    for (const [role, user] of [
      ["anon", null],
      ["authenticated", alice],
    ] as const) {
      // Signed out, the table cannot even be asked. Signed in, it can, and answers nothing:
      // the only policy on it is the operator's.
      if (role === "anon") {
        await expect(as(role, user, () => db.query("select * from public.audits"))).rejects.toThrow(
          /permission denied/,
        );
      } else {
        expect(await as(role, user, () => rows("select * from public.audits"))).toEqual([]);
      }
      await expect(
        as(role, user, () =>
          db.query(
            "insert into public.audits (business_name, city, prompts) values ('x', 'y', array['z'])",
          ),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(role, user, () => db.query("update public.audits set revoked_at = null")),
      ).rejects.toThrow(/permission denied/);
      await expect(as(role, user, () => db.query("delete from public.audits"))).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it("are read by anyone holding the token, and only what the page shows", async () => {
    for (const [role, user] of [
      ["anon", null],
      ["authenticated", bob],
    ] as const) {
      const audit = await read(role, user, token);
      expect(audit).toMatchObject({
        business_name: "Joe's Pizza",
        city: "Raleigh",
        prompts: ["best pizza", "late night food"],
        samples: 5,
        status: "queued",
        parts: {},
      });
      expect(Object.keys(audit ?? {}).sort()).toEqual([
        "business_name",
        "city",
        "created_at",
        "expires_at",
        "parts",
        "prompts",
        "region",
        "samples",
        "status",
        "website",
      ]);
    }
  });

  it("answer nothing for a wrong token, the audit's ID, or a pattern", async () => {
    expect(await read("anon", null, "ab".repeat(32))).toBeNull();
    expect(await read("anon", null, auditId)).toBeNull();
    expect(await read("anon", null, "%")).toBeNull();
    expect(await read("anon", null, "")).toBeNull();
  });

  it("take results from the worker only", async () => {
    for (const [role, user] of [
      ["anon", null],
      ["authenticated", alice],
    ] as const) {
      await expect(
        as(role, user, () =>
          db.query("select public.record_audit_part($1, 0, $2::jsonb)", [auditId, part]),
        ),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("become ready when every prompt has reported, in any order, and a repeat changes nothing", async () => {
    const record = (index: number) =>
      as("service_role", null, () =>
        db.query("select public.record_audit_part($1, $2, $3::jsonb)", [auditId, index, part]),
      );

    await record(1);
    await record(1);
    expect(await read("anon", null, token)).toMatchObject({
      status: "queued",
      parts: { "1": { cells: [] } },
    });

    await record(0);
    const audit = await read("anon", null, token);
    expect(audit?.status).toBe("ready");
    expect(Object.keys((audit?.parts ?? {}) as object).sort()).toEqual(["0", "1"]);
  });

  it("recover from a failure when the retry succeeds", async () => {
    await as("service_role", null, () =>
      db.query("update public.audits set status = 'failed', error = 'upstream 503' where id = $1", [
        auditId,
      ]),
    );
    expect((await read("anon", null, token))?.status).toBe("failed");

    await as("service_role", null, () =>
      db.query("select public.record_audit_part($1, 0, $2::jsonb)", [auditId, part]),
    );
    const [row] = await as("service_role", null, () =>
      rows<{ status: string; error: string | null }>(
        "select status, error from public.audits where id = $1",
        [auditId],
      ),
    );
    expect(row).toEqual({ status: "ready", error: null });
  });

  it("refuse results for an audit that does not exist", async () => {
    await expect(
      as("service_role", null, () =>
        db.query("select public.record_audit_part($1, 0, $2::jsonb)", [alice, part]),
      ),
    ).rejects.toThrow(/not found/);
  });

  it("stop answering once revoked, and once expired", async () => {
    const set = (sql: string) =>
      as("service_role", null, () =>
        db.query(`update public.audits set ${sql} where id = $1`, [auditId]),
      );

    await set("revoked_at = now()");
    expect(await read("anon", null, token)).toBeNull();
    expect(await read("authenticated", alice, token)).toBeNull();

    await set("revoked_at = null, expires_at = now() - interval '1 second'");
    expect(await read("anon", null, token)).toBeNull();

    await set("expires_at = now() + interval '1 day'");
    expect(await read("anon", null, token)).not.toBeNull();
  });

  it("hold at most five prompts and five samples", async () => {
    const insert = (prompts: string, samples: number) =>
      as("service_role", null, () =>
        db.query(
          `insert into public.audits (business_name, city, prompts, samples)
           values ('x', 'y', ${prompts}, $1)`,
          [samples],
        ),
      );
    await expect(insert("array['a','b','c','d','e','f']", 5)).rejects.toThrow(/check constraint/);
    await expect(insert("array[]::text[]", 5)).rejects.toThrow(/check constraint/);
    await expect(insert("array['a']", 6)).rejects.toThrow(/check constraint/);
  });
});

describe("the website check on a scan", () => {
  const check = JSON.stringify({ url: "https://joes.example/", status: 200, checks: [] });

  it("is written by the worker and read by members only", async () => {
    await as("service_role", null, () =>
      db.query("update public.scans set site_check = $1::jsonb where id = $2", [check, scanId]),
    );
    const mine = await as("authenticated", alice, () =>
      rows<{ site_check: { status: number } | null }>(
        "select site_check from public.scans where id = $1",
        [scanId],
      ),
    );
    expect(mine[0]?.site_check?.status).toBe(200);
    expect(
      await as("authenticated", bob, () =>
        rows("select site_check from public.scans where id = $1", [scanId]),
      ),
    ).toEqual([]);
  });

  it("cannot be attached by a member when queuing a scan, nor changed after", async () => {
    await expect(
      as("authenticated", alice, () =>
        db.query(
          `insert into public.scans (location_id, trigger, requested_by, site_check)
           values ($1, 'manual', $2, $3::jsonb)`,
          [locationId, alice, check],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      as("authenticated", alice, () =>
        db.query("update public.scans set site_check = null where id = $1", [scanId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("platform roles and test organizations", () => {
  const robot = "e0000000-0000-4000-8000-000000000005";

  beforeAll(async () => {
    await db.query("insert into auth.users (id, email) values ($1, 'e2e@example.com')", [robot]);
    // The operator names a test account with the secret key. Nothing else can.
    await db.query("insert into public.platform_roles (user_id, role) values ($1, 'test')", [
      robot,
    ]);
  });

  it("cannot be granted, changed or removed by an account, for itself or anyone", async () => {
    for (const sql of [
      "insert into public.platform_roles (user_id, role) values ($1, 'operator')",
      "update public.platform_roles set role = 'operator' where user_id = $1",
      "delete from public.platform_roles where user_id = $1",
    ]) {
      await expect(
        as("authenticated", alice, () => db.query(sql, [alice])),
        sql,
      ).rejects.toThrow(/permission denied/);
      await expect(
        as("authenticated", robot, () => db.query(sql, [robot])),
        sql,
      ).rejects.toThrow(/permission denied/);
    }
    await expect(
      as("anon", null, () => db.query("select * from public.platform_roles")),
    ).rejects.toThrow(/permission denied/);
  });

  it("are readable only by the account they belong to", async () => {
    const mine = await as("authenticated", robot, () =>
      rows<{ role: string }>("select role from public.platform_roles"),
    );
    expect(mine).toEqual([{ role: "test" }]);
    // Alice has none, and cannot see that the robot has one.
    expect(
      await as("authenticated", alice, () => rows("select * from public.platform_roles")),
    ).toEqual([]);
  });

  it("make every organization a test account creates a test organization, with room to work", async () => {
    const [org] = await as("authenticated", robot, () =>
      rows<Record<string, unknown>>("select * from public.create_organization('Smoke test')"),
    );
    expect(org).toMatchObject({
      name: "Smoke test",
      is_test: true,
      max_locations: 25,
      max_queries_per_location: 25,
      max_manual_scans_per_month: 500,
      scan_every_days: 1,
    });
    // It is still an ordinary owner of it, so it is confined to it like anyone else.
    const seen = await as("authenticated", robot, () =>
      rows<{ is_test: boolean }>("select is_test from public.organizations"),
    );
    expect(seen).toEqual([{ is_test: true }]);
  });

  it("leave everyone else's organizations real, and out of their hands to change", async () => {
    const [mine] = await rows<{ is_test: boolean }>(
      "select is_test from public.organizations where id = $1",
      [orgId],
    );
    expect(mine?.is_test).toBe(false);
    for (const value of ["true", "false"]) {
      await expect(
        as("authenticated", alice, () =>
          db.query(`update public.organizations set is_test = ${value} where id = $1`, [orgId]),
        ),
      ).rejects.toThrow(/permission denied/);
    }
    const newcomer = "ab000000-0000-4000-8000-00000000ab01";
    await db.query("insert into auth.users (id, email) values ($1, 'newcomer@example.com')", [
      newcomer,
    ]);
    const [fresh] = await as("authenticated", newcomer, () =>
      rows<{ is_test: boolean }>("select is_test from public.create_organization('Newcomer''s')"),
    );
    expect(fresh?.is_test).toBe(false);
  });
});

describe("what scans used at the providers", () => {
  let usageId: string;

  it("is written by the worker, against the scan and its organization", async () => {
    const [row] = await rows<{ id: string }>(
      `insert into public.provider_usage
         (organization_id, scan_id, surface, model, calls, input_tokens, cached_input_tokens, output_tokens, searches)
       values ($1, $2, 'chatgpt', 'gpt-x', 2, 2000, 0, 100, 4)
       returning id`,
      [orgId, scanId],
    );
    usageId = row?.id ?? "";
    expect(usageId).not.toBe("");
  });

  it("cannot be read or written by a member, even for their own organization's scans", async () => {
    // A member may ask and is told nothing; a signed-out caller may not even ask.
    expect(
      await as("authenticated", alice, () => rows("select * from public.provider_usage")),
    ).toEqual([]);
    await expect(
      as("anon", null, () => db.query("select * from public.provider_usage")),
    ).rejects.toThrow(/permission denied/);
    for (const sql of [
      "insert into public.provider_usage (surface, model, calls, input_tokens, cached_input_tokens, output_tokens, searches) values ('chatgpt', 'x', 1, 1, 0, 1, 0)",
      "update public.provider_usage set calls = 1",
      "delete from public.provider_usage",
    ]) {
      await expect(
        as("authenticated", alice, () => db.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
      await expect(
        as("anon", null, () => db.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("outlives the scan it describes, because the money was still spent", async () => {
    await db.query("delete from public.scans where id = $1", [scanId]);
    const [row] = await rows<{ scan_id: string | null; organization_id: string; calls: number }>(
      "select scan_id, organization_id, calls from public.provider_usage where id = $1",
      [usageId],
    );
    expect(row).toEqual({ scan_id: null, organization_id: orgId, calls: 2 });
  });
});

describe("plans", () => {
  const keys = (role: Role, user: string | null) =>
    as(role, user, async () =>
      (await rows<{ key: string }>("select key from public.plans order by position")).map(
        (plan) => plan.key,
      ),
    );
  const onSale = ["free", "starter", "standard", "pro", "enterprise"];

  beforeAll(async () => {
    await db.query(
      `insert into public.plans
        (key, name, position, on_sale, price_cents, included_locations, max_queries_per_location,
         assistants, scan_every_days, max_manual_scans_per_month, emails_report)
       values ('retired', 'Retired', 9, false, 1900, 1, 3, 1, 7, 1, true)`,
    );
  });
  afterAll(async () => {
    await db.query("update public.organizations set plan_key = null where plan_key = 'retired'");
    await db.query("delete from public.plans where key = 'retired'");
  });

  it("shows everyone what is on sale, signed in or not, and nothing that is not", async () => {
    expect(await keys("anon", null)).toEqual(onSale);
    expect(await keys("authenticated", alice)).toEqual(onSale);
    const [standard] = await as("anon", null, () =>
      rows(
        "select price_cents, included_locations, extra_location_price_cents, assistants from public.plans where key = 'standard'",
      ),
    );
    expect(standard).toEqual({
      price_cents: 4900,
      included_locations: 3,
      extra_location_price_cents: 1500,
      assistants: 2,
    });
  });

  it("shows a plan that is off sale to the organizations still on it, and to no one else", async () => {
    await db.query("update public.organizations set plan_key = 'retired' where id = $1", [orgId]);
    expect(await keys("authenticated", alice)).toEqual([...onSale, "retired"]);
    expect(await keys("authenticated", bob)).toEqual(onSale);
    expect(await keys("anon", null)).toEqual(onSale);
  });

  it("cannot be changed through the API by anyone", async () => {
    for (const sql of [
      "update public.plans set price_cents = 0",
      "delete from public.plans",
      "insert into public.plans (key, name, position, price_cents, included_locations, max_queries_per_location, assistants, scan_every_days, max_manual_scans_per_month, emails_report) values ('mine', 'Mine', 5, 0, 99, 99, 2, 1, 99, true)",
    ]) {
      for (const [role, user] of [
        ["anon", null],
        ["authenticated", alice],
      ] as const) {
        await expect(
          as(role, user, () => db.query(sql)),
          sql,
        ).rejects.toThrow(/permission denied/);
      }
    }
  });

  it("is not something an owner can put their own organization on", async () => {
    await expect(
      as("authenticated", alice, () =>
        db.query("update public.organizations set plan_key = 'enterprise' where id = $1", [orgId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("subscriptions", () => {
  const member = "c1000000-0000-4000-8000-000000000031";
  const state = (user: string | null, role: Role = "authenticated") =>
    as(role, user, () => rows("select * from public.billing_state($1)", [orgId]));

  beforeAll(async () => {
    await db.query("insert into auth.users (id, email) values ($1, 'member@example.com')", [
      member,
    ]);
    await db.query(
      "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'member')",
      [orgId, member],
    );
  });
  afterAll(async () => {
    await db.query("delete from public.subscriptions where organization_id = $1", [orgId]);
    await db.query("delete from public.memberships where user_id = $1", [member]);
  });

  it("tells an owner where their organization stands before it has ever subscribed", async () => {
    const [organization] = await rows<{ plan_key: string | null; is_test: boolean }>(
      "select plan_key, is_test from public.organizations where id = $1",
      [orgId],
    );
    expect(await state(alice)).toEqual([
      {
        organization_id: orgId,
        is_test: organization?.is_test,
        plan_key: organization?.plan_key,
        stripe_customer_id: null,
        stripe_subscription_id: null,
        status: null,
      },
    ]);
  });

  it("are written by the worker and read back by the owner", async () => {
    await as("service_role", null, () =>
      db.query(
        "insert into public.subscriptions (organization_id, stripe_customer_id, stripe_subscription_id, status) values ($1, 'cus_1', 'sub_1', 'active')",
        [orgId],
      ),
    );
    expect(await state(alice)).toMatchObject([
      { stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", status: "active" },
    ]);
  });

  it("tell a member who is not the owner, a stranger and a visitor nothing", async () => {
    expect(await state(member)).toEqual([]);
    expect(await state(bob)).toEqual([]);
    await expect(state(null, "anon")).rejects.toThrow(/permission denied/);
  });

  it("cannot be read from the table by a member, or by anyone not signed in", async () => {
    for (const user of [alice, member, bob]) {
      const seen = await as("authenticated", user, () =>
        rows("select * from public.subscriptions"),
      );
      expect(seen, user).toEqual([]);
    }
    await expect(
      as("anon", null, () => db.query("select * from public.subscriptions")),
    ).rejects.toThrow(/permission denied/);
  });

  it("cannot be written through the API, so nobody grants themselves a subscription", async () => {
    for (const sql of [
      "insert into public.subscriptions (organization_id, stripe_customer_id) values ($1, 'cus_mine')",
      "update public.subscriptions set status = 'active' where organization_id = $1",
      "delete from public.subscriptions where organization_id = $1",
    ]) {
      for (const [role, user] of [
        ["anon", null],
        ["authenticated", alice],
        ["authenticated", bob],
      ] as const) {
        await expect(
          as(role, user, () => db.query(sql, [orgId])),
          sql,
        ).rejects.toThrow(/permission denied/);
      }
    }
  });
});

describe("the operator", () => {
  const operator = "f0000000-0000-4000-8000-000000000006";
  const tables = [
    "organizations",
    "memberships",
    "locations",
    "tracked_queries",
    "scans",
    "scan_results",
    "recommendations",
    "platform_roles",
    "audits",
    "provider_usage",
    "subscriptions",
  ];
  const count = async (role: Role, user: string | null, table: string) =>
    Number(
      (
        await as(role, user, () => rows<{ n: string }>(`select count(*) as n from public.${table}`))
      )[0]?.n,
    );
  const everything = new Map<string, number>();
  let own: string;
  /** A customer's organization, with one of everything in it. */
  let theirs: string;

  beforeAll(async () => {
    await db.query("insert into auth.users (id, email) values ($1, 'operator@example.com')", [
      operator,
    ]);
    // A customer with one of everything, so every table has a row that is not the operator's.
    const [customer] = await rows<{ id: string }>(
      "insert into public.organizations (name, created_by) values ('A customer', $1) returning id",
      [alice],
    );
    theirs = customer?.id ?? "";
    await db.query(
      "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'owner')",
      [theirs, alice],
    );
    const [location] = await rows<{ id: string }>(
      "insert into public.locations (organization_id, name, city) values ($1, 'Operator Test', 'Raleigh') returning id",
      [theirs],
    );
    const [query] = await rows<{ id: string }>(
      "insert into public.tracked_queries (location_id, kind, text) values ($1, 'ai_prompt', 'x') returning id",
      [location?.id],
    );
    const [scan] = await rows<{ id: string }>(
      "insert into public.scans (location_id, trigger, status) values ($1, 'scheduled', 'succeeded') returning id",
      [location?.id],
    );
    await db.query(
      "insert into public.scan_results (scan_id, tracked_query_id, surface, mentioned) values ($1, $2, 'chatgpt', true)",
      [scan?.id, query?.id],
    );
    await db.query(
      "insert into public.recommendations (location_id, rule, title, detail) values ($1, 'operator:test', 't', 'd')",
      [location?.id],
    );
    await db.query(
      "insert into public.audits (business_name, city, prompts) values ('Operator Test', 'Raleigh', array['x'])",
    );
    await db.query(
      `insert into public.provider_usage
         (organization_id, scan_id, surface, model, calls, input_tokens, cached_input_tokens, output_tokens, searches)
       values ($1, $2, 'chatgpt', 'gpt-x', 1, 1, 0, 1, 0)`,
      [theirs, scan?.id],
    );
    await db.query(
      "insert into public.subscriptions (organization_id, stripe_customer_id) values ($1, 'cus_operator_test')",
      [theirs],
    );
    for (const table of tables) everything.set(table, await count("service_role", null, table));
  });

  it("is an ordinary account, seeing only its own organization, until it is named operator", async () => {
    const [mine] = await as("authenticated", operator, () =>
      rows<{ id: string }>("select id from public.create_organization('The operator''s own')"),
    );
    own = mine?.id ?? "";
    everything.set("organizations", (everything.get("organizations") ?? 0) + 1);
    everything.set("memberships", (everything.get("memberships") ?? 0) + 1);

    expect(await count("authenticated", operator, "organizations")).toBe(1);
    expect(await count("authenticated", operator, "locations")).toBe(0);
    expect(await count("authenticated", operator, "audits")).toBe(0);
    expect(await count("authenticated", operator, "provider_usage")).toBe(0);
  });

  it("reads every row of every table once named", async () => {
    await db.query("insert into public.platform_roles (user_id, role) values ($1, 'operator')", [
      operator,
    ]);
    everything.set("platform_roles", (everything.get("platform_roles") ?? 0) + 1);

    for (const table of tables) {
      const all = everything.get(table) ?? 0;
      expect(all, `${table} has rows to find`).toBeGreaterThan(0);
      expect(await count("authenticated", operator, table), table).toBe(all);
    }
  });

  it("still belongs only to its own organization", async () => {
    const mine = await as("authenticated", operator, () =>
      rows<{ id: string }>("select id from public.my_organizations()"),
    );
    expect(mine).toEqual([{ id: own }]);
    // And an ordinary member's list is theirs alone, as before.
    const alices = await as("authenticated", alice, () =>
      rows<{ id: string }>("select id from public.my_organizations()"),
    );
    expect(alices.map((row) => row.id).sort()).toEqual([orgId, theirs].sort());
  });

  it("can change nothing that is not its own", async () => {
    // Statements the grants allow reach the policies, which match no row of someone else's.
    for (const sql of [
      "update public.organizations set name = 'Defaced' where id = $1",
      "update public.locations set name = 'Defaced' where organization_id = $1",
      "delete from public.locations where organization_id = $1",
      "delete from public.memberships where organization_id = $1",
    ]) {
      const result = await as("authenticated", operator, () => db.query(sql, [theirs]));
      expect(result.affectedRows, sql).toBe(0);
    }
    // Statements the policies check on the way in are refused.
    for (const sql of [
      "insert into public.locations (organization_id, name, city) values ($1, 'Planted', 'x')",
      "insert into public.memberships (organization_id, user_id, role) values ($1, 'f0000000-0000-4000-8000-000000000006', 'owner')",
    ]) {
      await expect(
        as("authenticated", operator, () => db.query(sql, [theirs])),
        sql,
      ).rejects.toThrow(/row-level security/);
    }
    // And the tables no API role may write stay that way.
    for (const sql of [
      "update public.audits set revoked_at = now()",
      "delete from public.provider_usage",
      "update public.scans set status = 'failed'",
      "insert into public.platform_roles (user_id, role) values ('a0000000-0000-4000-8000-000000000001', 'operator')",
      "update public.organizations set is_test = true",
      "delete from public.organizations",
      "update public.subscriptions set status = 'active'",
      "delete from public.subscriptions",
    ]) {
      await expect(
        as("authenticated", operator, () => db.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
    }
    const [name] = await rows<{ name: string }>(
      "select name from public.organizations where id = $1",
      [theirs],
    );
    expect(name?.name).not.toBe("Defaced");
  });

  it("gives nobody else its reach", async () => {
    // The test account has a platform role too, and it is not this one.
    const robot = "e0000000-0000-4000-8000-000000000005";
    for (const user of [alice, bob, robot]) {
      expect(
        await as("authenticated", user, () =>
          rows<{ ok: boolean }>("select public.is_operator() as ok"),
        ),
      ).toEqual([{ ok: false }]);
      expect(await count("authenticated", user, "audits")).toBe(0);
      expect(await count("authenticated", user, "provider_usage")).toBe(0);
    }
    await expect(as("anon", null, () => db.query("select public.is_operator()"))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("lists every account for the operator, and none for anyone else", async () => {
    await db.query("update auth.users set last_sign_in_at = now() where id = $1", [alice]);
    const everyone = await as("authenticated", operator, () =>
      rows<{ user_id: string; email: string; created_at: string; last_sign_in_at: string | null }>(
        "select * from public.operator_accounts()",
      ),
    );
    const all = await rows<{ n: string }>("select count(*) as n from auth.users");
    expect(everyone).toHaveLength(Number(all[0]?.n));
    const hers = everyone.find((account) => account.user_id === alice);
    expect(hers).toMatchObject({ email: "alice@example.com" });
    expect(hers?.created_at).toBeTruthy();
    expect(hers?.last_sign_in_at).not.toBeNull();
    expect(everyone.find((account) => account.user_id === bob)?.last_sign_in_at).toBeNull();

    // A member, and the test account, get no rows, not even their own.
    for (const user of [alice, bob, "e0000000-0000-4000-8000-000000000005"]) {
      expect(
        await as("authenticated", user, () => rows("select * from public.operator_accounts()")),
      ).toEqual([]);
    }
    await expect(
      as("anon", null, () => db.query("select * from public.operator_accounts()")),
    ).rejects.toThrow(/permission denied/);
    // And the table behind it stays out of reach, for the operator too.
    await expect(
      as("authenticated", operator, () => db.query("select * from auth.users")),
    ).rejects.toThrow(/permission denied/);
  });

  it("adds up what was used by month for the operator, and for nobody else", async () => {
    const insert = `insert into public.provider_usage
      (organization_id, audit_id, surface, model, calls, input_tokens, cached_input_tokens, output_tokens, searches, created_at)
      values ($1, $2, 'chatgpt', 'spend-test', $3, 100, 10, 50, 2, $4)`;
    const [audit] = await rows<{ id: string }>("select id from public.audits limit 1");
    // The last second of September and the first of October, in UTC, are different months.
    await db.query(insert, [theirs, null, 2, "2026-09-30T23:59:59Z"]);
    await db.query(insert, [theirs, null, 1, "2026-10-01T00:00:00Z"]);
    await db.query(insert, [theirs, null, 4, "2026-10-20T12:00:00Z"]);
    await db.query(insert, [null, audit?.id, 3, "2026-10-05T12:00:00Z"]);
    // Before the date asked for, so not counted.
    await db.query(insert, [theirs, null, 9, "2026-08-31T12:00:00Z"]);

    const sql =
      "select month, organization_id, is_audit, calls::int, input_tokens::int, searches::int from public.usage_by_month('2026-09-01T00:00:00Z') where model = 'spend-test' order by month, is_audit";
    expect(await as("authenticated", operator, () => rows(sql))).toEqual([
      {
        month: "2026-09",
        organization_id: theirs,
        is_audit: false,
        calls: 2,
        input_tokens: 100,
        searches: 2,
      },
      {
        month: "2026-10",
        organization_id: theirs,
        is_audit: false,
        calls: 5,
        input_tokens: 200,
        searches: 4,
      },
      {
        month: "2026-10",
        organization_id: null,
        is_audit: true,
        calls: 3,
        input_tokens: 100,
        searches: 2,
      },
    ]);
    // A member is told nothing, not even about their own organization's scans.
    for (const user of [alice, bob]) {
      expect(await as("authenticated", user, () => rows(sql)), user).toEqual([]);
    }
    await expect(as("anon", null, () => db.query(sql))).rejects.toThrow(/permission denied/);
    await db.query("delete from public.provider_usage where model = 'spend-test'");
  });

  describe("changing a plan", () => {
    const setPlan =
      "select * from public.operator_set_plan('starter', ' Starter Plus ', true, 7, 2, 1, 4, false)";
    const starter = () =>
      rows<Record<string, unknown>>(
        "select name, on_sale, max_queries_per_location, assistants, scan_every_days, max_manual_scans_per_month, emails_report, price_cents, included_locations from public.plans where key = 'starter'",
      );
    const limits = (id: string) =>
      rows<Record<string, unknown>>(
        "select plan_key, max_locations, max_queries_per_location, max_manual_scans_per_month, scan_every_days, emails_report, array_to_string(surfaces, ',') as surfaces from public.organizations where id = $1",
        [id],
      );
    let before: Record<string, unknown>[];
    let byHand: string;

    beforeAll(async () => {
      before = await starter();
      // One organization on the plan, paying for a location more than it includes, and one
      // whose limits were set by hand.
      await db.query("select public.apply_plan($1, 'starter', 2)", [theirs]);
      const [other] = await rows<{ id: string }>(
        "insert into public.organizations (name, created_by, max_queries_per_location) values ('Set by hand', $1, 33) returning id",
        [alice],
      );
      byHand = other?.id ?? "";
    });
    afterAll(async () => {
      await db.query(
        "update public.plans set name = 'Starter', max_queries_per_location = 5, assistants = 1, scan_every_days = 2, max_manual_scans_per_month = 2, emails_report = true where key = 'starter'",
      );
      await db.query("update public.organizations set plan_key = null where id = $1", [theirs]);
      await db.query("delete from public.organizations where id = $1", [byHand]);
      await db.query("delete from public.operator_actions where action = 'set_plan'");
    });

    it("is refused to everyone else", async () => {
      const organization = await limits(theirs);
      for (const user of [alice, bob, "e0000000-0000-4000-8000-000000000005"]) {
        expect(await as("authenticated", user, () => rows(setPlan)), user).toEqual([]);
      }
      await expect(as("anon", null, () => db.query(setPlan))).rejects.toThrow(/permission denied/);
      expect(await starter()).toEqual(before);
      expect(await limits(theirs)).toEqual(organization);
    });

    it("changes what the plan allows, and neither its price nor the locations it includes", async () => {
      const [after] = await as("authenticated", operator, () =>
        rows<Record<string, unknown>>(setPlan),
      );
      expect(after).toMatchObject({ key: "starter", name: "Starter Plus" });
      expect(await starter()).toEqual([
        {
          ...before[0],
          name: "Starter Plus",
          max_queries_per_location: 7,
          assistants: 2,
          scan_every_days: 1,
          max_manual_scans_per_month: 4,
          emails_report: false,
        },
      ]);
    });

    it("reaches every organization on the plan at once, which keeps the locations it pays for", async () => {
      expect(await limits(theirs)).toEqual([
        {
          plan_key: "starter",
          max_locations: 2,
          max_queries_per_location: 7,
          max_manual_scans_per_month: 4,
          scan_every_days: 1,
          emails_report: false,
          surfaces: "chatgpt,claude",
        },
      ]);
    });

    it("leaves an organization whose limits were set by hand alone", async () => {
      expect(await limits(byHand)).toMatchObject([
        { plan_key: null, max_queries_per_location: 33 },
      ]);
    });

    it("writes down who changed which plan from what to what", async () => {
      const recorded = await rows<{ actor_id: string; organization_id: null; detail: unknown }>(
        "select actor_id, organization_id, detail from public.operator_actions where action = 'set_plan'",
      );
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        actor_id: operator,
        organization_id: null,
        detail: {
          plan: "starter",
          from: { name: "Starter", max_queries_per_location: 5, assistants: 1 },
          to: { name: "Starter Plus", max_queries_per_location: 7, assistants: 2 },
        },
      });
    });

    it("will not take the free plan off sale, and records nothing when it refuses", async () => {
      await expect(
        as("authenticated", operator, () =>
          db.query(
            "select * from public.operator_set_plan('free', 'Free', false, 2, 1, 14, 0, false)",
          ),
        ),
      ).rejects.toThrow(/free plan stays on sale/);
      const [free] = await rows<{ on_sale: boolean }>(
        "select on_sale from public.plans where key = 'free'",
      );
      expect(free?.on_sale).toBe(true);
    });

    it("returns nothing for a plan that does not exist, and records nothing", async () => {
      const none = await as("authenticated", operator, () =>
        rows("select * from public.operator_set_plan('nonesuch', 'x', true, 1, 1, 1, 1, true)"),
      );
      expect(none).toEqual([]);
      const recorded = await rows(
        "select 1 from public.operator_actions where action = 'set_plan'",
      );
      expect(recorded).toHaveLength(1);
    });
  });

  describe("changing an organization's limits", () => {
    const setLimits = "select * from public.operator_set_limits($1, 3, 20, 10, 1)";
    const limits = (id: string) =>
      rows<Record<string, number>>(
        "select max_locations, max_queries_per_location, max_manual_scans_per_month, scan_every_days from public.organizations where id = $1",
        [id],
      );
    const actions = () =>
      rows<{ actor_id: string; organization_id: string; action: string; detail: unknown }>(
        "select actor_id, organization_id, action, detail from public.operator_actions order by created_at",
      );

    it("is refused to everyone else, the organization's owner included", async () => {
      const before = await limits(theirs);
      for (const user of [alice, bob, "e0000000-0000-4000-8000-000000000005"]) {
        expect(await as("authenticated", user, () => rows(setLimits, [theirs])), user).toEqual([]);
      }
      await expect(as("anon", null, () => db.query(setLimits, [theirs]))).rejects.toThrow(
        /permission denied/,
      );
      expect(await limits(theirs)).toEqual(before);
      expect(await actions()).toEqual([]);
    });

    it("changes the four limits and nothing else, and writes down what it did", async () => {
      await db.query("update public.organizations set plan_key = 'standard' where id = $1", [
        theirs,
      ]);
      const [before] = await rows<Record<string, unknown>>(
        "select * from public.organizations where id = $1",
        [theirs],
      );
      const [after] = await as("authenticated", operator, () =>
        rows<Record<string, unknown>>(setLimits, [theirs]),
      );
      const changed = {
        // Limits set by hand take the organization off its plan, so nothing puts them back.
        plan_key: null,
        max_locations: 3,
        max_queries_per_location: 20,
        max_manual_scans_per_month: 10,
        scan_every_days: 1,
      };
      expect(after).toEqual({ ...before, ...changed });
      expect(await actions()).toEqual([
        {
          actor_id: operator,
          organization_id: theirs,
          action: "set_limits",
          detail: {
            from: {
              plan_key: "standard",
              max_locations: before?.max_locations,
              max_queries_per_location: before?.max_queries_per_location,
              max_manual_scans_per_month: before?.max_manual_scans_per_month,
              scan_every_days: before?.scan_every_days,
            },
            to: changed,
          },
        },
      ]);
    });

    it("answers nothing for an organization that does not exist, and records nothing", async () => {
      expect(
        await as("authenticated", operator, () =>
          rows(setLimits, ["00000000-0000-4000-8000-00000000dead"]),
        ),
      ).toEqual([]);
      expect(await actions()).toHaveLength(1);
    });

    it("keeps the columns' own bounds", async () => {
      await expect(
        as("authenticated", operator, () =>
          db.query("select * from public.operator_set_limits($1, 1, 10, 5, 0)", [theirs]),
        ),
      ).rejects.toThrow(/check constraint/);
      expect(await actions()).toHaveLength(1);
    });

    it("keeps its record readable by the operator alone and writable by no one", async () => {
      expect(
        await as("authenticated", alice, () => rows("select * from public.operator_actions")),
      ).toEqual([]);
      await expect(
        as("anon", null, () => db.query("select * from public.operator_actions")),
      ).rejects.toThrow(/permission denied/);
      expect(
        await as("authenticated", operator, () => rows("select * from public.operator_actions")),
      ).toHaveLength(1);
      for (const sql of [
        "insert into public.operator_actions (action) values ('planted')",
        "update public.operator_actions set action = 'edited'",
        "delete from public.operator_actions",
      ]) {
        for (const user of [alice, operator]) {
          await expect(
            as("authenticated", user, () => db.query(sql)),
            sql,
          ).rejects.toThrow(/permission denied/);
        }
      }
    });
  });

  describe("making an audit", () => {
    const create =
      "select id, token, business_name, website, region, country_code, prompts, samples, status from public.operator_create_audit('Joe''s Pizza', 'https://joes.example/', 'Raleigh', null, 'US', array['best pizza', 'late night food'], 2)";
    const audits = async () =>
      Number((await rows<{ n: string }>("select count(*) as n from public.audits"))[0]?.n);

    it("is refused to everyone else", async () => {
      const before = await audits();
      for (const user of [alice, bob, "e0000000-0000-4000-8000-000000000005"]) {
        expect(await as("authenticated", user, () => rows(create)), user).toEqual([]);
      }
      await expect(as("anon", null, () => db.query(create))).rejects.toThrow(/permission denied/);
      expect(await audits()).toBe(before);
    });

    it("makes a queued audit with a token, and writes down that it did", async () => {
      const before = await audits();
      const [made] = await as("authenticated", operator, () =>
        rows<Record<string, unknown>>(create),
      );
      expect(made).toMatchObject({
        business_name: "Joe's Pizza",
        website: "https://joes.example/",
        region: null,
        country_code: "US",
        prompts: ["best pizza", "late night food"],
        samples: 2,
        status: "queued",
      });
      expect(made?.token).toMatch(/^[0-9a-f]{64}$/);
      expect(await audits()).toBe(before + 1);
      const [action] = await rows<Record<string, unknown>>(
        "select actor_id, organization_id, detail from public.operator_actions where action = 'create_audit'",
      );
      expect(action).toEqual({
        actor_id: operator,
        organization_id: null,
        detail: { audit_id: made?.id, business_name: "Joe's Pizza", prompts: 2, samples: 2 },
      });
    });

    it("keeps the table's own bounds, and still cannot write the table itself", async () => {
      const before = await audits();
      await expect(
        as("authenticated", operator, () =>
          db.query(
            "select * from public.operator_create_audit('Joe''s', null, 'Raleigh', null, 'US', array['a'], 9)",
          ),
        ),
      ).rejects.toThrow(/check constraint/);
      await expect(
        as("authenticated", operator, () =>
          db.query(
            "insert into public.audits (business_name, city, prompts) values ('Planted', 'x', array['a'])",
          ),
        ),
      ).rejects.toThrow(/permission denied/);
      expect(await audits()).toBe(before);
    });
  });
});
