import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { ALLOWANCE_KINDS } from "@nearcited/shared";
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

  it("lets a member say the work was done, at the database's time, and nobody else", async () => {
    const acted = async () =>
      (
        await rows<{ acted_at: Date | null }>(
          "select acted_at from public.recommendations where location_id = $1 and rule = 'add_website'",
          [locationId],
        )
      )[0]?.acted_at ?? null;
    const mark = (who: string, value: string) =>
      as("authenticated", who, () =>
        db.query(
          `update public.recommendations set acted_at = ${value} where location_id = $1 and rule = 'add_website'`,
          [locationId],
        ),
      );

    // A non-member's update finds no row.
    await mark(bob, "now()");
    expect(await acted()).toBeNull();

    // A member cannot choose the day: whatever is sent, the time is now.
    await mark(alice, "'2020-01-01T00:00:00Z'");
    const stamped = await acted();
    expect(stamped).not.toBeNull();
    expect(Date.now() - (stamped?.getTime() ?? 0)).toBeLessThan(60_000);

    // A scan leaves it alone, whether the rule fires again or has stopped.
    for (const rules of [["add_website"], []]) {
      await as("service_role", null, () =>
        db.query("select public.complete_scan($1, 0, $2::jsonb, $3::jsonb)", [
          scanId,
          results(false),
          JSON.stringify(rules.map(recommendation)),
        ]),
      );
      expect((await acted())?.getTime()).toBe(stamped?.getTime());
    }

    await mark(alice, "null");
    expect(await acted()).toBeNull();
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

  it("are claimed for the thanks once each, and only by the worker", async () => {
    const claim = (subscription: string, role: Role = "service_role", user: string | null = null) =>
      as(role, user, () =>
        rows<{ claimed: boolean }>("select public.claim_subscription_start($1, $2) as claimed", [
          orgId,
          subscription,
        ]),
      );
    expect(await claim("sub_1")).toEqual([{ claimed: true }]);
    expect(await claim("sub_1")).toEqual([{ claimed: false }]);
    expect(await claim("sub_2")).toEqual([{ claimed: true }]);
    for (const [role, user] of [
      ["anon", null],
      ["authenticated", alice],
      ["authenticated", bob],
    ] as const) {
      await expect(claim("sub_3", role, user)).rejects.toThrow(/permission denied/);
    }
    // An organization that has never been through checkout has nothing to claim.
    const none = await as("service_role", null, () =>
      rows<{ claimed: boolean }>("select public.claim_subscription_start($1, 'sub_1') as claimed", [
        "00000000-0000-4000-8000-000000000000",
      ]),
    );
    expect(none).toEqual([{ claimed: false }]);
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

  describe("changing a plan's prices", () => {
    const setPrices =
      "select * from public.operator_set_plan_prices('pro', 14900, 3900, 'price_pro_2', 'price_pro_location_2')";
    const pro = () =>
      rows<Record<string, unknown>>(
        "select price_cents, extra_location_price_cents, stripe_price_id, stripe_extra_location_price_id, name, max_queries_per_location from public.plans where key = 'pro'",
      );
    const versions = (role: Role, user: string | null) =>
      as(role, user, () =>
        rows<Record<string, unknown>>(
          "select price_cents, extra_location_price_cents, stripe_price_id, stripe_extra_location_price_id from public.plan_prices where plan_key = 'pro' order by created_at",
        ),
      );
    let before: Record<string, unknown>[];

    beforeAll(async () => {
      before = await pro();
    });
    afterAll(async () => {
      await db.query("delete from public.plan_prices where plan_key = 'pro'");
      await db.query(
        "update public.plans set price_cents = $1, extra_location_price_cents = $2, stripe_price_id = null, stripe_extra_location_price_id = null where key = 'pro'",
        [before[0]?.price_cents, before[0]?.extra_location_price_cents],
      );
      await db.query("delete from public.operator_actions where action = 'set_plan_prices'");
    });

    it("is refused to everyone else", async () => {
      for (const user of [alice, bob, "e0000000-0000-4000-8000-000000000005"]) {
        expect(await as("authenticated", user, () => rows(setPrices)), user).toEqual([]);
      }
      await expect(as("anon", null, () => db.query(setPrices))).rejects.toThrow(
        /permission denied/,
      );
      expect(await pro()).toEqual(before);
      expect(await versions("service_role", null)).toEqual([]);
    });

    it("puts the new prices on the plan, keeps the version, and changes nothing else about it", async () => {
      const [after] = await as("authenticated", operator, () =>
        rows<Record<string, unknown>>(setPrices),
      );
      const now = {
        price_cents: 14900,
        extra_location_price_cents: 3900,
        stripe_price_id: "price_pro_2",
        stripe_extra_location_price_id: "price_pro_location_2",
      };
      expect(after).toMatchObject({ key: "pro", ...now });
      expect(await pro()).toEqual([{ ...before[0], ...now }]);
      expect(await versions("service_role", null)).toEqual([now]);
    });

    it("keeps every version, so a subscriber on an older price is still recognised", async () => {
      await as("authenticated", operator, () =>
        db.query(
          "select * from public.operator_set_plan_prices('pro', 15900, null, 'price_pro_3', null)",
        ),
      );
      const kept = await versions("authenticated", alice);
      expect(kept.map((version) => version.stripe_price_id)).toEqual([
        "price_pro_2",
        "price_pro_3",
      ]);
      expect(kept[1]).toMatchObject({
        extra_location_price_cents: null,
        stripe_extra_location_price_id: null,
      });
    });

    it("is read by anyone signed in, by no visitor, and written through the API by nobody", async () => {
      expect(await versions("authenticated", bob)).toHaveLength(2);
      await expect(versions("anon", null)).rejects.toThrow(/permission denied/);
      for (const sql of [
        "insert into public.plan_prices (plan_key, price_cents, stripe_price_id) values ('pro', 100, 'price_mine')",
        "update public.plan_prices set price_cents = 100",
        "delete from public.plan_prices",
      ]) {
        for (const user of [alice, operator]) {
          await expect(
            as("authenticated", user, () => db.query(sql)),
            sql,
          ).rejects.toThrow(/permission denied/);
        }
      }
    });

    it("writes down what the prices were and what they became", async () => {
      const recorded = await rows<{ actor_id: string; detail: unknown }>(
        "select actor_id, detail from public.operator_actions where action = 'set_plan_prices' order by created_at",
      );
      expect(recorded).toHaveLength(2);
      expect(recorded[0]).toMatchObject({
        actor_id: operator,
        detail: {
          plan: "pro",
          from: { price_cents: before[0]?.price_cents, stripe_price_id: null },
          to: { price_cents: 14900, stripe_price_id: "price_pro_2" },
        },
      });
    });

    it("has no price to set for the free plan, and no plan to set one for that does not exist", async () => {
      await expect(
        as("authenticated", operator, () =>
          db.query(
            "select * from public.operator_set_plan_prices('free', 500, null, 'price_free', null)",
          ),
        ),
      ).rejects.toThrow(/free plan has no price/);
      const none = await as("authenticated", operator, () =>
        rows(
          "select * from public.operator_set_plan_prices('nonesuch', 500, null, 'price_x', null)",
        ),
      );
      expect(none).toEqual([]);
      expect(
        await rows(
          "select 1 from public.plan_prices where stripe_price_id in ('price_free', 'price_x')",
        ),
      ).toEqual([]);
    });
  });

  describe("announcing a price change", () => {
    const announce = (plan: string, days: number) =>
      `select * from public.operator_announce_price_change('${plan}', now() + interval '${days} days')`;
    const callOff = "select * from public.operator_call_off_price_change('pro')";
    const open = () =>
      rows<Record<string, unknown>>(
        "select plan_key, stripe_price_id, called_off_at is not null as called_off from public.price_changes where called_off_at is null and completed_at is null",
      );
    let changeId: string;

    beforeAll(async () => {
      // Pro was sold at one price, and is now sold at a higher one.
      await db.query(
        "insert into public.plan_prices (plan_key, price_cents, extra_location_price_cents, stripe_price_id, stripe_extra_location_price_id, created_at) values ('pro', 9900, 2500, 'price_pro_a', 'price_pro_a_loc', now() - interval '1 day')",
      );
      await as("authenticated", operator, () =>
        db.query(
          "select * from public.operator_set_plan_prices('pro', 12900, 3500, 'price_pro_b', 'price_pro_b_loc')",
        ),
      );
    });
    afterAll(async () => {
      await db.query("delete from public.price_changes");
      await db.query("delete from public.plan_prices where plan_key = 'pro'");
      await db.query(
        "update public.plans set stripe_price_id = null, stripe_extra_location_price_id = null where key = 'pro'",
      );
      await db.query(
        "delete from public.operator_actions where action in ('set_plan_prices', 'announce_price_change', 'call_off_price_change')",
      );
    });

    it("is refused to everyone else", async () => {
      for (const user of [alice, bob]) {
        expect(await as("authenticated", user, () => rows(announce("pro", 45))), user).toEqual([]);
        expect(await as("authenticated", user, () => rows(callOff)), user).toEqual([]);
      }
      await expect(as("anon", null, () => db.query(announce("pro", 45)))).rejects.toThrow(
        /permission denied/,
      );
      expect(await open()).toEqual([]);
    });

    it("will not put a price up with less than thirty days' notice, or for a day gone by", async () => {
      await expect(
        as("authenticated", operator, () => db.query(announce("pro", 29))),
      ).rejects.toThrow(/at least 30 days/);
      await expect(
        as("authenticated", operator, () => db.query(announce("pro", -3))),
      ).rejects.toThrow(/30 days|not passed/);
      expect(await open()).toEqual([]);
    });

    it("has nothing to announce for a plan with no price at the payment provider", async () => {
      await expect(
        as("authenticated", operator, () => db.query(announce("enterprise", 45))),
      ).rejects.toThrow(/no price at the payment provider/);
      expect(await as("authenticated", operator, () => rows(announce("nonesuch", 45)))).toEqual([]);
    });

    it("records the plan's present prices as what subscribers move to, and who announced it", async () => {
      const [change] = await as("authenticated", operator, () =>
        rows<{ id: string; stripe_price_id: string }>(announce("pro", 45)),
      );
      changeId = change?.id ?? "";
      expect(change?.stripe_price_id).toBe("price_pro_b");
      expect(await open()).toEqual([
        { plan_key: "pro", stripe_price_id: "price_pro_b", called_off: false },
      ]);
      const [recorded] = await rows<{ actor_id: string; detail: unknown }>(
        "select actor_id, detail from public.operator_actions where action = 'announce_price_change'",
      );
      expect(recorded).toMatchObject({
        actor_id: operator,
        detail: { plan: "pro", price_cents: 12900, stripe_price_id: "price_pro_b" },
      });
    });

    it("allows one open announcement for a plan, and holds its prices while it is open", async () => {
      await expect(
        as("authenticated", operator, () => db.query(announce("pro", 60))),
      ).rejects.toThrow(/price_changes_one_open|duplicate key/);
      await expect(
        as("authenticated", operator, () =>
          db.query(
            "select * from public.operator_set_plan_prices('pro', 13900, 3500, 'price_pro_c', 'price_pro_c_loc')",
          ),
        ),
      ).rejects.toThrow(/has been announced for this plan/);
      const [pro] = await rows<{ price_cents: number }>(
        "select price_cents from public.plans where key = 'pro'",
      );
      expect(pro?.price_cents).toBe(12900);
    });

    it("is read by anyone signed in and by no visitor; what it did for each organization is the operator's", async () => {
      await db.query(
        "insert into public.price_change_notices (price_change_id, organization_id, announced_at) values ($1, $2, now())",
        [changeId, theirs],
      );
      const changes = "select id from public.price_changes";
      const notices = "select organization_id from public.price_change_notices";
      expect(await as("authenticated", alice, () => rows(changes))).toHaveLength(1);
      await expect(as("anon", null, () => db.query(changes))).rejects.toThrow(/permission denied/);
      // Alice owns the organization the notice is about, and still does not read it.
      expect(await as("authenticated", alice, () => rows(notices))).toEqual([]);
      expect(await as("authenticated", operator, () => rows(notices))).toHaveLength(1);
      await expect(as("anon", null, () => db.query(notices))).rejects.toThrow(/permission denied/);
    });

    it("cannot be written through the API by anyone, the operator included", async () => {
      for (const sql of [
        "update public.price_changes set effective_at = now()",
        "delete from public.price_changes",
        "insert into public.price_changes (plan_key, stripe_price_id, effective_at) values ('pro', 'price_pro_b', now())",
        "update public.price_change_notices set announced_at = now() - interval '90 days'",
        "delete from public.price_change_notices",
      ]) {
        for (const user of [alice, operator]) {
          await expect(
            as("authenticated", user, () => db.query(sql)),
            sql,
          ).rejects.toThrow(/permission denied/);
        }
      }
    });

    it("can be called off before its day, once, and then the prices can change again", async () => {
      const [off] = await as("authenticated", operator, () =>
        rows<{ called_off_at: string | null }>(callOff),
      );
      expect(off?.called_off_at).not.toBeNull();
      expect(await as("authenticated", operator, () => rows(callOff))).toEqual([]);
      expect(await open()).toEqual([]);
      const again = await as("authenticated", operator, () => rows(announce("pro", 45)));
      expect(again).toHaveLength(1);
    });

    it("cannot be called off once its day has come", async () => {
      await db.query(
        "update public.price_changes set effective_at = now() - interval '1 hour' where called_off_at is null",
      );
      expect(await as("authenticated", operator, () => rows(callOff))).toEqual([]);
      expect(await open()).toHaveLength(1);
    });
  });

  describe("lowering what a plan allows", () => {
    // Standard allows 10 prompts, 2 assistants, a scan every 2 days, 10 by hand and a report.
    const lower = (days: number) =>
      `select * from public.operator_announce_limit_change('standard', 5, 2, 7, 100, true, now() + interval '${days} days')`;
    const setStandard = (prompts: number, byHand = 10) =>
      `select * from public.operator_set_plan('standard', 'Standard', true, ${prompts}, 2, 2, ${byHand}, true)`;
    const callOff = "select * from public.operator_call_off_limit_change('standard')";
    const standard = () =>
      rows<Record<string, unknown>>(
        "select max_queries_per_location, scan_every_days, max_manual_scans_per_month from public.plans where key = 'standard'",
      );
    const theirLimits = () =>
      rows<Record<string, unknown>>(
        "select max_queries_per_location, scan_every_days from public.organizations where id = $1",
        [theirs],
      );
    let changeId: string;

    beforeAll(async () => {
      // A customer who pays for Standard.
      await db.query("select public.apply_plan($1, 'standard')", [theirs]);
      await db.query(
        "update public.subscriptions set stripe_subscription_id = 'sub_paying' where organization_id = $1",
        [theirs],
      );
    });
    afterAll(async () => {
      await db.query("delete from public.limit_changes");
      await db.query(
        "update public.subscriptions set stripe_subscription_id = null where organization_id = $1",
        [theirs],
      );
      await db.query(
        "update public.plans set max_queries_per_location = 10, scan_every_days = 2, max_manual_scans_per_month = 10 where key = 'standard'",
      );
      await db.query("update public.plans set max_queries_per_location = 2 where key = 'free'");
      await db.query("update public.organizations set plan_key = null where id = $1", [theirs]);
      await db.query(
        "delete from public.operator_actions where action in ('set_plan', 'announce_limit_change', 'call_off_limit_change')",
      );
    });

    it("cannot be done on the spot where somebody pays, though raising still can", async () => {
      await expect(as("authenticated", operator, () => db.query(setStandard(5)))).rejects.toThrow(
        /only be lowered with 30 days/,
      );
      expect(await standard()).toMatchObject([{ max_queries_per_location: 10 }]);

      await as("authenticated", operator, () => db.query(setStandard(10, 12)));
      expect(await standard()).toMatchObject([{ max_manual_scans_per_month: 12 }]);
    });

    it("is announced by the operator alone, for a day at least thirty days out", async () => {
      for (const user of [alice, bob]) {
        expect(await as("authenticated", user, () => rows(lower(45))), user).toEqual([]);
        expect(await as("authenticated", user, () => rows(callOff)), user).toEqual([]);
      }
      await expect(as("anon", null, () => db.query(lower(45)))).rejects.toThrow(
        /permission denied/,
      );
      await expect(as("authenticated", operator, () => db.query(lower(29)))).rejects.toThrow(
        /at least 30 days/,
      );
      await expect(
        as("authenticated", operator, () =>
          db.query(
            "select * from public.operator_announce_limit_change('standard', 10, 2, 2, 100, true, now() + interval '45 days')",
          ),
        ),
      ).rejects.toThrow(/Nothing here is lower/);
      expect(await rows("select 1 from public.limit_changes")).toEqual([]);
    });

    it("keeps only what goes down, with what it was, and changes nothing until the day", async () => {
      const [change] = await as("authenticated", operator, () =>
        rows<{ id: string; lowered: Record<string, unknown> }>(lower(45)),
      );
      changeId = change?.id ?? "";
      expect(change?.lowered).toEqual({
        max_queries_per_location: { from: 10, to: 5 },
        scan_every_days: { from: 2, to: 7 },
      });
      expect(await standard()).toMatchObject([
        { max_queries_per_location: 10, scan_every_days: 2 },
      ]);
      expect(await theirLimits()).toEqual([{ max_queries_per_location: 10, scan_every_days: 2 }]);
      const [recorded] = await rows<{ actor_id: string; detail: unknown }>(
        "select actor_id, detail from public.operator_actions where action = 'announce_limit_change'",
      );
      expect(recorded).toMatchObject({ actor_id: operator, detail: { plan: "standard" } });
    });

    it("holds what it lowers where it is, allows one at a time, and leaves the rest editable", async () => {
      await expect(
        as("authenticated", operator, () => db.query(setStandard(12, 12))),
      ).rejects.toThrow(/A reduction has been announced/);
      await expect(as("authenticated", operator, () => db.query(lower(60)))).rejects.toThrow(
        /limit_changes_one_open|duplicate key/,
      );
      await as("authenticated", operator, () => db.query(setStandard(10, 15)));
      expect(await standard()).toMatchObject([{ max_manual_scans_per_month: 15 }]);
    });

    it("is read by anyone signed in; who was told is the operator's; nobody writes either", async () => {
      await db.query(
        "insert into public.limit_change_notices (limit_change_id, organization_id, announced_at) values ($1, $2, now())",
        [changeId, theirs],
      );
      const changes = "select id from public.limit_changes";
      const notices = "select organization_id from public.limit_change_notices";
      expect(await as("authenticated", alice, () => rows(changes))).toHaveLength(1);
      await expect(as("anon", null, () => db.query(changes))).rejects.toThrow(/permission denied/);
      expect(await as("authenticated", alice, () => rows(notices))).toEqual([]);
      expect(await as("authenticated", operator, () => rows(notices))).toHaveLength(1);
      for (const sql of [
        "update public.limit_changes set effective_at = now()",
        "delete from public.limit_changes",
        "update public.limit_change_notices set announced_at = now() - interval '90 days'",
        'insert into public.limit_changes (plan_key, lowered, effective_at) values (\'standard\', \'{"assistants": {"from": 2, "to": 1}}\', now())',
      ]) {
        for (const user of [alice, operator]) {
          await expect(
            as("authenticated", user, () => db.query(sql)),
            sql,
          ).rejects.toThrow(/permission denied/);
        }
      }
    });

    it("is not made before its day, and cannot be made by anyone but the worker", async () => {
      const apply = "select public.apply_limit_change($1) as made";
      for (const user of [alice, operator]) {
        await expect(as("authenticated", user, () => db.query(apply, [changeId]))).rejects.toThrow(
          /permission denied/,
        );
      }
      const [early] = await as("service_role", null, () =>
        rows<{ made: boolean }>(apply, [changeId]),
      );
      expect(early?.made).toBe(false);
      expect(await theirLimits()).toEqual([{ max_queries_per_location: 10, scan_every_days: 2 }]);
    });

    it("can be called off before its day, and then is never made", async () => {
      const [off] = await as("authenticated", operator, () =>
        rows<{ called_off_at: string | null }>(callOff),
      );
      expect(off?.called_off_at).not.toBeNull();
      expect(await as("authenticated", operator, () => rows(callOff))).toEqual([]);
      await db.query("update public.limit_changes set effective_at = now() - interval '1 hour'");
      const [late] = await as("service_role", null, () =>
        rows<{ made: boolean }>("select public.apply_limit_change($1) as made", [changeId]),
      );
      expect(late?.made).toBe(false);
      expect(await standard()).toMatchObject([{ max_queries_per_location: 10 }]);
    });

    it("is made on its day for the plan and everyone on it, once, leaving the rest as it was", async () => {
      const [again] = await as("authenticated", operator, () => rows<{ id: string }>(lower(45)));
      await db.query(
        "update public.limit_changes set effective_at = now() - interval '1 hour' where id = $1",
        [again?.id],
      );
      // Its day has come, so it can no longer be called off.
      expect(await as("authenticated", operator, () => rows(callOff))).toEqual([]);

      const apply = () =>
        as("service_role", null, () =>
          rows<{ made: boolean }>("select public.apply_limit_change($1) as made", [again?.id]),
        );
      expect((await apply())[0]?.made).toBe(true);
      expect(await standard()).toEqual([
        { max_queries_per_location: 5, scan_every_days: 7, max_manual_scans_per_month: 15 },
      ]);
      expect(await theirLimits()).toEqual([{ max_queries_per_location: 5, scan_every_days: 7 }]);
      expect((await apply())[0]?.made).toBe(false);
      // Made, the plan can be changed again.
      expect(
        await rows(
          "select 1 from public.limit_changes where called_off_at is null and completed_at is null",
        ),
      ).toEqual([]);
    });

    it("is made at once on the free plan, and kept so its organizations can be told", async () => {
      await as("authenticated", operator, () =>
        db.query(
          "select * from public.operator_set_plan('free', 'Free', true, 1, 1, 14, 0, false)",
        ),
      );
      const made = await rows<{ lowered: unknown; done: boolean }>(
        "select lowered, completed_at is not null as done from public.limit_changes where plan_key = 'free'",
      );
      expect(made).toEqual([
        { lowered: { max_queries_per_location: { from: 2, to: 1 } }, done: true },
      ]);
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
              allowances: before?.allowances,
            },
            // Sent without allowances, which leaves them as they were.
            to: { ...changed, allowances: before?.allowances },
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

  describe("a plan's allowances", () => {
    const tester = "ab000000-0000-4000-8000-00000000ab07";
    const both = { sample_count: 30, sample_access: true };
    // Standard as it stands, with its allowances set to `$1`. Null leaves them as they are.
    const setStandard =
      "select s.allowances from public.plans p, lateral public.operator_set_plan(p.key, p.name, p.on_sale, p.max_queries_per_location, p.assistants, p.scan_every_days, p.max_manual_scans_per_month, p.emails_report, $1::jsonb) s where p.key = 'standard'";
    const announce =
      "select c.id, c.lowered from public.plans p, lateral public.operator_announce_limit_change(p.key, p.max_queries_per_location, p.assistants, p.scan_every_days, p.max_manual_scans_per_month, p.emails_report, now() + interval '45 days', $1::jsonb) c where p.key = 'standard'";
    const standard = async () =>
      (
        await rows<{ allowances: unknown }>(
          "select allowances from public.plans where key = 'standard'",
        )
      )[0]?.allowances;
    const theirAllowances = async () =>
      (
        await rows<{ allowances: unknown }>(
          "select allowances from public.organizations where id = $1",
          [theirs],
        )
      )[0]?.allowances;
    let before: string[];
    let made: string | undefined;
    // What the plans and organizations include before these tests, put back after them. The
    // tests start everything from nothing, so they hold whatever kinds have been added since.
    let plansHad: { key: string; allowances: unknown }[];
    let organizationsHad: { id: string; allowances: unknown }[];

    beforeAll(async () => {
      before = (await rows<{ id: string }>("select id from public.operator_actions")).map(
        (row) => row.id,
      );
      plansHad = await rows("select key, allowances from public.plans");
      organizationsHad = await rows("select id, allowances from public.organizations");
      await db.query("update public.plans set allowances = '{}'");
      await db.query("update public.organizations set allowances = '{}'");
      // A customer on Standard, who does not pay yet.
      await db.query("select public.apply_plan($1, 'standard')", [theirs]);
      // A test account, named with the secret key.
      await db.query("insert into auth.users (id, email) values ($1, 'exerciser@example.com')", [
        tester,
      ]);
      await db.query("insert into public.platform_roles (user_id, role) values ($1, 'test')", [
        tester,
      ]);
    });
    afterAll(async () => {
      await db.query("delete from public.limit_changes");
      await db.query("delete from public.allowance_use");
      await db.query(
        "update public.subscriptions set stripe_subscription_id = null where organization_id = $1",
        [theirs],
      );
      await db.query("update public.organizations set plan_key = null where id = $1", [theirs]);
      if (made) await db.query("delete from public.organizations where id = $1", [made]);
      for (const plan of plansHad) {
        await db.query("update public.plans set allowances = $1::jsonb where key = $2", [
          JSON.stringify(plan.allowances),
          plan.key,
        ]);
      }
      for (const organization of organizationsHad) {
        await db.query("update public.organizations set allowances = $1::jsonb where id = $2", [
          JSON.stringify(organization.allowances),
          organization.id,
        ]);
      }
      await db.query("delete from public.platform_roles where user_id = $1", [tester]);
      await db.query("delete from public.allowance_kinds where key like 'sample_%'");
      await db.query("delete from public.operator_actions where not (id = any($1::uuid[]))", [
        before,
      ]);
    });

    it("are of the kinds the shared list names, and of no other", async () => {
      expect(await rows("select key, counted from public.allowance_kinds order by key")).toEqual(
        Object.entries(ALLOWANCE_KINDS)
          .map(([key, kind]) => ({ key, counted: kind.counted }))
          .sort((a, b) => a.key.localeCompare(b.key)),
      );
      // None exists yet, so the rest of these tests make two.
      await db.query(
        "insert into public.allowance_kinds (key, counted) values ('sample_count', true), ('sample_access', false)",
      );
    });

    it("may name only a kind that exists, with a value it takes", async () => {
      for (const bad of [
        '{"typo": 5}',
        '{"sample_count": 0}',
        '{"sample_count": 2.5}',
        '{"sample_count": true}',
        '{"sample_count": 1000001}',
        '{"sample_count": "30"}',
        '{"sample_access": 3}',
        '{"sample_access": false}',
        "[]",
        "5",
      ]) {
        for (const table of ["plans", "organizations"]) {
          await expect(
            db.query(`update public.${table} set allowances = $1::jsonb`, [bad]),
            `${table} ${bad}`,
          ).rejects.toThrow(/no allowance called|a set of kinds/);
        }
      }
      await db.query("update public.plans set allowances = $1::jsonb where key = 'retired'", [
        JSON.stringify(both),
      ]);
    });

    it("are part of the price list: read by anyone, written through the API by no one", async () => {
      const kinds = "select key from public.allowance_kinds where key like 'sample_%'";
      expect(await as("anon", null, () => rows(kinds))).toHaveLength(2);
      expect(await as("authenticated", alice, () => rows(kinds))).toHaveLength(2);
      for (const sql of [
        "insert into public.allowance_kinds (key, counted) values ('planted', true)",
        "update public.allowance_kinds set counted = not counted",
        "delete from public.allowance_kinds",
        "update public.plans set allowances = '{}'",
        `update public.organizations set allowances = '{"sample_access": true}' where id = '${theirs}'`,
      ]) {
        for (const user of [alice, operator]) {
          await expect(
            as("authenticated", user, () => db.query(sql)),
            sql,
          ).rejects.toThrow(/permission denied/);
        }
      }
      for (const fn of [
        "public.check_allowances('{}')",
        "public.test_allowances()",
        "public.allowance_reductions('{}', '{}')",
      ]) {
        await expect(
          as("authenticated", operator, () => db.query(`select ${fn}`)),
          fn,
        ).rejects.toThrow(/permission denied/);
      }
    });

    it("are set on a plan by the operator alone, and reach everyone on it at once", async () => {
      expect(
        await as("authenticated", alice, () => rows(setStandard, [JSON.stringify(both)])),
      ).toEqual([]);
      await expect(
        as("anon", null, () => db.query(setStandard, [JSON.stringify(both)])),
      ).rejects.toThrow(/permission denied/);
      expect(await standard()).toEqual({});

      expect(
        await as("authenticated", operator, () => rows(setStandard, [JSON.stringify(both)])),
      ).toEqual([{ allowances: both }]);
      expect(await theirAllowances()).toEqual(both);
      const [recorded] = await rows<{ detail: { from: unknown; to: unknown } }>(
        "select detail from public.operator_actions where action = 'set_plan' order by created_at desc limit 1",
      );
      expect(recorded?.detail).toMatchObject({
        from: { allowances: {} },
        to: { allowances: both },
      });

      await expect(
        as("authenticated", operator, () => db.query(setStandard, ['{"typo": 5}'])),
      ).rejects.toThrow(/no allowance called "typo"/);
    });

    it("are copied to an organization with its plan, and all given to a test organization", async () => {
      await db.query("update public.organizations set allowances = '{}' where id = $1", [theirs]);
      await as("service_role", null, () =>
        db.query("select public.apply_plan($1, 'standard')", [theirs]),
      );
      expect(await theirAllowances()).toEqual(both);

      const every = { sample_count: 1000, sample_access: true };
      // The test organizations that were there when the kinds were added have them too.
      expect(
        await rows(
          "select 1 from public.organizations where is_test and not (allowances @> $1::jsonb)",
          [JSON.stringify(every)],
        ),
      ).toEqual([]);
      const [fresh] = await as("authenticated", tester, () =>
        rows<{ id: string; allowances: unknown }>(
          "select id, allowances from public.create_organization('Exercises allowances')",
        ),
      );
      made = fresh?.id;
      expect(fresh?.allowances).toMatchObject(every);
    });

    it("are neither lowered nor taken away on the spot where somebody pays, though raising still can", async () => {
      await db.query(
        "update public.subscriptions set stripe_subscription_id = 'sub_paying' where organization_id = $1",
        [theirs],
      );
      for (const less of ['{"sample_count": 10, "sample_access": true}', '{"sample_count": 30}']) {
        await expect(
          as("authenticated", operator, () => db.query(setStandard, [less])),
          less,
        ).rejects.toThrow(/only be lowered with 30 days/);
      }
      expect(await standard()).toEqual(both);

      const more = { sample_count: 40, sample_access: true };
      await as("authenticated", operator, () => db.query(setStandard, [JSON.stringify(more)]));
      expect(await theirAllowances()).toEqual(more);
      // The Worker from before this column sends no allowances, which leaves them as they are.
      await as("authenticated", operator, () =>
        db.query(
          "select * from public.plans p, lateral public.operator_set_plan(p.key, p.name, p.on_sale, p.max_queries_per_location, p.assistants, p.scan_every_days, p.max_manual_scans_per_month, p.emails_report) s where p.key = 'standard'",
        ),
      );
      expect(await standard()).toEqual(more);
    });

    it("go down by announcement, kind by kind, and are held where they are until the day", async () => {
      await expect(
        as("authenticated", operator, () => db.query(announce, ['{"sample_count": 2.5}'])),
      ).rejects.toThrow(/no allowance called/);
      await expect(
        as("authenticated", operator, () =>
          db.query(announce, ['{"sample_count": 40, "sample_access": true}']),
        ),
      ).rejects.toThrow(/Nothing here is lower/);

      const [change] = await as("authenticated", operator, () =>
        rows<{ id: string; lowered: unknown }>(announce, ['{"sample_count": 10}']),
      );
      expect(change?.lowered).toEqual({
        allowances: {
          sample_count: { from: 40, to: 10 },
          sample_access: { from: true, to: false },
        },
      });
      expect(await standard()).toEqual({ sample_count: 40, sample_access: true });

      await expect(
        as("authenticated", operator, () =>
          db.query(setStandard, ['{"sample_count": 50, "sample_access": true}']),
        ),
      ).rejects.toThrow(/A reduction has been announced/);
      // Sent back as they are, the rest of the plan can still be saved.
      await as("authenticated", operator, () =>
        db.query(setStandard, ['{"sample_count": 40, "sample_access": true}']),
      );

      await db.query(
        "update public.limit_changes set effective_at = now() - interval '1 hour' where id = $1",
        [change?.id],
      );
      const [applied] = await as("service_role", null, () =>
        rows<{ made: boolean }>("select public.apply_limit_change($1) as made", [change?.id]),
      );
      expect(applied?.made).toBe(true);
      expect(await standard()).toEqual({ sample_count: 10 });
      expect(await theirAllowances()).toEqual({ sample_count: 10 });
    });

    it("are set for one organization by the operator, which takes it off its plan", async () => {
      const setLimits =
        "select plan_key, allowances from public.operator_set_limits($1, 3, 20, 10, 1, $2::jsonb)";
      expect(
        await as("authenticated", alice, () =>
          rows(setLimits, [theirs, '{"sample_access": true}']),
        ),
      ).toEqual([]);
      await expect(
        as("authenticated", operator, () => db.query(setLimits, [theirs, '{"typo": 5}'])),
      ).rejects.toThrow(/no allowance called "typo"/);
      expect(
        await as("authenticated", operator, () =>
          rows(setLimits, [theirs, '{"sample_access": true}']),
        ),
      ).toEqual([{ plan_key: null, allowances: { sample_access: true } }]);
      const [recorded] = await rows<{ detail: unknown }>(
        "select detail from public.operator_actions where action = 'set_limits' order by created_at desc limit 1",
      );
      expect(recorded?.detail).toMatchObject({
        from: { plan_key: "standard", allowances: { sample_count: 10 } },
        to: { plan_key: null, allowances: { sample_access: true } },
      });
      // The Worker from before this column sends no allowances, which leaves them as they are.
      await as("authenticated", operator, () =>
        db.query("select * from public.operator_set_limits($1, 3, 20, 10, 1)", [theirs]),
      );
      expect(await theirAllowances()).toEqual({ sample_access: true });
    });

    describe("their use", () => {
      const claim = (kind: string, amount = 1) =>
        as("service_role", null, () =>
          rows<{ claimed: boolean; allowed: number | null; used: number }>(
            "select * from public.claim_allowance($1, $2, $3)",
            [theirs, kind, amount],
          ),
        );
      const use = "select kind, used from public.allowance_use where organization_id = $1";

      beforeAll(async () => {
        // Two for each of three locations is six a month between them.
        await db.query(
          `update public.organizations set max_locations = 3, allowances = '{"sample_count": 2, "sample_access": true}' where id = $1`,
          [theirs],
        );
      });

      it("is counted for the month across the locations covered, and stops at the number", async () => {
        expect(await claim("sample_count")).toEqual([{ claimed: true, allowed: 6, used: 1 }]);
        expect(await claim("sample_count", 5)).toEqual([{ claimed: true, allowed: 6, used: 6 }]);
        expect(await claim("sample_count")).toEqual([{ claimed: false, allowed: 6, used: 6 }]);
        // More than is left is refused whole: nothing is counted.
        await db.query("update public.allowance_use set used = 4");
        expect(await claim("sample_count", 3)).toEqual([{ claimed: false, allowed: 6, used: 4 }]);
        expect(await rows(use, [theirs])).toEqual([{ kind: "sample_count", used: 4 }]);
      });

      it("has nothing to count for a kind included without a number, or one not included", async () => {
        expect(await claim("sample_access")).toEqual([{ claimed: true, allowed: null, used: 0 }]);
        expect(await claim("nonesuch")).toEqual([{ claimed: false, allowed: 0, used: 0 }]);
        expect(await rows(use, [theirs])).toHaveLength(1);
        expect(
          await as("service_role", null, () =>
            rows("select * from public.claim_allowance($1, 'sample_count')", [
              "00000000-0000-4000-8000-00000000dead",
            ]),
          ),
        ).toEqual([]);
        await expect(claim("sample_count", 0)).rejects.toThrow(/one or more at a time/);
      });

      it("starts again each calendar month", async () => {
        await db.query(
          "update public.allowance_use set month = (month - interval '1 month')::date, used = 6",
        );
        expect(await claim("sample_count")).toEqual([{ claimed: true, allowed: 6, used: 1 }]);
        expect(await rows("select count(*)::int as months from public.allowance_use")).toEqual([
          { months: 2 },
        ]);
      });

      it("is taken by the worker alone", async () => {
        for (const user of [alice, operator]) {
          await expect(
            as("authenticated", user, () =>
              db.query("select * from public.claim_allowance($1, 'sample_count')", [theirs]),
            ),
            user,
          ).rejects.toThrow(/permission denied/);
        }
        await expect(
          as("anon", null, () =>
            db.query("select * from public.claim_allowance($1, 'sample_count')", [theirs]),
          ),
        ).rejects.toThrow(/permission denied/);
      });

      it("is read by the organization's members and the operator, and written by no one", async () => {
        // Alice owns the organization. Bob belongs to another.
        expect(await as("authenticated", alice, () => rows(use, [theirs]))).toHaveLength(2);
        expect(await as("authenticated", bob, () => rows(use, [theirs]))).toEqual([]);
        expect(await as("authenticated", operator, () => rows(use, [theirs]))).toHaveLength(2);
        await expect(as("anon", null, () => db.query(use, [theirs]))).rejects.toThrow(
          /permission denied/,
        );
        for (const sql of [
          `insert into public.allowance_use (organization_id, kind, month, used) values ('${theirs}', 'sample_count', '2020-01-01', 0)`,
          "update public.allowance_use set used = 0",
          "delete from public.allowance_use",
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
  });

  describe("connections", () => {
    const member = "ab000000-0000-4000-8000-00000000ab08";
    const admin = "ab000000-0000-4000-8000-00000000ab09";
    const first = "c1000000-0000-4000-8000-000000000001";
    const second = "c1000000-0000-4000-8000-000000000002";
    const create =
      "select id, kind, label, status, connected_by, connected_by_email from public.create_connection($1, $2, 'sample', $3, $4)";
    const askToRemove =
      "select status, removed_by_email, removal_requested_at from public.request_connection_removal($1)";
    const finish = "select public.finish_connection_removal($1) as finished";
    const sealedFor = (id: string) =>
      rows<{ sealed: string }>(
        "select sealed from public.connection_secrets where connection_id = $1",
        [id],
      );

    beforeAll(async () => {
      await db.query(
        "insert into auth.users (id, email) values ($1, 'member@example.com'), ($2, 'admin@example.com')",
        [member, admin],
      );
      await db.query(
        "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'admin')",
        [theirs, member, admin],
      );
    });
    afterAll(async () => {
      await db.query("delete from public.connections");
      await db.query("delete from public.memberships where user_id = any($1::uuid[])", [
        [member, admin],
      ]);
    });

    it("are made only by an owner or admin of the organization", async () => {
      for (const user of [bob, member, operator]) {
        expect(
          await as("authenticated", user, () =>
            rows(create, [theirs, first, "Planted", "sealed-text"]),
          ),
          user,
        ).toEqual([]);
      }
      await expect(
        as("anon", null, () => db.query(create, [theirs, first, "Planted", "sealed-text"])),
      ).rejects.toThrow(/permission denied/);
      expect(await rows("select 1 from public.connections")).toEqual([]);

      expect(
        await as("authenticated", alice, () =>
          rows(create, [theirs, first, " Sample account ", "sealed-text"]),
        ),
      ).toEqual([
        {
          id: first,
          kind: "sample",
          label: "Sample account",
          status: "working",
          connected_by: alice,
          connected_by_email: "alice@example.com",
        },
      ]);
      expect(
        await as("authenticated", admin, () =>
          rows(create, [theirs, second, "Sample account", "other-sealed-text"]),
        ),
      ).toMatchObject([{ id: second, connected_by_email: "admin@example.com" }]);
      await expect(
        as("authenticated", alice, () =>
          db.query(create, [theirs, crypto.randomUUID(), "No sign-in", ""]),
        ),
      ).rejects.toThrow(/made with its sign-in/);
      expect(await rows("select 1 from public.connections")).toHaveLength(2);
    });

    it("are read by the organization's members and the operator, and written by no one directly", async () => {
      const read = "select id from public.connections where organization_id = $1";
      for (const user of [alice, member, admin, operator]) {
        expect(await as("authenticated", user, () => rows(read, [theirs])), user).toHaveLength(2);
      }
      expect(await as("authenticated", bob, () => rows(read, [theirs]))).toEqual([]);
      await expect(as("anon", null, () => db.query(read, [theirs]))).rejects.toThrow(
        /permission denied/,
      );
      for (const sql of [
        `insert into public.connections (id, organization_id, kind, label) values ('${crypto.randomUUID()}', '${theirs}', 'sample', 'Planted')`,
        "update public.connections set status = 'removed'",
        "update public.connections set label = 'Renamed'",
        "delete from public.connections",
      ]) {
        for (const user of [alice, operator]) {
          await expect(
            as("authenticated", user, () => db.query(sql)),
            sql,
          ).rejects.toThrow(/permission denied/);
        }
      }
    });

    it("keep the sign-in where no API role can read or write it", async () => {
      expect(await sealedFor(first)).toEqual([{ sealed: "sealed-text" }]);
      for (const sql of [
        "select sealed from public.connection_secrets",
        "update public.connection_secrets set sealed = 'swapped'",
        "delete from public.connection_secrets",
        `insert into public.connection_secrets (connection_id, sealed) values ('${first}', 'planted')`,
      ]) {
        for (const [role, user] of [
          ["authenticated", alice],
          ["authenticated", admin],
          ["authenticated", operator],
          ["anon", null],
        ] as const) {
          await expect(
            as(role, user, () => db.query(sql)),
            `${role} ${sql}`,
          ).rejects.toThrow(/permission denied/);
        }
      }
      expect(await sealedFor(first)).toEqual([{ sealed: "sealed-text" }]);
    });

    it("are asked to be removed by an owner or admin, and stop there until the worker finishes", async () => {
      for (const user of [bob, member, operator]) {
        expect(await as("authenticated", user, () => rows(askToRemove, [first])), user).toEqual([]);
      }
      await expect(as("anon", null, () => db.query(askToRemove, [first]))).rejects.toThrow(
        /permission denied/,
      );
      expect(
        await as("authenticated", alice, () =>
          rows(askToRemove, ["00000000-0000-4000-8000-00000000dead"]),
        ),
      ).toEqual([]);

      const [asked] = await as("authenticated", admin, () =>
        rows<{ status: string; removed_by_email: string; removal_requested_at: string }>(
          askToRemove,
          [first],
        ),
      );
      expect(asked).toMatchObject({ status: "removing", removed_by_email: "admin@example.com" });
      // Asked again, by someone else, it is still the first asking that is kept.
      const [again] = await as("authenticated", alice, () =>
        rows<{ status: string; removed_by_email: string; removal_requested_at: string }>(
          askToRemove,
          [first],
        ),
      );
      expect(again).toEqual(asked);
      // A request cannot read the sign-in, so it is still there for the worker to withdraw.
      expect(await sealedFor(first)).toHaveLength(1);
    });

    it("are finished by the worker alone: the sign-in goes and the record stays", async () => {
      for (const user of [alice, admin, operator]) {
        await expect(
          as("authenticated", user, () => db.query(finish, [first])),
          user,
        ).rejects.toThrow(/permission denied/);
      }
      const done = () =>
        as("service_role", null, () => rows<{ finished: boolean }>(finish, [first]));
      expect(await done()).toEqual([{ finished: true }]);
      expect(await sealedFor(first)).toEqual([]);
      expect(
        await rows(
          "select status, connected_by_email, removed_by_email, removed_at is not null as removed from public.connections where id = $1",
          [first],
        ),
      ).toEqual([
        {
          status: "removed",
          connected_by_email: "alice@example.com",
          removed_by_email: "admin@example.com",
          removed: true,
        },
      ]);
      expect(await done()).toEqual([{ finished: false }]);

      // One nobody asked to remove is left alone, sign-in and all.
      expect(
        await as("service_role", null, () => rows<{ finished: boolean }>(finish, [second])),
      ).toEqual([{ finished: false }]);
      expect(await sealedFor(second)).toEqual([{ sealed: "other-sealed-text" }]);
      expect(await rows("select status from public.connections where id = $1", [second])).toEqual([
        { status: "working" },
      ]);
    });

    describe("syncing and matching", () => {
      const third = "c1000000-0000-4000-8000-000000000003";
      const reached = JSON.stringify([
        { id: "listing-a", label: "Main Street" },
        { id: "listing-b", label: "Riverside" },
      ]);
      const sync = "select public.record_connection_sync($1, $2::jsonb) as recorded";
      const due = "select public.connections_due_for_sync() as id";
      const match =
        "select location_id, external_id, external_label from public.match_connection_location($1, $2, $3)";
      const unmatch = "select public.unmatch_connection_location($1, $2) as taken";
      const matches = () =>
        rows<Record<string, string>>(
          "select connection_id, location_id, external_id, external_label from public.connection_locations order by matched_at",
        );
      let main: string;
      let uptown: string;
      let elsewhere: string;

      beforeAll(async () => {
        const [existing] = await rows<{ id: string }>(
          "select id from public.locations where organization_id = $1 limit 1",
          [theirs],
        );
        main = existing?.id ?? "";
        const [added] = await rows<{ id: string }>(
          "insert into public.locations (organization_id, name, city) values ($1, 'Uptown', 'Raleigh') returning id",
          [theirs],
        );
        uptown = added?.id ?? "";
        // A location of the operator's own organization, which is not this customer's.
        const [other] = await rows<{ id: string }>(
          "select l.id from public.locations l where l.organization_id <> $1 limit 1",
          [theirs],
        );
        elsewhere = other?.id ?? "";
        // A second working account of the same kind, connected by the owner.
        await as("authenticated", alice, () =>
          db.query(create, [theirs, third, "Another sample account", "third-sealed-text"]),
        );
      });
      afterAll(async () => {
        await db.query("delete from public.locations where id = $1", [uptown]);
      });

      it("are synced by the worker alone, which keeps what the sign-in reaches", async () => {
        for (const user of [alice, admin, operator]) {
          await expect(
            as("authenticated", user, () => db.query(sync, [second, reached])),
            user,
          ).rejects.toThrow(/permission denied/);
          await expect(
            as("authenticated", user, () => db.query(due)),
            user,
          ).rejects.toThrow(/permission denied/);
        }
        const dueNow = async () =>
          (await as("service_role", null, () => rows<{ id: string }>(due))).map((row) => row.id);
        // Never synced, the two working ones are due. The removed one never is.
        expect((await dueNow()).sort()).toEqual([second, third].sort());

        for (const bad of ['{"id": "a"}', '[{"id": "", "label": "A"}]', '[{"id": "a"}]', '["a"]']) {
          await expect(
            as("service_role", null, () => db.query(sync, [second, bad])),
            bad,
          ).rejects.toThrow(/each with an id and a label/);
        }
        const record = (id: string) =>
          as("service_role", null, () => rows<{ recorded: boolean }>(sync, [id, reached]));
        expect(await record(second)).toEqual([{ recorded: true }]);
        expect(await record(third)).toEqual([{ recorded: true }]);
        expect(await record(first)).toEqual([{ recorded: false }]);
        expect(
          await rows(
            "select choices, last_synced_at is not null as synced from public.connections where id = $1",
            [second],
          ),
        ).toEqual([{ choices: JSON.parse(reached), synced: true }]);
        expect(await rows("select choices from public.connections where id = $1", [first])).toEqual(
          [{ choices: [] }],
        );

        // Synced a moment ago, neither is due. Most of a day later one is again.
        expect(await dueNow()).toEqual([]);
        await db.query(
          "update public.connections set last_synced_at = now() - interval '21 hours' where id = $1",
          [second],
        );
        expect(await dueNow()).toEqual([second]);
      });

      it("match a location to something the account reaches, for an owner or admin alone", async () => {
        for (const user of [bob, member, operator]) {
          expect(
            await as("authenticated", user, () => rows(match, [second, main, "listing-a"])),
            user,
          ).toEqual([]);
        }
        await expect(
          as("anon", null, () => db.query(match, [second, main, "listing-a"])),
        ).rejects.toThrow(/permission denied/);
        // Not another organization's location, whoever asks.
        expect(
          await as("authenticated", alice, () => rows(match, [second, elsewhere, "listing-a"])),
        ).toEqual([]);
        expect(await matches()).toEqual([]);

        expect(
          await as("authenticated", alice, () => rows(match, [second, main, "listing-a"])),
        ).toEqual([{ location_id: main, external_id: "listing-a", external_label: "Main Street" }]);
        // Said again by an admin, it replaces what was said before.
        expect(
          await as("authenticated", admin, () => rows(match, [second, main, "listing-b"])),
        ).toEqual([{ location_id: main, external_id: "listing-b", external_label: "Riverside" }]);
        expect(await matches()).toHaveLength(1);
      });

      it("refuse what the account does not reach, what is taken, and one that is not working", async () => {
        const refused = (connection: string, location: string, external: string) =>
          as("authenticated", alice, () => db.query(match, [connection, location, external]));
        await expect(refused(second, main, "nonesuch")).rejects.toThrow(
          /not something this account reaches/,
        );
        await expect(refused(second, uptown, "listing-b")).rejects.toThrow(
          /already belongs to another location/,
        );
        await expect(refused(third, main, "listing-a")).rejects.toThrow(
          /another account of the same kind/,
        );
        await expect(refused(first, main, "listing-a")).rejects.toThrow(/not connected any more/);
        // The other account can take the other location.
        await refused(third, uptown, "listing-a");
        expect(await matches()).toEqual([
          {
            connection_id: second,
            location_id: main,
            external_id: "listing-b",
            external_label: "Riverside",
          },
          {
            connection_id: third,
            location_id: uptown,
            external_id: "listing-a",
            external_label: "Main Street",
          },
        ]);
      });

      it("are read by whoever reads the location and by the operator, and written by no one directly", async () => {
        const read = "select location_id from public.connection_locations";
        for (const user of [alice, member, admin, operator]) {
          expect(await as("authenticated", user, () => rows(read)), user).toHaveLength(2);
        }
        expect(await as("authenticated", bob, () => rows(read))).toEqual([]);
        await expect(as("anon", null, () => db.query(read))).rejects.toThrow(/permission denied/);
        for (const sql of [
          `insert into public.connection_locations (connection_id, kind, location_id, external_id, external_label) values ('${second}', 'sample', '${uptown}', 'planted', 'Planted')`,
          "update public.connection_locations set external_id = 'swapped'",
          "delete from public.connection_locations",
          `update public.connections set choices = '[]' where id = '${second}'`,
        ]) {
          for (const user of [alice, operator]) {
            await expect(
              as("authenticated", user, () => db.query(sql)),
              sql,
            ).rejects.toThrow(/permission denied/);
          }
        }
      });

      it("keep their choice at the next sync, and take the name it has then", async () => {
        const renamed = JSON.stringify([{ id: "listing-b", label: "Riverside Drive" }]);
        await as("service_role", null, () => db.query(sync, [second, renamed]));
        expect(
          await rows(
            "select external_id, external_label from public.connection_locations where connection_id = $1",
            [second],
          ),
        ).toEqual([{ external_id: "listing-b", external_label: "Riverside Drive" }]);
      });

      it("are taken away by an owner or admin, and deleted with what was synced when the account is removed", async () => {
        for (const user of [bob, member, operator]) {
          expect(
            await as("authenticated", user, () => rows(unmatch, [third, uptown])),
            user,
          ).toEqual([{ taken: false }]);
        }
        expect(await as("authenticated", admin, () => rows(unmatch, [third, uptown]))).toEqual([
          { taken: true },
        ]);
        expect(await as("authenticated", admin, () => rows(unmatch, [third, uptown]))).toEqual([
          { taken: false },
        ]);

        await as("authenticated", alice, () => db.query(askToRemove, [second]));
        await as("service_role", null, () => db.query(finish, [second]));
        expect(await matches()).toEqual([]);
        expect(
          await rows("select status, choices from public.connections where id = $1", [second]),
        ).toEqual([{ status: "removed", choices: [] }]);
        expect(await sealedFor(second)).toEqual([]);
      });
    });

    describe("breaking and pausing", () => {
      // After the tests above, `third` is the one connection still working.
      const third = "c1000000-0000-4000-8000-000000000003";
      const fourth = "c1000000-0000-4000-8000-000000000004";
      const failed = "select status, newly_broken from public.record_connection_failure($1, $2)";
      const fail = (id: string, refused: boolean) =>
        as("service_role", null, () =>
          rows<{ status: string; newly_broken: boolean }>(failed, [id, refused]),
        );
      const stands = (id: string) =>
        rows<Record<string, unknown>>(
          "select status, broken_reason, failed_days, broken_at is not null as broken, paused_at is not null as paused from public.connections where id = $1",
          [id],
        );
      const due = async () =>
        (
          await as("service_role", null, () =>
            rows<{ id: string }>("select public.connections_due_for_sync() as id"),
          )
        ).map((row) => row.id);
      const synced = (id: string) =>
        as("service_role", null, () =>
          rows<{ recorded: boolean }>(
            "select public.record_connection_sync($1, '[]'::jsonb) as recorded",
            [id],
          ),
        );
      const aDayPasses = () =>
        db.query(
          "update public.connections set last_failed_on = last_failed_on - 1, last_synced_at = now() - interval '21 hours'",
        );

      beforeAll(async () => {
        await as("authenticated", alice, () =>
          db.query(create, [theirs, fourth, "Sample account four", "fourth-sealed-text"]),
        );
      });
      afterAll(async () => {
        await db.query("delete from public.connection_kind_allowances");
        await db.query(
          "update public.organizations set allowances = '{}', plan_key = null where id = $1",
          [theirs],
        );
        await db.query("update public.plans set allowances = '{}'");
        // A test organization is given every kind there is, so one still names this.
        await db.query("update public.organizations set allowances = allowances - 'sample_access'");
        await db.query("delete from public.allowance_kinds where key = 'sample_access'");
        await db.query(
          "delete from public.operator_actions where action = 'set_limits' and organization_id = $1 and created_at > now() - interval '1 minute' and detail -> 'to' -> 'allowances' ? 'sample_access'",
          [theirs],
        );
      });

      it("break at once when the sign-in is refused, which only the worker may say", async () => {
        for (const user of [alice, admin, operator]) {
          await expect(
            as("authenticated", user, () => db.query(failed, [third, true])),
            user,
          ).rejects.toThrow(/permission denied/);
        }
        expect(await fail(third, true)).toEqual([{ status: "broken", newly_broken: true }]);
        // Said again, it is not news.
        expect(await fail(third, true)).toEqual([{ status: "broken", newly_broken: false }]);
        expect(await stands(third)).toMatchObject([
          { status: "broken", broken_reason: "refused", broken: true },
        ]);
        // It waits for its owner: it is not synced, and a sync would not mend it.
        await aDayPasses();
        expect(await due()).not.toContain(third);
        expect(await synced(third)).toEqual([{ recorded: false }]);
        // Nothing to record for one that is gone.
        expect(await fail(first, true)).toEqual([]);
      });

      it("break on the third failed day in a row, counting a day once however often it failed", async () => {
        expect(await fail(fourth, false)).toEqual([{ status: "working", newly_broken: false }]);
        expect(await fail(fourth, false)).toEqual([{ status: "working", newly_broken: false }]);
        expect(await stands(fourth)).toMatchObject([{ status: "working", failed_days: 1 }]);
        await aDayPasses();
        expect(await fail(fourth, false)).toEqual([{ status: "working", newly_broken: false }]);
        await aDayPasses();
        expect(await fail(fourth, false)).toEqual([{ status: "broken", newly_broken: true }]);
        expect(await stands(fourth)).toMatchObject([
          { status: "broken", broken_reason: "failing", failed_days: 3, broken: true },
        ]);
        await aDayPasses();
        expect(await fail(fourth, false)).toEqual([{ status: "broken", newly_broken: false }]);
      });

      it("are still tried when they only kept failing, and mend at the next sync that works", async () => {
        expect(await due()).toEqual([fourth]);
        expect(await synced(fourth)).toEqual([{ recorded: true }]);
        expect(await stands(fourth)).toEqual([
          { status: "working", broken_reason: null, failed_days: 0, broken: false, paused: false },
        ]);
        // The count starts over.
        expect(await fail(fourth, false)).toEqual([{ status: "working", newly_broken: false }]);
        await synced(fourth);
      });

      it("need no allowance unless their kind is listed as needing one, as the shared list says", async () => {
        const { CONNECTION_KIND_ALLOWANCES } = await import("@nearcited/shared");
        expect(
          await rows("select kind, allowance from public.connection_kind_allowances order by kind"),
        ).toEqual(
          Object.entries(CONNECTION_KIND_ALLOWANCES)
            .filter(([, allowance]) => allowance !== null)
            .map(([kind, allowance]) => ({ kind, allowance })),
        );
        for (const sql of [
          "select kind from public.connection_kind_allowances",
          "delete from public.connection_kind_allowances",
          "select public.fit_connections_to_plan('00000000-0000-4000-8000-00000000dead')",
          "select public.expire_paused_connections()",
          "select public.allows_connection('00000000-0000-4000-8000-00000000dead', 'sample')",
        ]) {
          for (const [role, user] of [
            ["authenticated", alice],
            ["authenticated", operator],
            ["anon", null],
          ] as const) {
            await expect(
              as(role, user, () => db.query(sql)),
              `${role} ${sql}`,
            ).rejects.toThrow(/permission denied/);
          }
        }
      });

      it("are paused when the organization's allowances stop including them, and are not made then", async () => {
        // No real kind needs an allowance yet, so for these tests the sample kind does.
        await db.query(
          "insert into public.allowance_kinds (key, counted) values ('sample_access', false)",
        );
        await db.query(
          "insert into public.connection_kind_allowances (kind, allowance) values ('sample', 'sample_access')",
        );
        // The customer's organization has no allowances, so fitting it pauses both.
        await as("service_role", null, () =>
          db.query("select public.fit_connections_to_plan($1)", [theirs]),
        );
        expect(await stands(fourth)).toMatchObject([{ status: "paused", paused: true }]);
        expect(await stands(third)).toMatchObject([
          { status: "paused", broken_reason: "refused", paused: true },
        ]);
        expect(await due()).toEqual([]);
        await expect(
          as("authenticated", alice, () =>
            db.query(create, [theirs, crypto.randomUUID(), "Not included", "sealed"]),
          ),
        ).rejects.toThrow(/does not include connecting this kind/);
        await expect(
          as("authenticated", alice, () =>
            db.query(
              "select * from public.match_connection_location($1, (select id from public.locations where organization_id = $2 limit 1), 'listing-a')",
              [fourth, theirs],
            ),
          ),
        ).rejects.toThrow(/does not include this account any more/);
      });

      it("come back when the allowances include them again, broken if they were broken", async () => {
        // By the operator's limits editor.
        await as("authenticated", operator, () =>
          db.query(
            `select * from public.operator_set_limits($1, 3, 20, 10, 1, '{"sample_access": true}')`,
            [theirs],
          ),
        );
        expect(await stands(fourth)).toMatchObject([{ status: "working", paused: false }]);
        expect(await stands(third)).toMatchObject([
          { status: "broken", broken_reason: "refused", paused: false },
        ]);
        // And paused again by a plan that does not include it, which is every plan there is.
        await as("service_role", null, () =>
          db.query("select public.apply_plan($1, 'standard')", [theirs]),
        );
        expect(await stands(fourth)).toMatchObject([{ status: "paused", paused: true }]);
      });

      it("are removed once they have been paused for thirty days, by the worker alone", async () => {
        const expire = "select public.expire_paused_connections() as id";
        expect(await as("service_role", null, () => rows(expire))).toEqual([]);
        await db.query(
          "update public.connections set paused_at = now() - interval '31 days' where id = $1",
          [fourth],
        );
        expect(await as("service_role", null, () => rows(expire))).toEqual([{ id: fourth }]);
        expect(
          await rows(
            "select status, removal_reason, removed_by_email from public.connections where id = $1",
            [fourth],
          ),
        ).toEqual([{ status: "removing", removal_reason: "plan", removed_by_email: null }]);
        await as("service_role", null, () => db.query(finish, [fourth]));
        expect(await sealedFor(fourth)).toEqual([]);
        expect(await stands(fourth)).toMatchObject([{ status: "removed" }]);
        // The one paused a moment ago is kept.
        expect(await stands(third)).toMatchObject([{ status: "paused" }]);
        expect(await sealedFor(third)).toHaveLength(1);
      });

      it("say that somebody asked, when a removal was asked for", async () => {
        expect(
          await rows("select removal_reason from public.connections where id = $1", [second]),
        ).toEqual([{ removal_reason: "asked" }]);
      });
    });

    it("go with their organization, sign-ins included", async () => {
      const [gone] = await rows<{ id: string }>(
        "insert into public.organizations (name, created_by) values ('Closing', $1) returning id",
        [alice],
      );
      const id = crypto.randomUUID();
      await db.query(
        "insert into public.connections (id, organization_id, kind, label) values ($1, $2, 'sample', 'Sample account')",
        [id, gone?.id],
      );
      await db.query(
        "insert into public.connection_secrets (connection_id, sealed) values ($1, 'sealed')",
        [id],
      );
      await db.query("delete from public.organizations where id = $1", [gone?.id]);
      expect(await sealedFor(id)).toEqual([]);
    });
  });

  describe("actions", () => {
    const member = "ab000000-0000-4000-8000-00000000ab0a";
    const account = "c2000000-0000-4000-8000-000000000001";
    const propose = (about: string, restingOn: string, text: string | null = "New line") =>
      as("service_role", null, () =>
        rows<{ id: string; status: string; waits: string }>(
          "select id, status, (lapses_at - proposed_at)::text as waits from public.propose_action($1, 'sample', $2, $3, $4, 'Set the opening line', '{\"text\": null}'::jsonb, $5, 'rule')",
          [main, account, about, restingOn, text],
        ),
      );
    const approve =
      "select status, approved_by_email, approved_text from public.approve_action($1, $2)";
    const decline =
      "select status, declined_by_email, decline_reason from public.decline_action($1, $2)";
    const claim = (id: string) =>
      as("service_role", null, () =>
        rows<{ try: number }>("select public.claim_action($1) as try", [id]),
      );
    const finish = (id: string, outcome: string, why: string | null = null) =>
      as("service_role", null, () =>
        rows<{ finished: boolean }>("select public.finish_action($1, $2, $3) as finished", [
          id,
          outcome,
          why,
        ]),
      );
    const stands = (id: string) =>
      rows<Record<string, unknown>>(
        "select status, attempts, carrying_since is not null as carrying, failure, lapse_reason from public.actions where id = $1",
        [id],
      );
    let main: string;
    let first: string;

    beforeAll(async () => {
      const [location] = await rows<{ id: string }>(
        "select id from public.locations where organization_id = $1 limit 1",
        [theirs],
      );
      main = location?.id ?? "";
      await db.query("insert into auth.users (id, email) values ($1, 'acting@example.com')", [
        member,
      ]);
      await db.query(
        "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'member')",
        [theirs, member],
      );
      await db.query(
        "insert into public.connections (id, organization_id, kind, label) values ($1, $2, 'sample', 'Sample account')",
        [account, theirs],
      );
    });
    afterAll(async () => {
      await db.query("delete from public.actions");
      await db.query("delete from public.connections where id = $1", [account]);
      await db.query("delete from public.memberships where user_id = $1", [member]);
    });

    it("are proposed by the worker alone, one at a time for a thing, with fourteen days to answer", async () => {
      const asked =
        "select * from public.propose_action($1, 'sample', $2, 'opening-line:a', 'basis', 'Planted', null, 'Planted', 'rule')";
      for (const user of [alice, member, operator]) {
        await expect(
          as("authenticated", user, () => db.query(asked, [main, account])),
          user,
        ).rejects.toThrow(/permission denied/);
      }
      const [made] = await propose("opening-line:a", "first");
      first = made?.id ?? "";
      expect(made).toMatchObject({ status: "proposed", waits: "14 days" });
      // A second for the same thing is not made while the first waits, whatever it rests on.
      expect(await propose("opening-line:a", "second")).toEqual([]);
      // Another thing is another proposal.
      expect(await propose("opening-line:b", "first")).toHaveLength(1);
    });

    it("are read by whoever reads the location and by the operator, and written by no one directly", async () => {
      const read = "select id from public.actions where location_id = $1";
      for (const user of [alice, member, operator]) {
        expect(await as("authenticated", user, () => rows(read, [main])), user).toHaveLength(2);
      }
      expect(await as("authenticated", bob, () => rows(read, [main]))).toEqual([]);
      await expect(as("anon", null, () => db.query(read, [main]))).rejects.toThrow(
        /permission denied/,
      );
      for (const sql of [
        `insert into public.actions (location_id, kind, subject, basis, summary, written_by) values ('${main}', 'sample', 'planted', 'planted', 'Planted', 'rule')`,
        "update public.actions set status = 'done'",
        "update public.actions set proposed_text = 'Swapped'",
        "delete from public.actions",
        "select opening_line from public.sample_listings",
        "delete from public.sample_listings",
      ]) {
        for (const user of [alice, operator]) {
          await expect(
            as("authenticated", user, () => db.query(sql)),
            sql,
          ).rejects.toThrow(/permission denied/);
        }
      }
      for (const fn of [
        `public.claim_action('${first}')`,
        `public.finish_action('${first}', 'done')`,
        "public.lapse_actions()",
      ]) {
        for (const user of [alice, operator]) {
          await expect(
            as("authenticated", user, () => db.query(`select ${fn}`)),
            fn,
          ).rejects.toThrow(/permission denied/);
        }
      }
    });

    it("are approved by any member of the organization, and by nobody else", async () => {
      for (const user of [bob, operator]) {
        expect(await as("authenticated", user, () => rows(approve, [first, null])), user).toEqual(
          [],
        );
      }
      await expect(as("anon", null, () => db.query(approve, [first, null]))).rejects.toThrow(
        /permission denied/,
      );
      // The worker takes nothing that nobody approved.
      expect(await claim(first)).toEqual([{ try: 0 }]);

      expect(await as("authenticated", member, () => rows(approve, [first, null]))).toEqual([
        { status: "approved", approved_by_email: "acting@example.com", approved_text: null },
      ]);
      await expect(
        as("authenticated", alice, () => db.query(approve, [first, null])),
      ).rejects.toThrow(/no longer waiting for a yes/);
      await expect(
        as("authenticated", alice, () => db.query(decline, [first, "Too late"])),
      ).rejects.toThrow(/no longer waiting for an answer/);
    });

    it("keep what was approved beside what was proposed, when a member changed the text", async () => {
      const [same] = await propose("opening-line:c", "first", "As proposed");
      expect(
        await as("authenticated", alice, () => rows(approve, [same?.id, "  As proposed  "])),
      ).toMatchObject([{ approved_text: null }]);
      const [changed] = await propose("opening-line:d", "first", "As proposed");
      expect(
        await as("authenticated", alice, () => rows(approve, [changed?.id, "  As changed  "])),
      ).toMatchObject([{ status: "approved", approved_text: "As changed" }]);
      const [wordless] = await propose("opening-line:e", "first", null);
      await expect(
        as("authenticated", alice, () => db.query(approve, [wordless?.id, "Words"])),
      ).rejects.toThrow(/no text to change/);
    });

    it("are declined with a reason or without, and then not proposed again on the same footing", async () => {
      const [second] = await rows<{ id: string }>(
        "select id from public.actions where subject = 'opening-line:b'",
      );
      expect(await as("authenticated", bob, () => rows(decline, [second?.id, null]))).toEqual([]);
      expect(
        await as("authenticated", member, () => rows(decline, [second?.id, "  Not this one  "])),
      ).toEqual([
        {
          status: "declined",
          declined_by_email: "acting@example.com",
          decline_reason: "Not this one",
        },
      ]);
      await expect(
        as("authenticated", alice, () => db.query(decline, [second?.id, "x".repeat(201)])),
      ).rejects.toThrow(/no longer waiting/);
      expect(await propose("opening-line:b", "first")).toEqual([]);
      // What it rests on has changed, so it may be offered again.
      expect(await propose("opening-line:b", "something new")).toHaveLength(1);
    });

    it("are carried out by one worker at a time, which says which try it is", async () => {
      expect(await claim(first)).toEqual([{ try: 1 }]);
      expect(await claim(first)).toEqual([{ try: 0 }]);
      // Whoever had it is taken to have died after ten minutes.
      await db.query(
        "update public.actions set carrying_since = now() - interval '11 minutes' where id = $1",
        [first],
      );
      expect(await claim(first)).toEqual([{ try: 2 }]);
      // A try that did not work lets go of it, keeping why.
      expect(await finish(first, "again", "The outside service is down.")).toEqual([
        { finished: true },
      ]);
      expect(await stands(first)).toEqual([
        {
          status: "approved",
          attempts: 2,
          carrying: false,
          failure: "The outside service is down.",
          lapse_reason: null,
        },
      ]);
      expect(await claim(first)).toEqual([{ try: 3 }]);
      await expect(finish(first, "abandoned")).rejects.toThrow(/ends done, failed/);
    });

    it("end done, failed or out of date, once", async () => {
      expect(await finish(first, "failed", "It could not be done.")).toEqual([{ finished: true }]);
      expect(await stands(first)).toMatchObject([
        { status: "failed", carrying: false, failure: "It could not be done." },
      ]);
      expect(await finish(first, "done")).toEqual([{ finished: false }]);
      expect(await claim(first)).toEqual([{ try: 0 }]);

      const [changed] = await rows<{ id: string }>(
        "select id from public.actions where subject = 'opening-line:d'",
      );
      await claim(changed?.id ?? "");
      expect(await finish(changed?.id ?? "", "out_of_date")).toEqual([{ finished: true }]);
      expect(await stands(changed?.id ?? "")).toMatchObject([
        { status: "lapsed", lapse_reason: "out_of_date" },
      ]);

      const [same] = await rows<{ id: string }>(
        "select id from public.actions where subject = 'opening-line:c'",
      );
      await claim(same?.id ?? "");
      expect(await finish(same?.id ?? "", "done")).toEqual([{ finished: true }]);
      expect(
        await rows("select status, done_at is not null as done from public.actions where id = $1", [
          same?.id,
        ]),
      ).toEqual([{ status: "done", done: true }]);
    });

    it("are asked for again only after failing, as a new action that points at the old", async () => {
      const again = "select id, status, retry_of, approved_by_email from public.retry_action($1)";
      expect(await as("authenticated", bob, () => rows(again, [first]))).toEqual([]);
      expect(await as("authenticated", operator, () => rows(again, [first]))).toEqual([]);
      const [done] = await rows<{ id: string }>(
        "select id from public.actions where subject = 'opening-line:c'",
      );
      await expect(as("authenticated", alice, () => db.query(again, [done?.id]))).rejects.toThrow(
        /Only an action that failed/,
      );

      const [retried] = await as("authenticated", alice, () =>
        rows<Record<string, unknown>>(again, [first]),
      );
      expect(retried).toMatchObject({
        status: "approved",
        retry_of: first,
        approved_by_email: "alice@example.com",
      });
      // Not twice: the first asking is on its way.
      await expect(as("authenticated", member, () => db.query(again, [first]))).rejects.toThrow(
        /already one of these/,
      );
      expect(await stands(first)).toMatchObject([{ status: "failed" }]);
    });

    it("lapse when nobody answers in fourteen days, and cannot be approved past their day", async () => {
      const [late] = await propose("opening-line:f", "first");
      await db.query(
        "update public.actions set lapses_at = now() - interval '1 minute' where id = $1",
        [late?.id],
      );
      await expect(
        as("authenticated", alice, () => db.query(approve, [late?.id, null])),
      ).rejects.toThrow(/no longer waiting for a yes/);
      expect(
        await as("service_role", null, () =>
          rows<{ lapsed: number }>("select public.lapse_actions() as lapsed"),
        ),
      ).toEqual([{ lapsed: 1 }]);
      expect(await stands(late?.id ?? "")).toMatchObject([
        { status: "lapsed", lapse_reason: "expired" },
      ]);
      // Lapsed, it can be proposed again.
      expect(await propose("opening-line:f", "first")).toHaveLength(1);
    });

    it("are held for an organization whose owners have gone 36 hours untold of one", async () => {
      const held = (role: Role, user: string | null) =>
        as(role, user, () =>
          rows<{ held: boolean }>("select public.location_held($1) as held", [main]),
        );
      const organizationHeld = () =>
        as("service_role", null, () =>
          rows<{ held: boolean }>("select public.organization_held($1) as held", [theirs]),
        );
      const [waiting] = await propose("opening-line:g", "first");
      await as("authenticated", alice, () => db.query(approve, [waiting?.id, null]));
      expect(await organizationHeld()).toEqual([{ held: false }]);

      // Something was done 37 hours ago and nobody has been told.
      const [done] = await rows<{ id: string }>(
        "select id from public.actions where subject = 'opening-line:c'",
      );
      await db.query(
        "update public.actions set done_at = now() - interval '37 hours' where id = $1",
        [done?.id],
      );
      expect(await organizationHeld()).toEqual([{ held: true }]);
      expect(await held("authenticated", alice)).toEqual([{ held: true }]);
      expect(await held("authenticated", member)).toEqual([{ held: true }]);
      expect(await held("authenticated", operator)).toEqual([{ held: true }]);
      // A stranger is told nothing, and the worker's own question is not theirs to ask.
      expect(await held("authenticated", bob)).toEqual([{ held: false }]);
      await expect(held("anon", null)).rejects.toThrow(/permission denied/);
      for (const user of [alice, operator]) {
        await expect(
          as("authenticated", user, () =>
            db.query("select public.organization_held($1)", [theirs]),
          ),
          user,
        ).rejects.toThrow(/permission denied/);
      }
      // Nothing more is carried out meanwhile.
      expect(await claim(waiting?.id ?? "")).toEqual([{ try: 0 }]);

      // A test organization is never held: the record on its page is the notice.
      await db.query("update public.organizations set is_test = true where id = $1", [theirs]);
      expect(await organizationHeld()).toEqual([{ held: false }]);
      await db.query("update public.organizations set is_test = false where id = $1", [theirs]);

      // Told, it goes ahead.
      await db.query("update public.actions set told_at = now() where id = $1", [done?.id]);
      expect(await organizationHeld()).toEqual([{ held: false }]);
      expect(await claim(waiting?.id ?? "")).toEqual([{ try: 1 }]);
      await finish(waiting?.id ?? "", "done");
    });

    it("keep what each kind is held to where no API role reads it", async () => {
      const read = "select kind from public.action_kind_terms";
      for (const user of [alice, member, operator]) {
        await expect(
          as("authenticated", user, () => db.query(read)),
          user,
        ).rejects.toThrow(/permission denied/);
      }
      await expect(as("anon", null, () => db.query(read))).rejects.toThrow(/permission denied/);
      expect(
        await rows("select kind, allowance, keeps_seen_days from public.action_kind_terms"),
      ).toEqual([{ kind: "sample", allowance: null, keeps_seen_days: 30 }]);
    });

    it("drop what one replaced once it may be kept no longer, and lapse a proposal waiting on it", async () => {
      const drop = () =>
        as("service_role", null, () =>
          rows<{ dropped: number }>("select public.drop_expired_seen() as dropped"),
        );
      const kept = (id: string | undefined) =>
        rows<Record<string, unknown>>(
          "select status, lapse_reason, seen, seen_dropped_at is not null as dropped, proposed_text, approved_by_email from public.actions where id = $1",
          [id],
        );
      for (const user of [alice, operator]) {
        await expect(
          as("authenticated", user, () => db.query("select public.drop_expired_seen()")),
          user,
        ).rejects.toThrow(/permission denied/);
      }

      const [waiting] = await propose("opening-line:h", "first");
      // What it read may be kept for as long as its kind says, counted from when it was read.
      expect(
        await rows(
          "select (seen_until - proposed_at)::text as kept_for from public.actions where id = $1",
          [waiting?.id],
        ),
      ).toEqual([{ kept_for: "30 days" }]);
      const [done] = await rows<{ id: string }>(
        "select id from public.actions where subject = 'opening-line:c'",
      );
      await db.query("update public.actions set seen_until = now() + interval '30 days'");
      expect(await drop()).toEqual([{ dropped: 0 }]);

      await db.query(
        "update public.actions set seen_until = now() - interval '1 minute' where id = any($1::uuid[])",
        [[done?.id, waiting?.id]],
      );
      expect(await drop()).toEqual([{ dropped: 2 }]);
      // The record keeps what the product wrote and who approved it, and says the rest is gone.
      expect(await kept(done?.id)).toEqual([
        {
          status: "done",
          lapse_reason: null,
          seen: null,
          dropped: true,
          proposed_text: "As proposed",
          approved_by_email: "alice@example.com",
        },
      ]);
      // Nobody can be shown what the waiting one would replace, so it is no longer one to answer.
      expect(await kept(waiting?.id)).toMatchObject([
        { status: "lapsed", lapse_reason: "out_of_date", seen: null, dropped: true },
      ]);
      expect(await drop()).toEqual([{ dropped: 0 }]);
    });

    it("mark the task one did the work of, which a member can then not take back", async () => {
      const proposeFor = (about: string, task: string | undefined, location = main) =>
        as("service_role", null, () =>
          rows<{ id: string; recommendation_id: string | null }>(
            "select id, recommendation_id from public.propose_action($1, 'sample', $2, $3, 'first', 'Set the opening line', '{\"text\": null}'::jsonb, 'New line', 'rule', $4)",
            [location, account, about, task],
          ),
        );
      const marked = (id: string | undefined) =>
        rows<{ acted: boolean; acted_by_action: string | null; status: string }>(
          "select acted_at is not null as acted, acted_by_action, status from public.recommendations where id = $1",
          [id],
        );
      const [task] = await rows<{ id: string }>(
        "insert into public.recommendations (location_id, rule, title, detail) values ($1, 'source:listing.example', 'Check the listing', 'Detail') returning id",
        [main],
      );
      const [elsewhere] = await rows<{ id: string }>(
        "insert into public.locations (organization_id, name, city) values ($1, 'Elsewhere', 'Raleigh') returning id",
        [theirs],
      );

      // A task belongs to the location its action is for.
      await expect(proposeFor("opening-line:i", task?.id, elsewhere?.id)).rejects.toThrow(
        /belongs to the location/,
      );
      await db.query("delete from public.locations where id = $1", [elsewhere?.id]);
      const [made] = await proposeFor("opening-line:i", task?.id);
      expect(made?.recommendation_id).toBe(task?.id);

      // Proposed, approved and tried, the task is still the member's to mark and unmark.
      await as("authenticated", alice, () => db.query(approve, [made?.id, null]));
      await as("authenticated", alice, () =>
        db.query("update public.recommendations set acted_at = now() where id = $1", [task?.id]),
      );
      expect(await claim(made?.id ?? "")).toEqual([{ try: 1 }]);
      await finish(made?.id ?? "", "again", "Not this time.");
      expect(await marked(task?.id)).toEqual([
        { acted: true, acted_by_action: null, status: "open" },
      ]);
      await as("authenticated", alice, () =>
        db.query("update public.recommendations set acted_at = null where id = $1", [task?.id]),
      );

      // Carried out, it is marked by the action, as of then.
      await db.query("update public.actions set carrying_since = null where id = $1", [made?.id]);
      expect(await claim(made?.id ?? "")).toEqual([{ try: 2 }]);
      await finish(made?.id ?? "", "done");
      expect(await marked(task?.id)).toEqual([
        { acted: true, acted_by_action: made?.id, status: "open" },
      ]);

      // The mark records something that happened: no member takes it back or moves its day.
      for (const user of [alice, member]) {
        for (const value of ["null", "now()"]) {
          await expect(
            as("authenticated", user, () =>
              db.query(`update public.recommendations set acted_at = ${value} where id = $1`, [
                task?.id,
              ]),
            ),
            `${user} ${value}`,
          ).rejects.toThrow(/stays marked done/);
        }
      }
      await expect(
        as("authenticated", alice, () =>
          db.query("update public.recommendations set acted_by_action = null where id = $1", [
            task?.id,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
      // Its status is still theirs.
      await as("authenticated", alice, () =>
        db.query("update public.recommendations set status = 'dismissed' where id = $1", [
          task?.id,
        ]),
      );
      expect(await marked(task?.id)).toEqual([
        { acted: true, acted_by_action: made?.id, status: "dismissed" },
      ]);

      // A later action for the same task leaves the first one's mark where it is.
      const [later] = await proposeFor("opening-line:j", task?.id);
      await as("authenticated", alice, () => db.query(approve, [later?.id, null]));
      await claim(later?.id ?? "");
      await finish(later?.id ?? "", "failed", "It could not be done.");
      // Asked for again, it is for the same task.
      const [again] = await as("authenticated", alice, () =>
        rows<{ id: string; recommendation_id: string | null }>(
          "select id, recommendation_id from public.retry_action($1)",
          [later?.id],
        ),
      );
      expect(again?.recommendation_id).toBe(task?.id);
      await claim(again?.id ?? "");
      await finish(again?.id ?? "", "done");
      expect(await marked(task?.id)).toMatchObject([{ acted_by_action: made?.id }]);
    });

    describe("of a kind that is counted", () => {
      const thisMonth = "date_trunc('month', now() at time zone 'UTC')::date";
      const used = async () =>
        (
          await rows<{ used: number }>(
            `select used from public.allowance_use where organization_id = $1 and kind = 'pretend_changes' and month = ${thisMonth}`,
            [theirs],
          )
        )[0]?.used ?? 0;
      const holds = async (id: string | undefined) =>
        (
          await rows<{ holds: boolean }>(
            "select allowance_month is not null as holds from public.actions where id = $1",
            [id],
          )
        )[0]?.holds;
      const noRoom = /no more of these this month/;
      let most: number;

      beforeAll(async () => {
        await db.query(
          "insert into public.allowance_kinds (key, counted) values ('pretend_changes', true), ('pretend_access', false)",
        );
        await db.query("update public.action_kind_terms set allowance = 'pretend_changes'");
        const [organization] = await rows<{ max_locations: number }>(
          "update public.organizations set allowances = '{\"pretend_changes\": 1}' where id = $1 returning max_locations",
          [theirs],
        );
        // One a month for each location the plan covers. All but one of them are used already.
        most = organization?.max_locations ?? 0;
        await db.query(
          `insert into public.allowance_use (organization_id, kind, month, used) values ($1, 'pretend_changes', ${thisMonth}, $2)`,
          [theirs, most - 1],
        );
      });
      afterAll(async () => {
        await db.query("update public.action_kind_terms set allowance = null");
        await db.query("delete from public.allowance_use where kind like 'pretend_%'");
        await db.query(
          "update public.organizations set allowances = allowances - 'pretend_changes' - 'pretend_access'",
        );
        await db.query("delete from public.allowance_kinds where key like 'pretend_%'");
      });

      it("take one from the month when the worker takes them, once, and not before", async () => {
        const [x] = await propose("opening-line:k", "first");
        const [y] = await propose("opening-line:l", "first");
        await as("authenticated", alice, () => db.query(approve, [x?.id, null]));
        await as("authenticated", alice, () => db.query(approve, [y?.id, null]));
        // Proposing and approving count nothing.
        expect(await used()).toBe(most - 1);
        expect(await holds(x?.id)).toBe(false);

        expect(await claim(x?.id ?? "")).toEqual([{ try: 1 }]);
        expect(await used()).toBe(most);
        expect(await holds(x?.id)).toBe(true);
        // A second try is the same action: it holds one already.
        await finish(x?.id ?? "", "again", "Not this time.");
        expect(await claim(x?.id ?? "")).toEqual([{ try: 2 }]);
        expect(await used()).toBe(most);

        // The month is used. One already approved is failed as it is taken, with the reason.
        expect(await claim(y?.id ?? "")).toEqual([{ try: 0 }]);
        expect(await stands(y?.id ?? "")).toEqual([
          {
            status: "failed",
            attempts: 0,
            carrying: false,
            failure: "Your plan has no more of these this month.",
            lapse_reason: null,
          },
        ]);
        expect(await used()).toBe(most);
      });

      it("are not proposed, approved or asked for again once the month is used", async () => {
        expect(await propose("opening-line:m", "first")).toEqual([]);
        const [y] = await rows<{ id: string }>(
          "select id from public.actions where subject = 'opening-line:l'",
        );
        await expect(
          as("authenticated", alice, () => db.query("select public.retry_action($1)", [y?.id])),
        ).rejects.toThrow(noRoom);
        // One proposed while there was room cannot be said yes to now.
        await db.query(
          "insert into public.actions (location_id, kind, subject, basis, summary, written_by) values ($1, 'sample', 'opening-line:n', 'first', 'Set the opening line', 'rule')",
          [main],
        );
        const [z] = await rows<{ id: string }>(
          "select id from public.actions where subject = 'opening-line:n'",
        );
        await expect(
          as("authenticated", alice, () => db.query(approve, [z?.id, null])),
        ).rejects.toThrow(noRoom);
        // A stranger is still told nothing.
        expect(await as("authenticated", bob, () => rows(approve, [z?.id, null]))).toEqual([]);
      });

      it("give it back when they end without the thing being done, and keep it when it is", async () => {
        const [x] = await rows<{ id: string }>(
          "select id from public.actions where subject = 'opening-line:k'",
        );
        const [y] = await rows<{ id: string }>(
          "select id from public.actions where subject = 'opening-line:l'",
        );
        await finish(x?.id ?? "", "failed", "It could not be done.");
        expect(await used()).toBe(most - 1);
        expect(await holds(x?.id)).toBe(false);

        // There is room again, so the one that found none can be asked for again.
        const [again] = await as("authenticated", alice, () =>
          rows<{ id: string }>("select id from public.retry_action($1)", [y?.id]),
        );
        expect(await claim(again?.id ?? "")).toEqual([{ try: 1 }]);
        expect(await used()).toBe(most);
        await finish(again?.id ?? "", "out_of_date");
        expect(await used()).toBe(most - 1);

        const [z] = await rows<{ id: string }>(
          "select id from public.actions where subject = 'opening-line:n'",
        );
        await as("authenticated", alice, () => db.query(approve, [z?.id, null]));
        await claim(z?.id ?? "");
        await finish(z?.id ?? "", "done");
        expect(await used()).toBe(most);
        expect(await holds(z?.id)).toBe(true);
      });

      it("are given back and asked about by the worker alone", async () => {
        for (const user of [alice, operator]) {
          for (const call of [
            `select public.release_allowance('${theirs}', 'pretend_changes', ${thisMonth})`,
            `select public.allowance_has_room('${theirs}', 'pretend_changes')`,
          ]) {
            await expect(
              as("authenticated", user, () => db.query(call)),
              `${user} ${call}`,
            ).rejects.toThrow(/permission denied/);
          }
        }
        const release = (amount: number) =>
          as("service_role", null, () =>
            rows<{ left: number | null }>(
              `select public.release_allowance($1, 'pretend_changes', ${thisMonth}, $2) as left`,
              [theirs, amount],
            ),
          );
        expect(await release(1)).toEqual([{ left: most - 1 }]);
        // Never below nothing, and never for a month nothing was counted in.
        expect(await release(most + 5)).toEqual([{ left: 0 }]);
        expect(
          await as("service_role", null, () =>
            rows("select public.release_allowance($1, 'pretend_changes', '2020-01-01') as left", [
              theirs,
            ]),
          ),
        ).toEqual([{ left: null }]);
        await expect(release(0)).rejects.toThrow(/one or more at a time/);
      });

      it("count nothing for a kind included without a number, and are not proposed for one that is not included", async () => {
        await db.query("update public.action_kind_terms set allowance = 'pretend_access'");
        // Not included: nothing is proposed.
        expect(await propose("opening-line:o", "first")).toEqual([]);

        await db.query(
          "update public.organizations set allowances = allowances || '{\"pretend_access\": true}' where id = $1",
          [theirs],
        );
        const [made] = await propose("opening-line:o", "first");
        await as("authenticated", alice, () => db.query(approve, [made?.id, null]));
        expect(await claim(made?.id ?? "")).toEqual([{ try: 1 }]);
        expect(await holds(made?.id)).toBe(false);
        expect(
          await rows("select 1 from public.allowance_use where kind = 'pretend_access'"),
        ).toEqual([]);
        await finish(made?.id ?? "", "done");
      });
    });

    it("go with their location", async () => {
      const [gone] = await rows<{ id: string }>(
        "insert into public.locations (organization_id, name, city) values ($1, 'Closing', 'Raleigh') returning id",
        [theirs],
      );
      await db.query(
        "insert into public.actions (location_id, kind, subject, basis, summary, written_by) values ($1, 'sample', 'a', 'b', 'Summary', 'rule')",
        [gone?.id],
      );
      await db.query("delete from public.locations where id = $1", [gone?.id]);
      expect(await rows("select 1 from public.actions where subject = 'a'")).toEqual([]);
    });
  });

  describe("alerts", () => {
    const facts = { prompt: "x", missed: 3, checks_before: 4, named_before: 4 };
    let main: string;
    let prompt: string;
    const made: string[] = [];

    /** A scan of the location, finished by the worker with what its rules cleared and raised. */
    async function finish(
      alerts: {
        clear?: { id: string; reason: string }[];
        /** A drop's subject, or a whole alert of another kind. */
        raise?: (string | Record<string, unknown>)[];
      } | null,
      options: { location?: string; sample?: boolean } = {},
    ) {
      const [scan] = await rows<{ id: string }>(
        "insert into public.scans (location_id, trigger, status, sample_data) values ($1, 'scheduled', 'running', $2) returning id",
        [options.location ?? main, options.sample ?? false],
      );
      made.push(scan?.id ?? "");
      const changes = alerts && {
        clear: alerts.clear ?? [],
        raise: (alerts.raise ?? []).map((raised) =>
          typeof raised === "string"
            ? {
                kind: "drop",
                subject: raised,
                tracked_query_id: prompt,
                surface: "chatgpt",
                facts,
                since: "2026-10-05T09:00:00Z",
              }
            : { since: "2026-10-05T09:00:00Z", ...raised },
        ),
      };
      await as("service_role", null, () =>
        changes
          ? db.query("select public.complete_scan($1, 50, '[]'::jsonb, '[]'::jsonb, $2::jsonb)", [
              scan?.id,
              JSON.stringify(changes),
            ])
          : // As the Worker deployed before alerts existed calls it.
            db.query("select public.complete_scan($1, 50, '[]'::jsonb, '[]'::jsonb)", [scan?.id]),
      );
      return scan?.id ?? "";
    }
    const alerts = (where = "true") =>
      rows<Record<string, unknown>>(
        `select id, subject, scan_id, sample_data, cleared_at is not null as cleared, clear_reason, dismissed_at is not null as dismissed, dismissed_by_email from public.alerts where ${where} order by raised_at, id`,
      );
    const dismiss = "select id, dismissed_by_email from public.dismiss_alert($1)";

    beforeAll(async () => {
      const [location] = await rows<{ id: string; query: string }>(
        "select l.id, q.id as query from public.locations l join public.tracked_queries q on q.location_id = l.id where l.organization_id = $1 limit 1",
        [theirs],
      );
      main = location?.id ?? "";
      prompt = location?.query ?? "";
    });
    afterAll(async () => {
      await db.query("delete from public.alerts");
      await db.query("delete from public.scans where id = any($1::uuid[])", [made]);
    });

    it("are raised by the worker when a scan finishes, once while one for the thing is current", async () => {
      const scan = await finish({ raise: ["prompt-a|chatgpt"] });
      expect(await alerts()).toEqual([
        {
          id: expect.any(String),
          subject: "prompt-a|chatgpt",
          scan_id: scan,
          sample_data: false,
          cleared: false,
          clear_reason: null,
          dismissed: false,
          dismissed_by_email: null,
        },
      ]);
      const [kept] = await rows<{ location_id: string; facts: unknown; kind: string }>(
        "select location_id, facts, kind from public.alerts",
      );
      expect(kept).toEqual({ location_id: main, facts, kind: "drop" });

      // The next scan's rule fires for the same thing. The alert is not kept a second time.
      await finish({ raise: ["prompt-a|chatgpt", "prompt-b|chatgpt"] });
      expect((await alerts()).map((alert) => alert.subject)).toEqual([
        "prompt-a|chatgpt",
        "prompt-b|chatgpt",
      ]);
    });

    it("are left alone by a scan finished the way the Worker before them finishes one", async () => {
      const before = await alerts();
      await finish(null);
      expect(await alerts()).toEqual(before);
    });

    it("are read by whoever reads the location and by the operator, and written by no one directly", async () => {
      const read = "select id from public.alerts where location_id = $1";
      for (const user of [alice, operator]) {
        expect(await as("authenticated", user, () => rows(read, [main])), user).toHaveLength(2);
      }
      expect(await as("authenticated", bob, () => rows(read, [main]))).toEqual([]);
      await expect(as("anon", null, () => db.query(read, [main]))).rejects.toThrow(
        /permission denied/,
      );
      for (const sql of [
        `insert into public.alerts (location_id, kind, subject, facts, since) values ('${main}', 'drop', 'planted', '{}'::jsonb, now())`,
        "update public.alerts set cleared_at = now(), clear_reason = 'named_again'",
        "update public.alerts set dismissed_at = now()",
        "update public.alerts set told_at = now(), cleared_told_at = now()",
        "delete from public.alerts",
        `select public.complete_scan('${made[0]}', 50, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)`,
      ]) {
        for (const user of [alice, operator]) {
          await expect(
            as("authenticated", user, () => db.query(sql)),
            sql,
          ).rejects.toThrow(/permission denied/);
        }
      }
    });

    it("are dismissed by a member of the organization, and by nobody else", async () => {
      const [first] = await alerts("subject = 'prompt-a|chatgpt'");
      for (const user of [bob, operator]) {
        expect(await as("authenticated", user, () => rows(dismiss, [first?.id])), user).toEqual([]);
      }
      // The worker is nobody's member either.
      expect(await as("service_role", null, () => rows(dismiss, [first?.id]))).toEqual([]);
      await expect(as("anon", null, () => db.query(dismiss, [first?.id]))).rejects.toThrow(
        /permission denied/,
      );
      expect((await alerts("subject = 'prompt-a|chatgpt'"))[0]?.dismissed).toBe(false);

      expect(await as("authenticated", alice, () => rows(dismiss, [first?.id]))).toEqual([
        { id: first?.id, dismissed_by_email: "alice@example.com" },
      ]);
      const [at] = await rows<{ at: string }>(
        "select dismissed_at::text as at from public.alerts where id = $1",
        [first?.id],
      );
      // Dismissing it again changes nothing.
      await as("authenticated", alice, () => rows(dismiss, [first?.id]));
      expect(
        await rows("select dismissed_at::text as at from public.alerts where id = $1", [first?.id]),
      ).toEqual([at]);
    });

    it("stay in the way of the same thing once dismissed, until the worker clears them", async () => {
      const [dismissed] = await alerts("subject = 'prompt-a|chatgpt'");
      await finish({ raise: ["prompt-a|chatgpt"] });
      expect(await alerts("subject = 'prompt-a|chatgpt'")).toHaveLength(1);

      await finish({ clear: [{ id: String(dismissed?.id), reason: "named_again" }] });
      expect(await alerts("subject = 'prompt-a|chatgpt'")).toMatchObject([
        { cleared: true, clear_reason: "named_again", dismissed: true },
      ]);

      // It has ended, so the same thing beginning afresh is a new alert.
      await finish({ raise: ["prompt-a|chatgpt"] });
      expect(
        (await alerts("subject = 'prompt-a|chatgpt'")).map((alert) => [
          alert.cleared,
          alert.dismissed,
        ]),
      ).toEqual([
        [true, true],
        [false, false],
      ]);
    });

    it("are cleared only once, and only for the location whose scan it is", async () => {
      const [other] = await rows<{ id: string }>(
        "insert into public.locations (organization_id, name, city) values ($1, 'Elsewhere', 'Raleigh') returning id",
        [theirs],
      );
      const [current] = await alerts("subject = 'prompt-b|chatgpt'");
      // A scan of another location names this one's alert. Nothing is cleared.
      await finish(
        { clear: [{ id: String(current?.id), reason: "not_tracked" }] },
        { location: other?.id },
      );
      expect((await alerts("subject = 'prompt-b|chatgpt'"))[0]?.cleared).toBe(false);

      await finish({ clear: [{ id: String(current?.id), reason: "not_tracked" }] });
      await finish({ clear: [{ id: String(current?.id), reason: "named_again" }] });
      expect(await alerts("subject = 'prompt-b|chatgpt'")).toMatchObject([
        { cleared: true, clear_reason: "not_tracked" },
      ]);
      // A member has nothing to dismiss in a cleared alert, and is not refused.
      expect(await as("authenticated", alice, () => rows(dismiss, [current?.id]))).toHaveLength(1);
      expect((await alerts("subject = 'prompt-b|chatgpt'"))[0]?.dismissed).toBe(false);
      await db.query("delete from public.locations where id = $1", [other?.id]);
    });

    it("are kept apart for sample scans and real ones", async () => {
      await finish({ raise: ["prompt-a|chatgpt"] }, { sample: true });
      expect(
        (await alerts("subject = 'prompt-a|chatgpt' and cleared_at is null")).map(
          (alert) => alert.sample_data,
        ),
      ).toEqual([false, true]);
    });

    it("are cleared with a reason, or not at all", async () => {
      await expect(
        db.query("update public.alerts set cleared_at = now() where cleared_at is null"),
      ).rejects.toThrow(/check constraint/);
      await expect(
        db.query(
          "update public.alerts set cleared_at = now(), clear_reason = 'bored' where cleared_at is null",
        ),
      ).rejects.toThrow(/check constraint/);
    });

    it("are also of a business or a site seen for the first time, about no one prompt", async () => {
      await finish({
        raise: [
          { kind: "competitor", subject: "oak and ember", facts: { name: "Oak & Ember" } },
          { kind: "site", subject: "raleighfood.example", facts: { host: "raleighfood.example" } },
        ],
      });
      const sightings = await rows<{ id: string; kind: string }>(
        "select id, kind, tracked_query_id, surface from public.alerts where kind <> 'drop' order by kind",
      );
      expect(sightings).toEqual([
        { id: expect.any(String), kind: "competitor", tracked_query_id: null, surface: null },
        { id: expect.any(String), kind: "site", tracked_query_id: null, surface: null },
      ]);
      // One at a time for a business, as for anything else.
      await finish({
        raise: [{ kind: "competitor", subject: "oak and ember", facts: { name: "Oak and Ember" } }],
      });
      expect(await rows("select 1 from public.alerts where kind = 'competitor'")).toHaveLength(1);

      // It is news and nothing ends it, so it is cleared as old news.
      await finish({ clear: sightings.map(({ id }) => ({ id, reason: "old_news" })) });
      expect(
        await rows("select clear_reason from public.alerts where kind <> 'drop' order by kind"),
      ).toEqual([{ clear_reason: "old_news" }, { clear_reason: "old_news" }]);
    });

    it("rest on a record only the worker reads: what earlier scans' answers named and cited", async () => {
      const [place] = await rows<{ id: string }>(
        "insert into public.locations (organization_id, name, city) values ($1, 'Long record', 'Raleigh') returning id",
        [theirs],
      );
      const [asked] = await rows<{ id: string }>(
        "insert into public.tracked_queries (location_id, kind, text) values ($1, 'ai_prompt', 'y') returning id",
        [place?.id],
      );
      /** A scan `days` old with one result on a surface. */
      const scanned = async (
        days: number,
        surface: string,
        names: string[],
        urls: string[],
        options: { status?: string; sample?: boolean } = {},
      ) => {
        const [scan] = await rows<{ id: string }>(
          "insert into public.scans (location_id, trigger, status, sample_data, created_at) values ($1, 'scheduled', $2, $3, now() - make_interval(days => $4)) returning id",
          [place?.id, options.status ?? "succeeded", options.sample ?? false, days],
        );
        await db.query(
          "insert into public.scan_results (scan_id, tracked_query_id, surface, mentioned, competitors, cited_urls) values ($1, $2, $3, false, $4::jsonb, $5::jsonb)",
          [scan?.id, asked?.id, surface, JSON.stringify(names), JSON.stringify(urls)],
        );
      };
      await scanned(
        9,
        "chatgpt",
        ["Old Timer"],
        ["https://www.yelp.com/biz/a", "https://www.yelp.com/biz/b?x=1"],
      );
      await scanned(
        8,
        "gemini",
        ["Old Timer", "Second"],
        ["http://Example.org:8080/page#part", "not an address"],
      );
      // A list of results is not a written answer.
      await scanned(7, "google_local_pack", ["Listed Only"], ["https://listed.example/"]);
      await scanned(6, "chatgpt", ["Sample Only"], ["https://sample.example/"], { sample: true });
      await scanned(5, "chatgpt", ["Never Finished"], ["https://failed.example/"], {
        status: "failed",
      });
      await scanned(2, "chatgpt", ["Recent"], ["https://recent.example/x"]);
      await scanned(1, "chatgpt", ["Newest"], ["https://newest.example/x"]);

      const seen = async (sample: boolean, skip: number) => {
        const [found] = await as("service_role", null, () =>
          rows<{ seen: { competitors: string[]; origins: string[] } }>(
            "select public.seen_before($1, $2, $3, '{chatgpt,gemini}') as seen",
            [place?.id, sample, skip],
          ),
        );
        return {
          competitors: [...(found?.seen.competitors ?? [])].sort(),
          origins: [...(found?.seen.origins ?? [])].sort(),
        };
      };
      // Leaving out the two newest finished scans: each business once, as it was written, and
      // each page's address up to its path.
      expect(await seen(false, 2)).toEqual({
        competitors: ["Old Timer", "Second"],
        origins: ["http://Example.org:8080", "https://www.yelp.com", "not an address"],
      });
      expect((await seen(false, 0)).competitors).toEqual([
        "Newest",
        "Old Timer",
        "Recent",
        "Second",
      ]);
      expect(await seen(false, 20)).toEqual({ competitors: [], origins: [] });
      expect(await seen(true, 0)).toEqual({
        competitors: ["Sample Only"],
        origins: ["https://sample.example"],
      });

      for (const user of [alice, operator]) {
        await expect(
          as("authenticated", user, () =>
            db.query("select public.seen_before($1, false, 0, '{chatgpt}')", [place?.id]),
          ),
        ).rejects.toThrow(/permission denied/);
      }
      await db.query("delete from public.locations where id = $1", [place?.id]);
    });

    it("keep whether the owners were told, which only the worker writes", async () => {
      await finish({ raise: ["prompt-told|chatgpt"] });
      const untold =
        "select id from public.alerts where subject = 'prompt-told|chatgpt' and told_at is null";
      expect(await rows(untold)).toHaveLength(1);
      await as("service_role", null, () =>
        db.query("update public.alerts set told_at = now() where subject = 'prompt-told|chatgpt'"),
      );
      expect(await rows(untold)).toEqual([]);
      expect(
        await rows(
          "select 1 from public.alerts where subject = 'prompt-told|chatgpt' and cleared_told_at is null",
        ),
      ).toHaveLength(1);
    });

    it("go with their location", async () => {
      const [gone] = await rows<{ id: string }>(
        "insert into public.locations (organization_id, name, city) values ($1, 'Closing', 'Raleigh') returning id",
        [theirs],
      );
      await db.query(
        "insert into public.alerts (location_id, kind, subject, facts, since) values ($1, 'drop', 'closing', '{}'::jsonb, now())",
        [gone?.id],
      );
      await db.query("delete from public.locations where id = $1", [gone?.id]);
      expect(await rows("select 1 from public.alerts where subject = 'closing'")).toEqual([]);
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
