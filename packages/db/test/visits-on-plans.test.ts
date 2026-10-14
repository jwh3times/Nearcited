import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The migration that puts visits on the plans changes rows that are already there, so it is run
 * here against a database that has some: every migration before it, then organizations on each
 * plan, then the migration itself.
 */

const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
const shim = readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8");
const TURNS_ON = "20261013220000_visits_shown.sql";

const owner = "a0000000-0000-4000-8000-000000000001";

let db: PGlite;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

/** An organization on a plan, as the worker puts one there, with one location and its site. */
async function onPlan(name: string, plan: string, test = false): Promise<string> {
  const [made] = await rows<{ id: string }>(
    "insert into public.organizations (name, created_by, is_test) values ($1, $2, $3) returning id",
    [name, owner, test],
  );
  await db.query("select public.apply_plan($1, $2)", [made?.id, plan]);
  await db.query(
    "insert into public.locations (organization_id, name, city, website) values ($1, $2, 'Raleigh', 'https://joes.example')",
    [made?.id, name],
  );
  return made?.id ?? "";
}
const allowances = async (id: string) =>
  (
    await rows<{ allowances: Record<string, unknown> }>(
      "select allowances from public.organizations where id = $1",
      [id],
    )
  )[0]?.allowances;
/** Whether a visit to the organization's location is counted, as its site would report one. */
async function counts(id: string): Promise<boolean | undefined> {
  const [line] = await rows<{ key: string }>(
    "select v.key from public.visit_lines v join public.locations l on l.id = v.location_id where l.organization_id = $1",
    [id],
  );
  await db.exec("set role anon");
  try {
    return (
      await rows<{ counted: boolean }>(
        "select public.record_visit($1, 'joes.example', 'chatgpt', '/') as counted",
        [line?.key],
      )
    )[0]?.counted;
  } finally {
    await db.exec("reset role");
  }
}

describe("putting visits on the plans", () => {
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
    made.test = await onPlan("A test organization", "free", true);
    await db.query(
      "update public.organizations set allowances = public.test_allowances() where id = $1",
      [made.test],
    );
    // One whose limits the operator set for it alone.
    made.special = await onPlan("A special case", "standard");
    await db.query("update public.organizations set max_queries_per_location = 40 where id = $1", [
      made.special,
    ]);
    // One on no plan, with its limits set by hand.
    made.byHand = await onPlan("Set by hand", "pro");
    await db.query("update public.organizations set plan_key = null where id = $1", [made.byHand]);
  });
  afterAll(async () => {
    await db.close();
  });

  it("starts from plans without visits, where only a test organization's are counted", async () => {
    expect(
      await rows("select key from public.plans where allowances ? 'visits' order by position"),
    ).toEqual([]);
    expect(await allowances(made.pro ?? "")).toEqual({ drafts: 60 });
    for (const plan of ["free", "starter", "standard", "pro", "enterprise"]) {
      expect(await counts(made[plan] ?? ""), plan).toBe(false);
    }
    expect(await counts(made.test ?? "")).toBe(true);
  });

  it("puts visits on each paid plan beside what it had, and not on the free plan", async () => {
    await db.exec(readFileSync(join(migrationsDir, TURNS_ON), "utf8"));
    expect(await rows("select key, allowances from public.plans order by position")).toEqual([
      { key: "free", allowances: {} },
      { key: "starter", allowances: { drafts: 10, visits: true } },
      { key: "standard", allowances: { drafts: 30, visits: true } },
      { key: "pro", allowances: { drafts: 60, visits: true } },
      { key: "enterprise", allowances: { drafts: 60, visits: true } },
    ]);
  });

  it("gives an organization already on a plan what its plan now has, and counts its visits", async () => {
    expect(await allowances(made.free ?? "")).toEqual({});
    expect(await allowances(made.starter ?? "")).toEqual({ drafts: 10, visits: true });
    expect(await allowances(made.standard ?? "")).toEqual({ drafts: 30, visits: true });
    expect(await allowances(made.pro ?? "")).toEqual({ drafts: 60, visits: true });
    expect(await allowances(made.enterprise ?? "")).toEqual({ drafts: 60, visits: true });

    expect(await counts(made.free ?? "")).toBe(false);
    for (const plan of ["starter", "standard", "pro", "enterprise"]) {
      expect(await counts(made[plan] ?? ""), plan).toBe(true);
    }
  });

  it("leaves a test organization and everything else an organization had as they were", async () => {
    expect(await allowances(made.test ?? "")).toEqual({ drafts: 1000, visits: true });
    expect(
      await rows(
        "select max_queries_per_location, allowances from public.organizations where id = $1",
        [made.special],
      ),
    ).toEqual([{ max_queries_per_location: 40, allowances: { drafts: 30, visits: true } }]);
    // An organization on no plan gets nothing from a plan.
    expect(await allowances(made.byHand ?? "")).toEqual({ drafts: 60 });
    expect(await counts(made.byHand ?? "")).toBe(false);
  });

  it("is what an organization gets when it joins a plan afterwards, and loses when it leaves", async () => {
    const joined = await onPlan("Joined later", "starter");
    expect(await allowances(joined)).toEqual({ drafts: 10, visits: true });
    expect(await counts(joined)).toBe(true);

    await db.query("select public.apply_plan($1, 'free')", [joined]);
    expect(await allowances(joined)).toEqual({});
    expect(await counts(joined)).toBe(false);
    // What was counted while the plan had them is still there to read.
    expect(
      await rows(
        "select v.count from public.visits v join public.locations l on l.id = v.location_id where l.organization_id = $1",
        [joined],
      ),
    ).toEqual([{ count: 1 }]);
  });
});
