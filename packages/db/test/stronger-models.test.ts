import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The migration that makes stronger models an allowance changes rows that are already there, so
 * it is run here against a database that has some: every migration before it, then organizations
 * on each plan and a result, then the migration itself, then everything after it.
 */

const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
const shim = readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8");
const TURNS_ON = "20261017000000_stronger_models.sql";

const owner = "a0000000-0000-4000-8000-000000000001";

let db: PGlite;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function onPlan(name: string, plan: string): Promise<string> {
  const [made] = await rows<{ id: string }>(
    "insert into public.organizations (name, created_by) values ($1, $2) returning id",
    [name, owner],
  );
  await db.query("select public.apply_plan($1, $2)", [made?.id, plan]);
  return made?.id ?? "";
}

const strongerOf = async (id: string) =>
  (
    await rows<{ stronger_surfaces: string }>(
      "select stronger_surfaces::text from public.organizations where id = $1",
      [id],
    )
  )[0]?.stronger_surfaces;

describe("stronger models", () => {
  const made: Record<string, string> = {};
  let resultId = "";

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
    // A result kept before the migration, which reads afterwards as checked on Standard.
    const [location] = await rows<{ id: string }>(
      "insert into public.locations (organization_id, name, city) values ($1, 'Joe''s', 'Raleigh') returning id",
      [made.enterprise],
    );
    const [query] = await rows<{ id: string }>(
      "insert into public.tracked_queries (location_id, kind, text) values ($1, 'ai_prompt', 'pizza') returning id",
      [location?.id],
    );
    const [scan] = await rows<{ id: string }>(
      "insert into public.scans (location_id, trigger, status) values ($1, 'manual', 'succeeded') returning id",
      [location?.id],
    );
    const [result] = await rows<{ id: string }>(
      "insert into public.scan_results (scan_id, tracked_query_id, surface, mentioned) values ($1, $2, 'chatgpt', true) returning id",
      [scan?.id, query?.id],
    );
    resultId = result?.id ?? "";

    for (const file of files.filter((name) => name >= TURNS_ON)) {
      await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }
  });
  afterAll(async () => {
    await db.close();
  });

  it("is an allowance on Enterprise, the one plan that had the mark, and on no other", async () => {
    expect(
      await rows("select key, counted from public.allowance_kinds where key = 'stronger_models'"),
    ).toEqual([{ key: "stronger_models", counted: false }]);
    expect(
      await rows(
        "select key from public.plans where allowances ? 'stronger_models' order by position",
      ),
    ).toEqual([{ key: "enterprise" }]);
    // The organization already on it has it now, as a plan gaining something takes effect at once.
    expect(
      await rows(
        "select name from public.organizations where allowances ? 'stronger_models' and not is_test order by name",
      ),
    ).toEqual([{ name: "On enterprise" }]);
  });

  it("puts every organization on Standard to begin with", async () => {
    for (const id of Object.values(made)) expect(await strongerOf(id)).toBe("{}");
  });

  it("gives an assistant Stronger only where the subscription pays for it and the plan includes it", async () => {
    await db.query(
      "select public.apply_plan($1, 'enterprise', null, array['claude']::public.surface[])",
      [made.enterprise],
    );
    expect(await strongerOf(made.enterprise ?? "")).toBe("{claude}");

    // Applied again without saying, as the worker before this did, it stays as it is.
    await db.query("select public.apply_plan($1, 'enterprise')", [made.enterprise]);
    expect(await strongerOf(made.enterprise ?? "")).toBe("{claude}");

    // Twice over, and in any order, is each once in a fixed order. Only assistants can be stronger.
    await db.query(
      "select public.apply_plan($1, 'enterprise', null, array['claude', 'chatgpt', 'claude', 'google_organic']::public.surface[])",
      [made.enterprise],
    );
    expect(await strongerOf(made.enterprise ?? "")).toBe("{chatgpt,claude}");

    // A plan that does not include it gives nobody Stronger, whatever is paid for.
    await db.query("select public.apply_plan($1, 'pro', null, array['claude']::public.surface[])", [
      made.pro,
    ]);
    expect(await strongerOf(made.pro ?? "")).toBe("{}");
  });

  it("puts everyone back on Standard when they leave for a plan without it", async () => {
    await db.query("select public.apply_plan($1, 'free')", [made.enterprise]);
    expect(await strongerOf(made.enterprise ?? "")).toBe("{}");
  });

  it("writes on a scan kept before that it asked everything on Standard", async () => {
    expect(
      await rows(
        "select s.tiers from public.scans s join public.scan_results r on r.scan_id = s.id where r.id = $1",
        [resultId],
      ),
    ).toEqual([{ tiers: { chatgpt: "standard" } }]);
  });

  it("reads a result kept before as checked on Standard", async () => {
    expect(await rows("select tier from public.scan_results where id = $1", [resultId])).toEqual([
      { tier: "standard" },
    ]);
    await expect(
      db.query("update public.scan_results set tier = 'strongest' where id = $1", [resultId]),
    ).rejects.toThrow();
  });

  it("keeps a stronger price on a price version only with both of its provider prices", async () => {
    await expect(
      db.query(
        "insert into public.plan_prices (plan_key, price_cents, stripe_price_id, stronger_price_cents, stripe_stronger_chatgpt_price_id) values ('pro', 100, 'price_half', 900, 'price_half_chatgpt')",
      ),
    ).rejects.toThrow();
    await db.query(
      "insert into public.plan_prices (plan_key, price_cents, stripe_price_id, stronger_price_cents, stripe_stronger_chatgpt_price_id, stripe_stronger_claude_price_id) values ('pro', 100, 'price_whole', 900, 'price_whole_chatgpt', 'price_whole_claude')",
    );
  });
});
