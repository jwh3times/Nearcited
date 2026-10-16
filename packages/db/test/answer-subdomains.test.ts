import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { MOST_FETCHES_A_DAY } from "@nearcited/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Answer subdomains (issue #141): the plans that include them, who makes and reads one, what the
 * worker alone keeps, and that a name is held by one connection at a time. Every migration runs
 * first, except where a test needs the rows from before the one that turns hosted pages on.
 */

const migrationsDir = join(import.meta.dirname, "../../../supabase/migrations");
const shim = readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8");
const TURNS_ON = "20261016110000_answer_subdomains.sql";

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

/** An organization of `by`'s on a plan, with one location at `website`. */
async function onPlan(name: string, plan: string, by = owner, test = false) {
  const [made] = await rows<{ id: string }>(
    "insert into public.organizations (name, created_by, is_test) values ($1, $2, $3) returning id",
    [name, by, test],
  );
  const org = made?.id ?? "";
  await db.query(
    "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'owner')",
    [org, by],
  );
  await db.query("select public.apply_plan($1, $2, 6)", [org, plan]);
  return org;
}

async function locationOf(org: string, website: string | null, name = "Joe's Pizza") {
  const [made] = await rows<{ id: string }>(
    "insert into public.locations (organization_id, name, website, city) values ($1, $2, $3, 'Raleigh') returning id",
    [org, name, website],
  );
  return made?.id ?? "";
}

const create = "select id, kind, label, status from public.create_answer_subdomain($1, $2, $3, $4)";
const allows = async (org: string) =>
  (
    await rows<{ allowed: boolean }>(
      "select public.allows_connection($1, 'hosted_pages') as allowed",
      [org],
    )
  )[0]?.allowed;

