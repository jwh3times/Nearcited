import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Google results (issue #219): an allowance on no plan, and a point on each location that only
 * the worker writes. Run against every migration, with an organization on each plan.
 */

const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
const shim = readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8");

const owner = "a0000000-0000-4000-8000-000000000001";

let db: PGlite;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function as<T>(role: "authenticated" | "service_role", run: () => Promise<T>): Promise<T> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [owner]);
  await db.exec(`set role ${role}`);
  try {
    return await run();
  } finally {
    await db.exec("reset role");
  }
}

const pointOf = async (id: string) =>
  (
    await rows(
      "select latitude, longitude, point_source, geocoded_from from public.locations where id = $1",
      [id],
    )
  )[0];

describe("Google results", () => {
  let organization = "";
  let location = "";

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(shim);
    for (const file of readdirSync(migrationsDir).sort()) {
      await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }
    await db.query("insert into auth.users (id, email) values ($1, 'owner@example.com')", [owner]);
    const [made] = await as("authenticated", () =>
      rows<{ id: string }>("select id from public.create_organization('Raleigh Pizza Group')"),
    );
    organization = made?.id ?? "";
  });
  afterAll(async () => {
    await db.close();
  });

  it("is an allowance, included or not, on no plan", async () => {
    expect(
      await rows("select key, counted from public.allowance_kinds where key = 'google_results'"),
    ).toEqual([{ key: "google_results", counted: false }]);
    expect(await rows("select key from public.plans where allowances ? 'google_results'")).toEqual(
      [],
    );
    for (const plan of ["free", "starter", "standard", "pro", "enterprise"]) {
      await db.query("select public.apply_plan($1, $2)", [organization, plan]);
      const [held] = await rows<{ has: boolean }>(
        "select allowances ? 'google_results' as has from public.organizations where id = $1",
        [organization],
      );
      expect(held?.has, plan).toBe(false);
    }
  });

  it("checks AI Mode as a surface of its own", async () => {
    const [labels] = await rows<{ has: boolean }>(
      "select 'google_ai_mode' = any(enum_range(null::public.surface)::text[]) as has",
    );
    expect(labels?.has).toBe(true);
  });

  it("starts a location with no point, whatever a member sends", async () => {
    const [made] = await as("authenticated", () =>
      rows<{ id: string }>(
        "insert into public.locations (organization_id, name, city, latitude, longitude, point_source, geocoded_from) values ($1, 'Joe''s Pizza', 'Raleigh', 1, 1, 'address', 'Somewhere') returning id",
        [organization],
      ),
    );
    location = made?.id ?? "";
    expect(await pointOf(location)).toEqual({
      latitude: null,
      longitude: null,
      point_source: null,
      geocoded_from: null,
    });
  });

  it("keeps the point the worker found, and a member's write leaves it as it was", async () => {
    const found = {
      latitude: 35.7795897,
      longitude: -78.6381787,
      point_source: "address",
      geocoded_from: "1 Main St, Raleigh, US",
    };
    await as("service_role", () =>
      db.query(
        "update public.locations set latitude = $2, longitude = $3, point_source = $4, geocoded_from = $5 where id = $1",
        [location, found.latitude, found.longitude, found.point_source, found.geocoded_from],
      ),
    );
    await as("authenticated", () =>
      db.query(
        "update public.locations set latitude = 0, longitude = 0, geocoded_from = 'Elsewhere', city = 'Durham' where id = $1",
        [location],
      ),
    );
    expect(await pointOf(location)).toEqual(found);
    // The rest of the member's change is made.
    expect(await rows("select city from public.locations where id = $1", [location])).toEqual([
      { city: "Durham" },
    ]);
  });

  it("keeps a point whole: both coordinates and where they came from, or none", async () => {
    await expect(
      db.query("update public.locations set longitude = null where id = $1", [location]),
    ).rejects.toThrow();
    await expect(
      db.query("update public.locations set point_source = null where id = $1", [location]),
    ).rejects.toThrow();
  });
});
