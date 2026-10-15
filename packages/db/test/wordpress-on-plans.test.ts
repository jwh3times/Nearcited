import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The migration that puts publishing to a WordPress site on the plans changes rows that are
 * already there, so it is run here against a database that has some: every migration before it,
 * then organizations on each plan, then the migration itself.
 */

const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
const shim = readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8");
const TURNS_ON = "20261014110000_wordpress_connections.sql";

const owner = "a0000000-0000-4000-8000-000000000001";

let db: PGlite;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function onPlan(name: string, plan: string, test = false): Promise<string> {
  const [made] = await rows<{ id: string }>(
    "insert into public.organizations (name, created_by, is_test) values ($1, $2, $3) returning id",
    [name, owner, test],
  );
  await db.query("select public.apply_plan($1, $2)", [made?.id, plan]);
  return made?.id ?? "";
}
const allows = async (id: string) =>
  (
    await rows<{ allowed: boolean }>(
      "select public.allows_connection($1, 'wordpress') as allowed",
      [id],
    )
  )[0]?.allowed;

describe("putting WordPress on the plans", () => {
  const made: Record<string, string> = {};

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(shim);
    const files = readdirSync(migrationsDir).sort();
    expect(files).toContain(TURNS_ON);
    for (const file of files.filter((name) => name < TURNS_ON)) {
      await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }
    await db.query("insert into auth.users (id, email) values ($1, 'owner@example.com')", [owner]);
    for (const plan of ["free", "starter", "standard", "pro", "enterprise"]) {
      made[plan] = await onPlan(`On ${plan}`, plan);
    }
    made.test = await onPlan("A test organization", "free", true);
    await db.query(
      "update public.organizations set allowances = public.test_allowances() where id = $1",
      [made.test],
    );
    made.byHand = await onPlan("Set by hand", "pro");
    await db.query("update public.organizations set plan_key = null where id = $1", [made.byHand]);
  });
  afterAll(async () => {
    await db.close();
  });

  it("starts with the kind on no plan", async () => {
    expect(
      await rows("select key from public.plans where allowances ? 'wordpress' order by position"),
    ).toEqual([]);
    // Until the kind needs an allowance, nothing asks for one.
    expect(await rows("select kind from public.connection_kind_allowances")).toEqual([]);
  });

  it("puts it on Pro and Enterprise, and on no other plan", async () => {
    await db.exec(readFileSync(join(migrationsDir, TURNS_ON), "utf8"));
    expect(
      await rows("select key from public.plans where allowances ? 'wordpress' order by position"),
    ).toEqual([{ key: "pro" }, { key: "enterprise" }]);
    expect(await rows("select kind, allowance from public.connection_kind_allowances")).toEqual([
      { kind: "wordpress", allowance: "wordpress" },
    ]);
  });

  it("lets an organization on those plans connect a site, and no other", async () => {
    for (const plan of ["free", "starter", "standard"]) {
      expect(await allows(made[plan] ?? ""), plan).toBe(false);
    }
    for (const plan of ["pro", "enterprise"])
      expect(await allows(made[plan] ?? ""), plan).toBe(true);
    // An organization on no plan gets nothing from a plan.
    expect(await allows(made.byHand ?? "")).toBe(false);
    // A test organization has had every kind since the kind was added.
    expect(await allows(made.test ?? "")).toBe(true);
  });

  it("is what an organization gets when it joins a plan afterwards, and loses when it leaves", async () => {
    const joined = await onPlan("Joined later", "pro");
    expect(await allows(joined)).toBe(true);
    await db.query("select public.apply_plan($1, 'standard')", [joined]);
    expect(await allows(joined)).toBe(false);
  });
});
