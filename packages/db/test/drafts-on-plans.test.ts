import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The migration that puts drafts on the plans changes rows that are already there, so it is run
 * here against a database that has some: every migration before it, then organizations on each
 * plan, then the migration itself.
 */

const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
const shim = readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8");
const TURNS_ON = "20261012180000_drafts_on_plans.sql";

const owner = "a0000000-0000-4000-8000-000000000001";

let db: PGlite;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

/** An organization on a plan, as the worker puts one there. */
async function onPlan(name: string, plan: string, test = false): Promise<string> {
  const [made] = await rows<{ id: string }>(
    "insert into public.organizations (name, created_by, is_test) values ($1, $2, $3) returning id",
    [name, owner, test],
  );
  await db.query("select public.apply_plan($1, $2)", [made?.id, plan]);
  return made?.id ?? "";
}
const allowances = async (id: string) =>
  (
    await rows<{ allowances: Record<string, unknown> }>(
      "select allowances from public.organizations where id = $1",
      [id],
    )
  )[0]?.allowances;

describe("putting drafts on the plans", () => {
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
    // A test organization is given every kind when it is made, and is on a plan in name only.
    made.test = await onPlan("A test organization", "starter", true);
    await db.query(
      "update public.organizations set allowances = public.test_allowances() where id = $1",
      [made.test],
    );
    // One whose limits the operator set for it alone.
    made.special = await onPlan("A special case", "standard");
    await db.query("update public.organizations set max_queries_per_location = 40 where id = $1", [
      made.special,
    ]);
  });
  afterAll(async () => {
    await db.close();
  });

  it("starts from plans with none, and organizations with none", async () => {
    expect(
      await rows("select key from public.plans where allowances ? 'drafts' order by position"),
    ).toEqual([]);
    expect(await allowances(made.pro ?? "")).toEqual({});
    // A test organization had the kind from the day it was made.
    expect(await allowances(made.test ?? "")).toEqual({ drafts: 1000 });
  });

  it("gives each paid plan its number, and the free plan none", async () => {
    await db.exec(readFileSync(join(migrationsDir, TURNS_ON), "utf8"));
    expect(await rows("select key, allowances from public.plans order by position")).toEqual([
      { key: "free", allowances: {} },
      { key: "starter", allowances: { drafts: 10 } },
      { key: "standard", allowances: { drafts: 30 } },
      { key: "pro", allowances: { drafts: 60 } },
      { key: "enterprise", allowances: { drafts: 60 } },
    ]);
  });

  it("gives an organization already on a plan what its plan now has", async () => {
    expect(await allowances(made.free ?? "")).toEqual({});
    expect(await allowances(made.starter ?? "")).toEqual({ drafts: 10 });
    expect(await allowances(made.standard ?? "")).toEqual({ drafts: 30 });
    expect(await allowances(made.pro ?? "")).toEqual({ drafts: 60 });
    expect(await allowances(made.enterprise ?? "")).toEqual({ drafts: 60 });
  });

  it("leaves a test organization its own number, and everything else an organization had", async () => {
    expect(await allowances(made.test ?? "")).toEqual({ drafts: 1000 });
    expect(
      await rows(
        "select max_queries_per_location, allowances from public.organizations where id = $1",
        [made.special],
      ),
    ).toEqual([{ max_queries_per_location: 40, allowances: { drafts: 30 } }]);
  });

  it("is what an organization gets when it joins a plan afterwards", async () => {
    const joined = await onPlan("Joined later", "pro");
    expect(await allowances(joined)).toEqual({ drafts: 60 });
    await db.query("select public.apply_plan($1, 'free')", [joined]);
    expect(await allowances(joined)).toEqual({});
  });

  it("makes the month's number the plan's for each location it covers", async () => {
    // Standard covers three locations: thirty a month for each.
    const claim = await rows<{ claimed: boolean; allowed: number; used: number }>(
      "select * from public.claim_allowance($1, 'drafts')",
      [made.standard],
    );
    expect(claim).toEqual([{ claimed: true, allowed: 90, used: 1 }]);
  });
});
