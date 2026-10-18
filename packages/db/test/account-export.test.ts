import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  AccountExportSchema,
  EXPORT_SHEETS,
  type ExportList,
  exportColumns,
} from "@nearcited/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Downloading everything (issue #210): `export_organization()` answers an organization's owner
 * with all it holds, in the export's own shape, and answers nobody else.
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

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await rows<T>(sql, params);
  if (!row) throw new Error(`No row: ${sql}`);
  return row;
}

/** An organization of `by`'s with a location that has a prompt, a scan, a task and more. */
async function seeded(name: string, by: string) {
  const { id: org } = await one<{ id: string }>(
    "insert into public.organizations (name, created_by) values ($1, $2) returning id",
    [name, by],
  );
  await db.query(
    "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'owner')",
    [org, by],
  );
  const { id: location } = await one<{ id: string }>(
    "insert into public.locations (organization_id, name, city, website) values ($1, $2, 'Raleigh', 'https://www.joespizza.example') returning id",
    [org, name],
  );
  const { id: query } = await one<{ id: string }>(
    "insert into public.tracked_queries (location_id, kind, text) values ($1, 'ai_prompt', 'late night pizza') returning id",
    [location],
  );
  const { id: scan } = await one<{ id: string }>(
    "insert into public.scans (location_id, trigger, status) values ($1, 'manual', 'succeeded') returning id",
    [location],
  );
  await db.query(
    `insert into public.scan_results (scan_id, tracked_query_id, surface, mentioned, answer_excerpt)
     values ($1, $2, 'chatgpt', true, $3)`,
    [scan, query, `${name} is open late.`],
  );
  const { id: task } = await one<{ id: string }>(
    "insert into public.recommendations (location_id, scan_id, rule, title, detail) values ($1, $2, 'site_hours', 'Add your hours', 'Say when you are open.') returning id",
    [location, scan],
  );
  await db.query("insert into public.drafts (location_id, recommendation_id) values ($1, $2)", [
    location,
    task,
  ]);
  await db.query(
    "insert into public.prompt_pages (location_id, recommendation_id, url) values ($1, $2, 'https://www.joespizza.example/late-night')",
    [location, task],
  );
  await db.query(
    "insert into public.actions (location_id, kind, subject, basis, summary, written_by) values ($1, 'sample', 'listing', 'hours', 'Fix the hours', 'rule')",
    [location],
  );
  const { id: connection } = await one<{ id: string }>(
    "insert into public.connections (id, organization_id, kind, label) values (gen_random_uuid(), $1, 'wordpress', 'joespizza.example') returning id",
    [org],
  );
  await db.query(
    "insert into public.connection_secrets (connection_id, sealed) values ($1, 'sealed-sign-in-never-exported')",
    [connection],
  );
  await db.query(
    "insert into public.listings (location_id, site, url) values ($1, 'yelp', 'https://www.yelp.com/biz/joes')",
    [location],
  );
  await db.query(
    "insert into public.visits (location_id, day, assistant, path, count) values ($1, current_date, 'chatgpt', '/menu', 3)",
    [location],
  );
  await db.query(
    `insert into public.provider_usage (organization_id, model, calls, input_tokens, cached_input_tokens, output_tokens, searches)
     values ($1, 'priced-model-never-exported', 1, 1000, 0, 10, 1)`,
    [org],
  );
  await db.query(
    "insert into public.operator_actions (organization_id, action, detail) values ($1, 'set_limits', '{\"note\": \"operator-log-never-exported\"}')",
    [org],
  );
  return { org, location };
}

const exportOf = async (userId: string | null, org: string) =>
  (
    await as(userId ? "authenticated" : "anon", userId, () =>
      rows<{ export: unknown }>("select public.export_organization($1) as export", [org]),
    )
  )[0]?.export;

describe("downloading everything", () => {
  let org: string;
  let location: string;

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
    ({ org, location } = await seeded("Joe's Pizza", owner));
    await db.query(
      "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'admin')",
      [org, member, admin],
    );
    await seeded("Carol's Cafe", stranger);
  });
  afterAll(async () => {
    await db.close();
  });

  it("answers an owner with everything the organization holds, in the export's shape", async () => {
    const exported = AccountExportSchema.parse(await exportOf(owner, org));
    // Whether Google showed anything for each search goes with it.
    expect(exported.answers.map((row) => row.shown)).toEqual([true]);
    expect(exported.organization.id).toBe(org);
    expect(exported.locations.map((row) => row.id)).toEqual([location]);
    expect(exported.prompts).toHaveLength(1);
    expect(exported.scans).toHaveLength(1);
    expect(exported.answers.map((row) => row.answer_excerpt)).toEqual([
      "Joe's Pizza is open late.",
    ]);
    expect(exported.tasks).toHaveLength(1);
    expect(exported.actions).toHaveLength(1);
    expect(exported.connections.map((row) => row.label)).toEqual(["joespizza.example"]);
    expect(exported.listings.map((row) => row.site)).toEqual(["yelp"]);
    expect(exported.visits.map((row) => row.count)).toEqual([3]);
    expect(exported.members.map((row) => [row.email, row.role])).toEqual([
      ["owner@example.com", "owner"],
      ["admin@example.com", "admin"],
      ["member@example.com", "member"],
    ]);
  });

  it("gives each row exactly the columns of its wire type, which the spreadsheets are made from", async () => {
    const exported = (await exportOf(owner, org)) as Record<string, unknown>;
    for (const list of Object.keys(EXPORT_SHEETS) as ExportList[]) {
      const value = exported[list];
      const [row] = (Array.isArray(value) ? value : [value]) as Record<string, unknown>[];
      if (!row) continue;
      expect(Object.keys(row).sort(), list).toEqual(exportColumns(list).sort());
    }
  });

  it("holds no sign-in, nothing the providers were paid and nothing of another's", async () => {
    const text = JSON.stringify(await exportOf(owner, org));
    expect(text).not.toContain("sealed-sign-in-never-exported");
    expect(text).not.toContain("priced-model-never-exported");
    expect(text).not.toContain("operator-log-never-exported");
    expect(text).not.toContain("Carol's Cafe");
  });

  it("answers nobody but an owner, the operator included", async () => {
    for (const user of [member, admin, stranger, operator]) {
      expect(await exportOf(user, org)).toBeNull();
    }
    await expect(exportOf(null, org)).rejects.toThrow(/permission denied/);
  });
});
