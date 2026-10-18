import {
  AccountExportSchema,
  ConnectionSchema,
  EXPORT_SHEETS,
  type ExportList,
  LocationSchema,
  OrganizationSchema,
  ScanResultSchema,
  ScanSchema,
  TrackedQuerySchema,
} from "@nearcited/shared";
import { strFromU8, unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const carol = "c0000000-0000-4000-8000-000000000003";
const dave = "d0000000-0000-4000-8000-000000000004";

let db: MemoryDb;
const env = { PROVIDER_MODE: "live", APP_URL: "https://nearcited.example" } as unknown as Env;

const app = createApp({
  authenticate: async (request) => {
    const userId = request.headers.get("Authorization")?.replace("Bearer ", "");
    return userId
      ? { user: { id: userId, email: `${userId}@example.com` }, store: memoryStore(db, userId) }
      : null;
  },
  publicStore: () => memoryStore(db, "nobody"),
});

function call(user: string | null, method: string, path: string, body?: unknown) {
  return app.request(
    `/api${path}`,
    {
      method,
      headers: {
        ...(user ? { Authorization: `Bearer ${user}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string } }).error;

/** The files in a downloaded ZIP, as text, by name. */
async function filesOf(response: Response): Promise<Record<string, string>> {
  const unzipped = unzipSync(new Uint8Array(await response.arrayBuffer()));
  return Object.fromEntries(
    Object.entries(unzipped).map(([name, bytes]) => [name, strFromU8(bytes)]),
  );
}

/** Alice's organization with Bob a member and Dave an admin, a location, a prompt and one scan. */
async function seed() {
  const organization = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  db.memberships.push({ organization_id: organization.id, user_id: bob, role: "member" });
  db.memberships.push({ organization_id: organization.id, user_id: dave, role: "admin" });
  for (const user of [alice, bob, dave]) db.emails.set(user, `${user}@example.com`);
  const location = LocationSchema.parse(
    await (
      await call(alice, "POST", `/organizations/${organization.id}/locations`, {
        name: 'Joe\'s "Famous" Pizza, Downtown',
        city: "Raleigh",
        website: "https://www.joespizza.example",
      })
    ).json(),
  );
  const prompt = TrackedQuerySchema.parse(
    await (
      await call(alice, "POST", `/locations/${location.id}/queries`, {
        kind: "ai_prompt",
        text: "late night pizza in Raleigh",
      })
    ).json(),
  );
  const scan = ScanSchema.parse({
    id: crypto.randomUUID(),
    location_id: location.id,
    status: "succeeded",
    trigger: "manual",
    visibility_score: 50,
    error: null,
    sample_data: false,
    tiers: { chatgpt: "stronger" },
    created_at: "2026-10-01T12:00:00.000Z",
    started_at: "2026-10-01T12:00:00.000Z",
    finished_at: "2026-10-01T12:01:00.000Z",
  });
  db.scans.push(scan);
  db.results.push(
    ScanResultSchema.parse({
      id: crypto.randomUUID(),
      scan_id: scan.id,
      tracked_query_id: prompt.id,
      surface: "chatgpt",
      shown: true,
      mentioned: true,
      position: 1,
      competitors: ["Pie Hole"],
      cited_urls: ["https://www.joespizza.example/"],
      // An answer is anyone's words, and a spreadsheet would run this as a formula.
      answer_excerpt: '=HYPERLINK("https://elsewhere.example")',
      phones: [],
      tier: "stronger",
      sampled_at: "2026-10-01T12:00:30.000Z",
    }),
  );
  const connection = ConnectionSchema.parse({
    id: crypto.randomUUID(),
    organization_id: organization.id,
    kind: "wordpress",
    label: "joespizza.example",
    status: "working",
    connected_by_email: `${alice}@example.com`,
    connected_at: "2026-10-01T00:00:00.000Z",
    removed_by_email: null,
    removal_requested_at: null,
    removed_at: null,
    broken_reason: null,
    broken_at: null,
    paused_at: null,
    removal_reason: null,
    last_synced_at: null,
    choices: [],
    matches: [],
  });
  db.connections.push(connection);
  db.connectionSecrets.set(connection.id, "sealed-sign-in-never-exported");
  db.usage.push({
    organization_id: organization.id,
    scan_id: scan.id,
    surface: "chatgpt",
    model: "priced-model-never-exported",
    calls: 1,
    input_tokens: 1000,
    cached_input_tokens: 0,
    output_tokens: 10,
    searches: 1,
    created_at: "2026-10-01T12:00:30.000Z",
  });
  return { organization, location, prompt, scan, connection };
}

beforeEach(() => {
  db = createMemoryDb();
});

describe("downloading everything", () => {
  it("gives an owner a ZIP of a spreadsheet for each list and the whole of it as JSON", async () => {
    const { organization, location, prompt, scan, connection } = await seed();

    const response = await call(alice, "GET", `/organizations/${organization.id}/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="nearcited-raleigh-pizza-group-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const files = await filesOf(response);
    expect(Object.keys(files).sort()).toEqual([
      "README.txt",
      "actions.csv",
      "alerts.csv",
      "answers.csv",
      "connections.csv",
      "drafts.csv",
      "everything.json",
      "hosted-pages.csv",
      "listings.csv",
      "locations.csv",
      "members.csv",
      "organization.csv",
      "page-addresses.csv",
      "page-fetches.csv",
      "prompts.csv",
      "scans.csv",
      "tasks.csv",
      "visits.csv",
    ]);

    const everything = AccountExportSchema.parse(JSON.parse(files["everything.json"] ?? ""));
    expect(everything.version).toBe(1);
    expect(everything.organization.id).toBe(organization.id);
    expect(everything.locations.map((row) => row.id)).toEqual([location.id]);
    expect(everything.prompts.map((row) => row.id)).toEqual([prompt.id]);
    expect(everything.scans.map((row) => row.id)).toEqual([scan.id]);
    expect(everything.answers.map((row) => row.answer_excerpt)).toEqual([
      '=HYPERLINK("https://elsewhere.example")',
    ]);
    expect(everything.connections.map((row) => row.id)).toEqual([connection.id]);
    expect(everything.members).toEqual([
      expect.objectContaining({ email: `${alice}@example.com`, role: "owner" }),
      expect.objectContaining({ email: `${dave}@example.com`, role: "admin" }),
      expect.objectContaining({ email: `${bob}@example.com`, role: "member" }),
    ]);

    // Each spreadsheet holds every row of its list, one to a line, below the line of columns.
    for (const [list, name] of Object.entries(EXPORT_SHEETS) as [ExportList, string][]) {
      const value = everything[list];
      const lines = (files[name] ?? "").split("\r\n").filter((line) => line !== "");
      expect(lines.length - 1, name).toBe(Array.isArray(value) ? value.length : 1);
    }

    // A spreadsheet's first line names its columns, and a value with a comma or a quote in it
    // stays one cell.
    const locations = (files["locations.csv"] ?? "").split("\r\n");
    expect(locations[0]?.split(",").slice(0, 3)).toEqual(["id", "organization_id", "name"]);
    expect(locations[1]).toContain('"Joe\'s ""Famous"" Pizza, Downtown"');
    // What would run as a formula is kept as text.
    expect(files["answers.csv"]).toContain(`"'=HYPERLINK(""https://elsewhere.example"")"`);
    // Each answer says which model it was asked with, and so does each assistant's tier.
    expect(files["answers.csv"]?.split("\r\n")[0]?.split(",")).toContain("tier");
    expect(everything.answers.map((row) => row.tier)).toEqual(["stronger"]);
    expect(everything.organization.stronger_surfaces).toEqual([]);
    // A list with nothing in it still names its columns.
    expect(files["alerts.csv"]?.split("\r\n")[0]?.split(",")).toEqual(
      expect.arrayContaining(["id", "location_id", "kind", "facts", "raised_at"]),
    );

    // Invoices are at the payment provider, and the note says where.
    expect(files["README.txt"]).toContain("https://nearcited.example/settings");
  });

  it("is named for the organization, its accents dropped and nothing else of the name kept but letters and digits", async () => {
    const organization = OrganizationSchema.parse(
      await (
        await call(alice, "POST", "/organizations", { name: 'Crème Brûlée "Café" & Co.' })
      ).json(),
    );
    const response = await call(alice, "GET", `/organizations/${organization.id}/export`);
    expect(response.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="nearcited-creme-brulee-cafe-co-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
  });

  it("never holds a sign-in or what the providers were paid", async () => {
    const { organization } = await seed();
    const files = await filesOf(
      await call(alice, "GET", `/organizations/${organization.id}/export`),
    );
    const all = Object.values(files).join("\n");
    expect(all).not.toContain("sealed-sign-in-never-exported");
    expect(all).not.toContain("priced-model-never-exported");
    expect(all).not.toContain("input_tokens");
  });

  it("holds nothing of another organization's", async () => {
    const { organization } = await seed();
    const other = OrganizationSchema.parse(
      await (await call(carol, "POST", "/organizations", { name: "Carol's Cafe" })).json(),
    );
    await call(carol, "POST", `/organizations/${other.id}/locations`, {
      name: "Carol's Cafe",
      city: "Durham",
    });
    const files = await filesOf(
      await call(alice, "GET", `/organizations/${organization.id}/export`),
    );
    expect(Object.values(files).join("\n")).not.toContain("Carol's Cafe");
  });

  it("is an owner's alone", async () => {
    const { organization } = await seed();
    const path = `/organizations/${organization.id}/export`;
    for (const user of [bob, dave, carol]) {
      const response = await call(user, "GET", path);
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe("owners_only");
    }
    db.operators.add(carol);
    expect((await call(carol, "GET", path)).status).toBe(403);
    expect((await call(null, "GET", path)).status).toBe(401);
  });
});
