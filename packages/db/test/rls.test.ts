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
