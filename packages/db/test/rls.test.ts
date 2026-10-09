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
      max_manual_scans_per_day: 500,
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
    const [fresh] = await as("authenticated", bob, () =>
      rows<{ is_test: boolean }>("select is_test from public.create_organization('Bob''s')"),
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
      "delete from public.organizations where id = $1",
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

  describe("changing an organization's limits", () => {
    const setLimits = "select * from public.operator_set_limits($1, 3, 20, 10, 1)";
    const limits = (id: string) =>
      rows<Record<string, number>>(
        "select max_locations, max_queries_per_location, max_manual_scans_per_day, scan_every_days from public.organizations where id = $1",
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
      const [before] = await rows<Record<string, unknown>>(
        "select * from public.organizations where id = $1",
        [theirs],
      );
      const [after] = await as("authenticated", operator, () =>
        rows<Record<string, unknown>>(setLimits, [theirs]),
      );
      const changed = {
        max_locations: 3,
        max_queries_per_location: 20,
        max_manual_scans_per_day: 10,
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
              max_locations: before?.max_locations,
              max_queries_per_location: before?.max_queries_per_location,
              max_manual_scans_per_day: before?.max_manual_scans_per_day,
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
});
