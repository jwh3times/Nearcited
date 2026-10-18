import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A search that showed nothing (issue #223): each result says whether Google showed anything,
 * results kept before it are put right, and the Worker deployed before it keeps working.
 */

const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
const shim = readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8");
const THIS_MIGRATION = "20261020000000_nothing_shown.sql";

let db: PGlite;
let query = "";
let location = "";

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const [row] = await rows<T>(sql, params);
  if (!row) throw new Error(`No row: ${sql}`);
  return row;
}

/** A scan under way, or one already finished. A location has one under way at a time. */
const newScan = async (status: "running" | "succeeded" = "running") =>
  (
    await one<{ id: string }>(
      "insert into public.scans (location_id, trigger, status) values ($1, 'manual', $2) returning id",
      [location, status],
    )
  ).id;

/** What a scan kept, surface by surface. */
const kept = async (scan: string) =>
  rows<{ surface: string; shown: boolean; mentioned: boolean }>(
    "select surface, shown, mentioned from public.scan_results where scan_id = $1 order by surface::text",
    [scan],
  );

/** A result as a scan sends it to complete_scan(). */
const sent = (surface: string, change: Record<string, unknown> = {}) => ({
  tracked_query_id: query,
  surface,
  mentioned: false,
  position: null,
  competitors: [],
  cited_urls: [],
  answer_excerpt: null,
  phones: [],
  tier: "standard",
  ...change,
});

describe("nothing shown", () => {
  let before = "";

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(shim);
    const files = readdirSync(migrationsDir).sort();
    const at = files.indexOf(THIS_MIGRATION);
    expect(at).toBeGreaterThan(-1);
    const apply = async (file: string) => db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    for (const file of files.slice(0, at)) await apply(file);

    // Results kept before this migration, by the Worker that had no way to say nothing was shown.
    const { id: org } = await one<{ id: string }>(
      "insert into public.organizations (name) values ('Raleigh Pizza Group') returning id",
    );
    location = (
      await one<{ id: string }>(
        "insert into public.locations (organization_id, name, city) values ($1, 'Joe''s Pizza', 'Raleigh') returning id",
        [org],
      )
    ).id;
    query = (
      await one<{ id: string }>(
        "insert into public.tracked_queries (location_id, kind, text) values ($1, 'search_keyword', 'pizza near me') returning id",
        [location],
      )
    ).id;
    before = await newScan("succeeded");
    const insert = (surface: string, columns: string, values: string) =>
      db.query(
        `insert into public.scan_results (scan_id, tracked_query_id, surface, mentioned${columns}) values ($1, $2, '${surface}', ${values})`,
        [before, query],
      );
    // Google showed nothing on these two.
    await insert("google_ai_overview", "", "false");
    await insert("google_local_pack", ", answer_excerpt", "false, ''");
    // It showed these, without the business, and with it.
    await insert("google_ai_mode", ", competitors", `false, '["Tony''s Slice House"]'`);
    await insert("google_organic", ", position", "true, 2");
    // An assistant always answers, even naming nobody.
    await insert("chatgpt", "", "false");

    for (const file of files.slice(at)) await apply(file);
  });
  afterAll(async () => {
    await db.close();
  });

  it("puts right the Google results kept before it where nothing was shown", async () => {
    expect(await kept(before)).toEqual([
      { surface: "chatgpt", shown: true, mentioned: false },
      { surface: "google_ai_mode", shown: true, mentioned: false },
      { surface: "google_ai_overview", shown: false, mentioned: false },
      { surface: "google_local_pack", shown: false, mentioned: false },
      { surface: "google_organic", shown: true, mentioned: true },
    ]);
  });

  it("keeps what a scan says was shown", async () => {
    const scan = await newScan();
    await db.query("select public.complete_scan($1, null, $2, '[]'::jsonb)", [
      scan,
      JSON.stringify([
        sent("google_ai_overview", { shown: false }),
        sent("google_organic", { shown: true, mentioned: true, position: 1 }),
      ]),
    ]);
    expect(await kept(scan)).toEqual([
      { surface: "google_ai_overview", shown: false, mentioned: false },
      { surface: "google_organic", shown: true, mentioned: true },
    ]);
  });

  it("keeps a result from the Worker before it, which does not say, as shown", async () => {
    const scan = await newScan();
    await db.query("select public.complete_scan($1, null, $2, '[]'::jsonb)", [
      scan,
      JSON.stringify([sent("google_ai_overview"), sent("chatgpt")]),
    ]);
    expect(await kept(scan)).toEqual([
      { surface: "chatgpt", shown: true, mentioned: false },
      { surface: "google_ai_overview", shown: true, mentioned: false },
    ]);
  });

  it("shows a result written without saying, as shown", async () => {
    const scan = await newScan("succeeded");
    await db.query(
      "insert into public.scan_results (scan_id, tracked_query_id, surface, mentioned) values ($1, $2, 'chatgpt', true)",
      [scan, query],
    );
    expect(await kept(scan)).toEqual([{ surface: "chatgpt", shown: true, mentioned: true }]);
  });
});