describe("answer subdomains", () => {
  let pro: string;
  let site: string;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(shim);
    const files = readdirSync(migrationsDir).sort();
    expect(files).toContain(TURNS_ON);
    for (const file of files.filter((name) => name < TURNS_ON)) {
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
    // Already on Pro before the migration that turns hosted pages on.
    pro = await onPlan("Raleigh Pizza Group", "pro");
    await db.query(
      "insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'admin')",
      [pro, member, admin],
    );
    site = await locationOf(pro, "https://www.joespizza.example/menu");
    for (const file of files.filter((name) => name >= TURNS_ON)) {
      await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }
  });
  afterAll(async () => {
    await db.close();
  });

  it("are on Pro and Enterprise and no other plan, and given to an organization already on one", async () => {
    expect(
      await rows(
        "select key from public.plans where allowances ? 'hosted_pages' order by position",
      ),
    ).toEqual([{ key: "pro" }, { key: "enterprise" }]);
    expect(await allows(pro)).toBe(true);
    const standard = await onPlan("On Standard", "standard", stranger);
    expect(await allows(standard)).toBe(false);
    await db.query("delete from public.organizations where id = $1", [standard]);
  });

  it("are made only by an owner or admin, under the location's website, with no sign-in", async () => {
    for (const user of [stranger, member, operator]) {
      expect(
        await as("authenticated", user, () =>
          rows(create, [site, crypto.randomUUID(), "answers", "a".repeat(12)]),
        ),
        user,
      ).toEqual([]);
    }
    await expect(
      as("anon", null, () =>
        db.query(create, [site, crypto.randomUUID(), "answers", "a".repeat(12)]),
      ),
    ).rejects.toThrow(/permission denied/);

    const id = crypto.randomUUID();
    expect(
      await as("authenticated", admin, () => rows(create, [site, id, "answers", "a".repeat(12)])),
    ).toEqual([
      { id, kind: "hosted_pages", label: "answers.joespizza.example", status: "working" },
    ]);
    expect(
      await rows(
        "select location_id, external_id from public.connection_locations where connection_id = $1",
        [id],
      ),
    ).toEqual([{ location_id: site, external_id: "answers.joespizza.example" }]);
    expect(
      await rows("select 1 from public.connection_secrets where connection_id = $1", [id]),
    ).toEqual([]);
    // One for a location.
    await expect(
      as("authenticated", owner, () =>
        db.query(create, [site, crypto.randomUUID(), "help", "b".repeat(12)]),
      ),
    ).rejects.toThrow(/already publishes its pages/);
  });

  it("refuses a word that is not one, a location with no website, a test organization and a plan without them", async () => {
    const noWebsite = await locationOf(pro, null, "No website");
    for (const [location, label, why] of [
      [site, "Two words", /not a subdomain/],
      [site, "-answers", /not a subdomain/],
      [noWebsite, "answers", /not a subdomain/],
    ] as const) {
      await expect(
        as("authenticated", owner, () =>
          db.query(create, [location, crypto.randomUUID(), label, "c".repeat(12)]),
        ),
      ).rejects.toThrow(why);
    }
    const test = await onPlan("A test organization", "pro", stranger, true);
    const testSite = await locationOf(test, "https://test.example");
    await expect(
      as("authenticated", stranger, () =>
        db.query(create, [testSite, crypto.randomUUID(), "answers", "c".repeat(12)]),
      ),
    ).rejects.toThrow(/test organization/);
    await db.query("select public.apply_plan($1, 'standard')", [test]);
    await db.query("update public.organizations set is_test = false where id = $1", [test]);
    await expect(
      as("authenticated", stranger, () =>
        db.query(create, [testSite, crypto.randomUUID(), "answers", "c".repeat(12)]),
      ),
    ).rejects.toThrow(/does not include hosted pages/);
    await db.query("delete from public.organizations where id = $1", [test]);
  });

  it("hold a name for one connection at a time, across every organization", async () => {
    const theirs = await onPlan("Slice House", "pro", stranger);
    const sameDomain = await locationOf(theirs, "joespizza.example");
    await expect(
      as("authenticated", stranger, () =>
        db.query(create, [sameDomain, crypto.randomUUID(), "answers", "d".repeat(12)]),
      ),
    ).rejects.toThrow(/answer_subdomains_held|duplicate key/);
    await db.query("delete from public.organizations where id = $1", [theirs]);
  });

  it("are read by members and the operator, without what the worker keeps for itself, and written by no one directly", async () => {
    const read =
      "select hostname, target, record from public.answer_subdomains where location_id = $1";
    for (const user of [owner, member, admin, operator]) {
      expect(await as("authenticated", user, () => rows(read, [site])), user).toEqual([
        { hostname: "answers.joespizza.example", target: "a".repeat(12), record: null },
      ]);
    }
    expect(await as("authenticated", stranger, () => rows(read, [site]))).toEqual([]);
    for (const sql of [
      "select cloudflare_id from public.answer_subdomains",
      "select live_told_at from public.answer_subdomains",
      "update public.answer_subdomains set record = 'ours'",
      "delete from public.answer_subdomains",
      `insert into public.answer_subdomains (connection_id, organization_id, hostname, target) values ('${crypto.randomUUID()}', '${pro}', 'x.example', '${"e".repeat(12)}')`,
    ]) {
      for (const [role, user] of [
        ["authenticated", owner],
        ["authenticated", operator],
        ["anon", null],
      ] as const) {
        await expect(
          as(role, user, () => db.query(sql)),
          `${role} ${sql}`,
        ).rejects.toThrow(/permission denied/);
      }
    }
  });

  it("are checked, listed and expired by the worker alone", async () => {
    const [kept] = await rows<{ connection_id: string }>(
      "select connection_id from public.answer_subdomains where location_id = $1",
      [site],
    );
    const id = kept?.connection_id ?? "";
    for (const sql of [
      `select public.record_answer_subdomain_check('${id}', 'ours', 'ch-1', true, true)`,
      "select public.answer_subdomains_to_check(now())",
      "select public.expire_unclaimed_answer_subdomains()",
    ]) {
      for (const [role, user] of [
        ["authenticated", owner],
        ["anon", null],
      ] as const) {
        await expect(
          as(role, user, () => db.query(sql)),
          `${role} ${sql}`,
        ).rejects.toThrow(/permission denied/);
      }
    }
    expect(
      await as("service_role", null, () =>
        rows("select public.answer_subdomains_to_check(now()) as id"),
      ),
    ).toEqual([{ id }]);
    expect(
      await as("service_role", null, () =>
        rows(
          "select public.record_answer_subdomain_check($1, 'ours', 'ch-1', false, null) as kept",
          [id],
        ),
      ),
    ).toEqual([{ kept: true }]);
    expect(
      await rows<{ registered: boolean; live: boolean }>(
        "select registered_at is not null as registered, live_at is not null as live, cloudflare_id from public.answer_subdomains where connection_id = $1",
        [id],
      ),
    ).toEqual([{ registered: true, live: false, cloudflare_id: "ch-1" }]);
    // Working, it is not let go after thirty days; one that never started working is, registered
    // or not.
    await db.query("update public.connections set connected_at = now() - interval '31 days'");
    await db.query("update public.answer_subdomains set live_at = now() where connection_id = $1", [
      id,
    ]);
    expect(
      await as("service_role", null, () =>
        rows("select public.expire_unclaimed_answer_subdomains()"),
      ),
    ).toEqual([]);
    await db.query("update public.answer_subdomains set live_at = null where connection_id = $1", [
      id,
    ]);
    expect(
      await as("service_role", null, () =>
        rows("select public.expire_unclaimed_answer_subdomains() as id"),
      ),
    ).toEqual([{ id }]);
    expect(
      await rows("select status, removal_reason from public.connections where id = $1", [id]),
    ).toEqual([{ status: "removing", removal_reason: "unclaimed" }]);
    // Finished, the name is anyone's again.
    await as("service_role", null, () =>
      db.query("select public.finish_connection_removal($1)", [id]),
    );
    expect(
      await rows(
        "select released_at is not null as released from public.answer_subdomains where connection_id = $1",
        [id],
      ),
    ).toEqual([{ released: true }]);
  });

  it("keep a location's pages in one place: a WordPress site is refused beside one", async () => {
    const id = crypto.randomUUID();
    await as("authenticated", owner, () => db.query(create, [site, id, "answers", "f".repeat(12)]));
    await expect(
      as("authenticated", owner, () =>
        db.query(
          "select * from public.create_connection($1, $2, 'wordpress', 'Site', 'sealed', $3)",
          [pro, crypto.randomUUID(), site],
        ),
      ),
    ).rejects.toThrow(/hosted on its answer subdomain/);
  });

  it("are removed with their location, since nothing is left to serve there", async () => {
    const [kept] = await rows<{ connection_id: string }>(
      "select connection_id from public.answer_subdomains where location_id = $1 and released_at is null",
      [site],
    );
    await db.query("delete from public.locations where id = $1", [site]);
    expect(
      await rows("select status, removal_reason from public.connections where id = $1", [
        kept?.connection_id,
      ]),
    ).toEqual([{ status: "removing", removal_reason: "location" }]);
  });

  describe("hosted pages, as anyone reads them", () => {
    const answerFor = (host: string, path: string) =>
      as("anon", null, () =>
        rows<{ answer: Record<string, unknown> | null }>(
          "select public.hosted_page($1, $2) as answer",
          [host, path],
        ),
      ).then(([row]) => row?.answer ?? null);
    let served: string;
    let connection: string;

    beforeAll(async () => {
      served = await locationOf(pro, "https://www.slicehouse.example", "Slice House");
      await db.query(
        "update public.locations set phone = '+19195550100', address_line = '12 Main St' where id = $1",
        [served],
      );
      connection = crypto.randomUUID();
      await as("authenticated", owner, () =>
        db.query(create, [served, connection, "answers", "g".repeat(12)]),
      );
      const page = (slug: string, title: string, gone: boolean, at: string) =>
        db.query(
          `insert into public.hosted_pages (connection_id, location_id, slug, title, copy, published_at, taken_back_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [connection, served, slug, title, `${title}\n\nThe words.`, at, gone ? at : null],
        );
      await page("late-night-pizza", "Late night pizza", false, "2026-10-20T10:00:00Z");
      await page("gluten-free-pizza", "Gluten-free pizza", false, "2026-10-18T10:00:00Z");
      await page("taken-back", "Taken back", true, "2026-10-17T10:00:00Z");
    });

    it("answers nothing for a subdomain that is not live", async () => {
      expect(await answerFor("answers.slicehouse.example", "/")).toBeNull();
      expect(await answerFor("answers.nowhere.example", "/")).toBeNull();
    });

    it("answers a live subdomain's list, its pages, a page taken back and a page never there", async () => {
      await db.query(
        "update public.answer_subdomains set live_at = now() where connection_id = $1",
        [connection],
      );
      const business = {
        name: "Slice House",
        website: "https://www.slicehouse.example",
        address_line: "12 Main St",
        city: "Raleigh",
        region: null,
        postal_code: null,
        country_code: "US",
        phone: "+19195550100",
      };
      expect(await answerFor("Answers.SliceHouse.example", "/")).toEqual({
        kind: "list",
        business,
        pages: [
          {
            slug: "late-night-pizza",
            title: "Late night pizza",
            published_at: expect.stringMatching(/^2026-10-20/),
          },
          {
            slug: "gluten-free-pizza",
            title: "Gluten-free pizza",
            published_at: expect.stringMatching(/^2026-10-18/),
          },
        ],
      });
      expect(await answerFor("answers.slicehouse.example", "/late-night-pizza/")).toEqual({
        kind: "page",
        business,
        title: "Late night pizza",
        copy: "Late night pizza\n\nThe words.",
        published_at: expect.stringMatching(/^2026-10-20/),
      });
      expect(await answerFor("answers.slicehouse.example", "/taken-back")).toEqual({
        kind: "gone",
        business,
      });
      expect(await answerFor("answers.slicehouse.example", "/never-there")).toEqual({
        kind: "missing",
        business,
      });
    });

    it("stops answering once the subdomain is being removed", async () => {
      await db.query("update public.connections set status = 'removing' where id = $1", [
        connection,
      ]);
      expect(await answerFor("answers.slicehouse.example", "/")).toBeNull();
      await db.query("update public.connections set status = 'working' where id = $1", [
        connection,
      ]);
    });

    it("are read by members and the operator only, and written by nobody through the API", async () => {
      const read = "select slug from public.hosted_pages where connection_id = $1";
      for (const user of [owner, member, operator]) {
        expect(await as("authenticated", user, () => rows(read, [connection])), user).toHaveLength(
          3,
        );
      }
      expect(await as("authenticated", stranger, () => rows(read, [connection]))).toEqual([]);
      for (const [role, user] of [
        ["anon", null],
        ["authenticated", owner],
      ] as const) {
        for (const sql of [
          role === "anon"
            ? "select 1 from public.hosted_pages"
            : "update public.hosted_pages set title = 'x'",
          "delete from public.hosted_pages",
          `insert into public.hosted_pages (connection_id, location_id, slug, title, copy) values ('${connection}', '${served}', 'x', 'x', 'x')`,
        ]) {
          await expect(
            as(role, user, () => db.query(sql)),
            `${role} ${sql}`,
          ).rejects.toThrow(/permission denied/);
        }
      }
    });
  });

  describe("publishing a hosted page on approval", () => {
    let site: string;
    let connection: string;
    const actionFor = async (status: string, kind = "hosted_page") => {
      const [made] = await rows<{ id: string }>(
        `insert into public.actions (location_id, kind, connection_id, subject, basis, summary, seen, proposed_text, written_by, status)
         values ($1, $2, $3, $5, 'copy', 'Publish', '{"text": null}', 'copy', 'model', $4) returning id`,
        [site, kind, connection, status, `page:${crypto.randomUUID()}`],
      );
      return made?.id ?? "";
    };
    const publish = (action: string, slug = "late-night") =>
      as("service_role", null, () =>
        rows<{ address: string | null }>(
          "select public.publish_hosted_page($1, $2, 'Late night', 'Late night\n\nWords.') as address",
          [action, slug],
        ),
      ).then(([row]) => row?.address ?? null);

    beforeAll(async () => {
      site = await locationOf(pro, "https://www.publishing.example", "Publishing Pizza");
      connection = crypto.randomUUID();
      await as("authenticated", owner, () =>
        db.query(create, [site, connection, "answers", "h".repeat(12)]),
      );
    });

    it("takes from the hosted pages allowance", async () => {
      expect(
        await rows(
          "select allowance, keeps_seen_days from public.action_kind_terms where kind = 'hosted_page'",
        ),
      ).toEqual([{ allowance: "hosted_pages", keeps_seen_days: null }]);
    });

    it("is done by the worker alone", async () => {
      const action = await actionFor("approved");
      for (const sql of [
        `select public.publish_hosted_page('${action}', 'x', 'X', 'X')`,
        `select public.take_back_hosted_page('${action}')`,
      ]) {
        for (const [role, user] of [
          ["authenticated", owner],
          ["anon", null],
        ] as const) {
          await expect(
            as(role, user, () => db.query(sql)),
            `${role} ${sql}`,
          ).rejects.toThrow(/permission denied/);
        }
      }
    });

    it("serves an approved action's page once the subdomain is live, at one address at a time", async () => {
      const action = await actionFor("approved");
      expect(await publish(action)).toBeNull();
      await db.query(
        "update public.answer_subdomains set live_at = now() where connection_id = $1",
        [connection],
      );
      expect(await publish(await actionFor("proposed"))).toBeNull();
      expect(await publish(await actionFor("approved", "wordpress_page"))).toBeNull();
      expect(await publish(action)).toBe("https://answers.publishing.example/late-night");
      await expect(publish(await actionFor("approved"))).rejects.toThrow(
        /hosted_pages_live|duplicate/,
      );
      expect(
        await as("anon", null, () =>
          rows<{ answer: { kind: string } }>(
            "select public.hosted_page('answers.publishing.example', '/late-night') as answer",
          ),
        ),
      ).toMatchObject([{ answer: { kind: "page", title: "Late night" } }]);

      // Taken back, its address answers that it is gone, and the address is free again.
      expect(
        await as("service_role", null, () =>
          rows("select public.take_back_hosted_page($1) as taken", [action]),
        ),
      ).toEqual([{ taken: true }]);
      expect(
        await as("service_role", null, () =>
          rows("select public.take_back_hosted_page($1) as taken", [action]),
        ),
      ).toEqual([{ taken: false }]);
      expect(
        await as("anon", null, () =>
          rows<{ answer: { kind: string } }>(
            "select public.hosted_page('answers.publishing.example', '/late-night') as answer",
          ),
        ),
      ).toMatchObject([{ answer: { kind: "gone" } }]);
      expect(await publish(await actionFor("approved"))).toBe(
        "https://answers.publishing.example/late-night",
      );
    });
  });

  describe("counting fetches, and winding down", () => {
    let site: string;
    let connection: string;
    let page: string;
    const fetched = (host: string, path: string, fetcher: string) =>
      as("anon", null, () =>
        db.query("select public.record_page_fetch($1, $2, $3)", [host, path, fetcher]),
      );
    const counts = () =>
      rows<{ fetcher: string; count: number }>(
        "select fetcher, count from public.hosted_page_fetches where location_id = $1 order by fetcher",
        [site],
      );

    beforeAll(async () => {
      site = await locationOf(pro, "https://www.counting.example", "Counting Pizza");
      connection = crypto.randomUUID();
      await as("authenticated", owner, () =>
        db.query(create, [site, connection, "answers", "k".repeat(12)]),
      );
      await db.query(
        "update public.answer_subdomains set live_at = now() where connection_id = $1",
        [connection],
      );
      const [task] = await rows<{ id: string }>(
        "insert into public.recommendations (location_id, rule, title, detail) values ($1, 'page:q', 'Publish a page', 'Detail') returning id",
        [site],
      );
      const [made] = await rows<{ id: string }>(
        `insert into public.hosted_pages (connection_id, location_id, recommendation_id, slug, title, copy)
         values ($1, $2, $3, 'late-night', 'Late night', 'Late night\n\nWords.') returning id`,
        [connection, site, task?.id],
      );
      page = made?.id ?? "";
    });

    it("counts a live page's fetch by a known fetcher, for anyone, and nothing else", async () => {
      await fetched("answers.counting.example", "/late-night", "claudebot");
      await fetched("Answers.Counting.example", "/late-night/", "claudebot");
      await fetched("answers.counting.example", "/late-night", "googlebot");
      // Not a known fetcher, not a page, a page taken back, not a live host.
      await db.query(
        `insert into public.hosted_pages (connection_id, location_id, slug, title, copy, taken_back_at)
         values ($1, $2, 'taken-back', 'Taken back', 'Taken back\n\nWords.', now())`,
        [connection, site],
      );
      await fetched("answers.counting.example", "/taken-back", "gptbot");
      await fetched("answers.counting.example", "/late-night", "somebot");
      await fetched("answers.counting.example", "/", "gptbot");
      await fetched("answers.counting.example", "/never-there", "gptbot");
      await fetched("answers.nowhere.example", "/late-night", "gptbot");
      expect(await counts()).toEqual([
        { fetcher: "claudebot", count: 2 },
        { fetcher: "googlebot", count: 1 },
      ]);
    });

    it("stops a day's count at the most a day", async () => {
      await db.query(
        "update public.hosted_page_fetches set count = $2 where hosted_page_id = $1 and fetcher = 'googlebot'",
        [page, MOST_FETCHES_A_DAY],
      );
      await fetched("answers.counting.example", "/late-night", "googlebot");
      expect((await counts()).find((row) => row.fetcher === "googlebot")?.count).toBe(
        MOST_FETCHES_A_DAY,
      );
    });

    it("are read added up by members and the operator, and by nobody else", async () => {
      const read =
        "select fetcher, fetches::int as fetches from public.location_page_fetches($1, current_date - 30) order by fetcher";
      for (const user of [owner, member, operator]) {
        expect(await as("authenticated", user, () => rows(read, [site])), user).toEqual([
          { fetcher: "claudebot", fetches: 2 },
          { fetcher: "googlebot", fetches: MOST_FETCHES_A_DAY },
        ]);
      }
      expect(await as("authenticated", stranger, () => rows(read, [site]))).toEqual([]);
      for (const sql of [
        "select 1 from public.hosted_page_fetches",
        `select * from public.location_page_fetches('${site}', current_date)`,
      ]) {
        await expect(
          as("anon", null, () => db.query(sql)),
          sql,
        ).rejects.toThrow(/permission denied/);
      }
      await expect(
        as("authenticated", owner, () => db.query("delete from public.hosted_page_fetches")),
      ).rejects.toThrow(/permission denied/);
    });

    it("serves the pages for thirty days into a pause, then sends visitors to the business's site", async () => {
      const answer = async (path: string) =>
        (
          await as("anon", null, () =>
            rows<{ answer: Record<string, unknown> }>(
              "select public.hosted_page('answers.counting.example', $1) as answer",
              [path],
            ),
          )
        )[0]?.answer;
      await db.query(
        "update public.connections set status = 'paused', paused_at = now() - interval '29 days' where id = $1",
        [connection],
      );
      expect(await answer("/late-night")).toMatchObject({ kind: "page" });
      await db.query(
        "update public.connections set paused_at = now() - interval '31 days' where id = $1",
        [connection],
      );
      for (const path of ["/", "/late-night", "/never-there"]) {
        expect(await answer(path), path).toMatchObject({
          kind: "redirect",
          to: "https://www.counting.example",
        });
      }
    });

    it("tells the worker which paused ones are untold, once a pause", async () => {
      const untold = () =>
        as("service_role", null, () =>
          rows<{ id: string }>("select public.answer_subdomains_paused_untold() as id"),
        );
      expect(await untold()).toContainEqual({ id: connection });
      await db.query(
        "update public.answer_subdomains set pause_told_at = now() where connection_id = $1",
        [connection],
      );
      expect(await untold()).not.toContainEqual({ id: connection });
      await expect(
        as("authenticated", owner, () =>
          db.query("select public.answer_subdomains_paused_untold()"),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as("authenticated", owner, () =>
          db.query("select pause_told_at from public.answer_subdomains"),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it("lets go of a paused one that never went live, thirty days after it was made", async () => {
      const pending = crypto.randomUUID();
      const other = await locationOf(pro, "https://www.pending.example", "Pending Pizza");
      await as("authenticated", owner, () =>
        db.query(create, [other, pending, "answers", "p".repeat(12)]),
      );
      await db.query(
        "update public.connections set status = 'paused', paused_at = now(), connected_at = now() - interval '31 days' where id = $1",
        [pending],
      );
      const untold = await as("service_role", null, () =>
        rows<{ id: string }>("select public.answer_subdomains_paused_untold() as id"),
      );
      expect(untold).not.toContainEqual({ id: pending });
      expect(
        await as("service_role", null, () =>
          rows<{ id: string }>("select public.expire_unclaimed_answer_subdomains() as id"),
        ),
      ).toContainEqual({ id: pending });
    });

    it("removes one only a hundred and twenty days into its pause", async () => {
      const expire = () =>
        as("service_role", null, () =>
          rows<{ id: string }>("select public.expire_paused_connections() as id"),
        );
      await db.query(
        "update public.connections set paused_at = now() - interval '119 days' where id = $1",
        [connection],
      );
      expect(await expire()).not.toContainEqual({ id: connection });
      await db.query(
        "update public.connections set paused_at = now() - interval '121 days' where id = $1",
        [connection],
      );
      expect(await expire()).toContainEqual({ id: connection });
    });
  });
});
