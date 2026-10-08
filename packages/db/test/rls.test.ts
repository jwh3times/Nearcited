import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

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

  it("start a new organization on the defaults", async () => {
    const [org] = await rows<Record<string, number>>(
      "select max_locations, max_queries_per_location, max_manual_scans_per_day from public.organizations where id = $1",
      [orgId],
    );
    expect(org).toEqual({
      max_locations: 1,
      max_queries_per_location: 10,
      max_manual_scans_per_day: 5,
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
       where l.organization_id = $1 and s.trigger = 'manual' and s.requested_by is not null`,
      [orgId],
    );
    await setLimits(`max_manual_scans_per_day = ${used}`);
    await expect(manualScan(second)).rejects.toThrow(/manual scans? in 24 hours/);

    // The schedule is not a member asking, so it is not counted.
    const [scheduled] = await as("service_role", null, () =>
      rows<{ id: string }>(
        "insert into public.scans (location_id, trigger) values ($1, 'scheduled') returning id",
        [second],
      ),
    );
    expect(scheduled?.id).toBeTruthy();
    await db.query("update public.scans set status = 'failed' where id = $1", [scheduled?.id]);

    await setLimits(`max_manual_scans_per_day = ${used + 1}`);
    const [allowed] = await manualScan(second);
    expect(allowed?.id).toBeTruthy();
  });

  it("cannot be raised by a member, who can still rename the organization", async () => {
    for (const column of [
      "max_locations",
      "max_queries_per_location",
      "max_manual_scans_per_day",
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

  it("start a new organization on every two days and every surface", async () => {
    // Bob has no organization yet, so this one starts with nothing else in it.
    const [org] = await as("authenticated", bob, () =>
      rows<{ id: string; scan_every_days: number; surfaces: string[] | null }>(
        "select * from public.create_organization('Cadence Org')",
      ),
    );
    cadenceOrg = org?.id ?? "";
    expect(org).toMatchObject({ scan_every_days: 2, surfaces: null });

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
      await expect(as(role, user, () => db.query("select * from public.audits"))).rejects.toThrow(
        /permission denied/,
      );
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
