import {
  defaultTuning,
  LocationDetailSchema,
  type Observation,
  type ScanMessage,
  SURFACES,
} from "@nearcited/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { buildScanReportEmail, emailMessage } from "../src/email/report";
import type { Env } from "../src/env";
import {
  createStrongerProviders,
  liveScansUnavailable,
  type ProviderRegistry,
} from "../src/providers";
import { createDataForSeoProviders } from "../src/providers/dataforseo";
import { createMapboxGeocoder } from "../src/providers/mapbox";
import { createMockProviders } from "../src/providers/mock";
import type { CallUsage } from "../src/providers/types";
import { runScan, type ScanReport } from "../src/scans/runner";
import { enqueueDueScans, failStaleScans, STALE_AFTER_MS } from "../src/scans/schedule";
import type { Store } from "../src/store/types";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const owner = "a0000000-0000-4000-8000-000000000001";

let db: MemoryDb;
let worker: Store;
let locationId: string;

/** ChatGPT names the business second; Gemini names only a competitor. */
const providers: ProviderRegistry = {
  chatgpt: {
    surface: "chatgpt",
    observe: async () => ({
      kind: "answer",
      text: "Try Tony's Slice House or Joe's Pizza.",
      businesses: ["Tony's Slice House", "Joe's Pizza"],
      cited_urls: [],
    }),
  },
  gemini: {
    surface: "gemini",
    observe: async () => ({
      kind: "answer",
      text: "Try Tony's Slice House.",
      businesses: ["Tony's Slice House"],
      cited_urls: [],
    }),
  },
};

async function queueScan(trigger: "manual" | "scheduled" = "manual") {
  return worker.createScan(locationId, trigger, null);
}

beforeEach(async () => {
  db = createMemoryDb();
  db.emails.set(owner, "owner@example.com");
  worker = memoryStore(db, null);

  const user = memoryStore(db, owner);
  const organization = await user.createOrganization("Raleigh Pizza Group");
  const location = await user.createLocation(organization.id, {
    name: "Joe's Pizza",
    website: "https://joes.example",
    phone: null,
    address_line: null,
    city: "Raleigh",
    region: "NC",
    postal_code: null,
    country_code: "US",
    google_place_id: "place-joes",
    primary_category: null,
  });
  locationId = location.id;
  await user.createQuery(locationId, { kind: "ai_prompt", text: "best pizza in Raleigh" });
});

describe("runScan", () => {
  it("checks every configured surface, scores the scan and stores recommendations", async () => {
    const scan = await queueScan();
    expect(await runScan(scan.id, { store: worker, providers })).toBe("succeeded");

    const stored = db.scans[0];
    expect(stored).toMatchObject({ status: "succeeded", visibility_score: 40, error: null });
    expect(db.results.map((result) => [result.surface, result.mentioned, result.position])).toEqual(
      [
        ["chatgpt", true, 2],
        ["gemini", false, null],
      ],
    );
    expect(db.recommendations.map((recommendation) => recommendation.rule)).toEqual([
      "absent:gemini",
    ]);
    expect(db.locations[0]?.last_scanned_at).not.toBeNull();
  });

  it("skips a scan that no longer exists or already succeeded", async () => {
    expect(await runScan(crypto.randomUUID(), { store: worker, providers })).toBe("skipped");

    const scan = await queueScan();
    await runScan(scan.id, { store: worker, providers });
    const observe = vi.fn();
    expect(
      await runScan(scan.id, {
        store: worker,
        providers: { chatgpt: { surface: "chatgpt", observe } },
      }),
    ).toBe("skipped");
    expect(observe).not.toHaveBeenCalled();
  });

  it("fails without retrying when there is nothing to check", async () => {
    db.queries = [];
    const scan = await queueScan();
    expect(await runScan(scan.id, { store: worker, providers })).toBe("failed");
    expect(db.scans[0]).toMatchObject({
      status: "failed",
      error: "Add at least one prompt or keyword before scanning.",
    });
  });

  it("fails without retrying when no provider is configured", async () => {
    const scan = await queueScan();
    expect(await runScan(scan.id, { store: worker, providers: {} })).toBe("failed");
    expect(db.scans[0]?.error).toBe("No data provider is configured for these queries.");
    expect(db.results).toEqual([]);
  });

  it("records a provider error, rethrows for the queue, and succeeds on redelivery", async () => {
    const scan = await queueScan();
    const failing: ProviderRegistry = {
      ...providers,
      gemini: {
        surface: "gemini",
        observe: async (): Promise<Observation> => {
          throw new Error("upstream 503");
        },
      },
    };

    await expect(runScan(scan.id, { store: worker, providers: failing })).rejects.toThrow(
      "upstream 503",
    );
    expect(db.scans[0]).toMatchObject({ status: "failed", error: "upstream 503" });
    expect(db.results).toEqual([]);

    expect(await runScan(scan.id, { store: worker, providers })).toBe("succeeded");
    expect(db.scans[0]).toMatchObject({ status: "succeeded", error: null });
    expect(db.results).toHaveLength(2);
  });

  it("sends a report for scheduled scans only", async () => {
    const notify = vi.fn<(report: ScanReport) => Promise<boolean>>(async () => true);

    const manual = await queueScan("manual");
    await runScan(manual.id, { store: worker, providers, notify });
    expect(notify).not.toHaveBeenCalled();

    const scheduled = await queueScan("scheduled");
    await runScan(scheduled.id, { store: worker, providers, notify });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ score: 40 });
  });

  it("sends no report where the organization's plan does not include one", async () => {
    const notify = vi.fn<(report: ScanReport) => Promise<boolean>>(async () => true);
    for (const organization of db.organizations) organization.emails_report = false;

    const scheduled = await queueScan("scheduled");
    expect(await runScan(scheduled.id, { store: worker, providers, notify })).toBe("succeeded");
    expect(notify).not.toHaveBeenCalled();
  });

  it("still succeeds when the report cannot be sent", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const scan = await queueScan("scheduled");
    const outcome = await runScan(scan.id, {
      store: worker,
      providers,
      notify: async () => {
        throw new Error("Resend is down");
      },
    });
    expect(outcome).toBe("succeeded");
    expect(db.scans[0]?.status).toBe("succeeded");
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("enqueueDueScans", () => {
  it("creates a scheduled scan per due location and queues them in one batch", async () => {
    const batches: { body: ScanMessage }[][] = [];
    const queue = {
      sendBatch: async (messages: Iterable<{ body: ScanMessage }>) => {
        batches.push([...messages]);
      },
    };

    expect(await enqueueDueScans(worker, queue)).toBe(1);
    expect(db.scans).toHaveLength(1);
    expect(db.scans[0]).toMatchObject({ trigger: "scheduled", status: "queued" });
    expect(batches).toEqual([[{ body: { scan_id: db.scans[0]?.id } }]]);
  });

  it("skips a location that got a scan between the due list and now", async () => {
    const racing: Store = {
      ...worker,
      listLocationsDueForScan: async () => {
        await worker.createScan(locationId, "manual", null);
        return [locationId];
      },
    };
    const sendBatch = vi.fn();
    expect(await enqueueDueScans(racing, { sendBatch })).toBe(0);
    expect(sendBatch).not.toHaveBeenCalled();
    expect(db.scans).toHaveLength(1);
  });

  it("sends nothing when no location is due", async () => {
    db.queries = [];
    const sendBatch = vi.fn();
    expect(await enqueueDueScans(worker, { sendBatch })).toBe(0);
    expect(sendBatch).not.toHaveBeenCalled();
  });
});

describe("mock providers", () => {
  it("cover every surface and repeat within a day", async () => {
    const registry = createMockProviders();
    expect(Object.keys(registry).sort()).toEqual([...SURFACES].sort());

    const location = db.locations[0];
    const query = db.queries[0];
    if (!location || !query) throw new Error("seed failed");
    const morning = { location, query, at: new Date("2026-10-04T08:00:00Z") };
    const evening = { location, query, at: new Date("2026-10-04T20:00:00Z") };

    for (const surface of SURFACES) {
      const first = await registry[surface]?.observe(morning);
      expect(first, surface).toEqual(await registry[surface]?.observe(evening));
      const expectedKind =
        surface === "google_local_pack" || surface === "google_organic" ? "ranking" : "answer";
      expect(first?.kind, surface).toBe(expectedKind);
    }
  });

  it("show no AI Overview for a few keywords, the same ones on every day", async () => {
    const overview = createMockProviders().google_ai_overview;
    const location = db.locations[0];
    if (!location || !overview) throw new Error("seed failed");
    const keywords = [
      "pizza near me",
      "late night pizza",
      "pizza delivery",
      "best pizza downtown",
      "gluten free pizza",
      "pizza by the slice",
    ];
    const empty = async (text: string, day: string) => {
      const query = { ...db.queries[0], id: `q-${text}`, kind: "search_keyword", text } as never;
      const seen = await overview.observe({ location, query, at: new Date(day) });
      return seen.kind === "answer" && seen.text === "";
    };
    const monday = await Promise.all(keywords.map((text) => empty(text, "2026-10-05T08:00:00Z")));
    const friday = await Promise.all(keywords.map((text) => empty(text, "2026-10-09T08:00:00Z")));
    expect(friday).toEqual(monday);
    expect(monday).toContain(true);
    expect(monday).toContain(false);
  });

  it("run end to end through a scan", async () => {
    const scan = await queueScan();
    expect(await runScan(scan.id, { store: worker, providers: createMockProviders() })).toBe(
      "succeeded",
    );
    // One prompt, asked of the four assistants.
    expect(db.results.map((result) => result.surface).sort()).toEqual([
      "chatgpt",
      "claude",
      "gemini",
      "perplexity",
    ]);
  });
});

describe("what a scan used", () => {
  /** Reports usage the way a live provider does: once per call it was charged for. */
  const charged = (surface: "chatgpt" | "gemini", model: string, fail = false) => ({
    surface,
    observe: async ({ onUsage }: { onUsage?: (usage: CallUsage) => void }) => {
      onUsage?.({
        model,
        input_tokens: 1000,
        cached_input_tokens: 10,
        output_tokens: 50,
        searches: 2,
      });
      if (fail) throw new Error("upstream 503");
      return {
        kind: "answer" as const,
        text: "Try Joe's Pizza.",
        businesses: ["Joe's Pizza"],
        cited_urls: [],
      };
    },
  });

  it("is kept for each surface and model, added up over the scan's calls", async () => {
    const user = memoryStore(db, owner);
    await user.createQuery(locationId, { kind: "ai_prompt", text: "late night pizza" });
    const scan = await queueScan();
    await runScan(scan.id, {
      store: worker,
      providers: { chatgpt: charged("chatgpt", "gpt-x"), gemini: charged("gemini", "gem-y") },
    });

    const organizationId = db.organizations[0]?.id;
    expect(db.usage).toEqual([
      {
        organization_id: organizationId,
        scan_id: scan.id,
        surface: "chatgpt",
        model: "gpt-x",
        // Two prompts, so two calls.
        calls: 2,
        input_tokens: 2000,
        cached_input_tokens: 20,
        output_tokens: 100,
        searches: 4,
        created_at: expect.any(String),
      },
      expect.objectContaining({ surface: "gemini", model: "gem-y", calls: 2 }),
    ]);
  });

  it("is kept for a scan that fails, because what it asked was still charged for", async () => {
    const scan = await queueScan();
    await expect(
      runScan(scan.id, {
        store: worker,
        providers: {
          chatgpt: charged("chatgpt", "gpt-x"),
          gemini: charged("gemini", "gem-y", true),
        },
      }),
    ).rejects.toThrow("upstream 503");

    expect((await worker.getScan(scan.id))?.status).toBe("failed");
    expect(db.usage.map((row) => [row.surface, row.calls])).toEqual([
      ["chatgpt", 1],
      ["gemini", 1],
    ]);
  });

  it("is nothing when the data was generated", async () => {
    const scan = await queueScan();
    await runScan(scan.id, { store: worker, providers: createMockProviders(), sampleData: true });
    expect(db.usage).toEqual([]);
  });
});

describe("a test organization's scans", () => {
  const robot = "e0000000-0000-4000-8000-000000000005";
  const sampleProviders = createMockProviders();
  let testLocationId: string;

  beforeEach(async () => {
    db.testAccounts.add(robot);
    db.emails.set(robot, "e2e@example.com");
    const account = memoryStore(db, robot);
    const organization = await account.createOrganization("Smoke test");
    expect(organization.is_test).toBe(true);
    const location = await account.createLocation(organization.id, {
      name: "Joe's Pizza",
      website: "https://joes.example",
      phone: null,
      address_line: null,
      city: "Raleigh",
      region: "NC",
      postal_code: null,
      country_code: "US",
      google_place_id: null,
      primary_category: null,
    });
    testLocationId = location.id;
    await account.createQuery(testLocationId, { kind: "ai_prompt", text: "best pizza in Raleigh" });
  });

  it("run on generated data in a live deployment, and say so on the scan", async () => {
    const real = vi.fn(providers.chatgpt?.observe);
    const inspectSite = vi.fn();
    const notify = vi.fn();
    const scan = await worker.createScan(testLocationId, "scheduled", null);

    const outcome = await runScan(scan.id, {
      store: worker,
      providers: { chatgpt: { surface: "chatgpt", observe: real } },
      sampleProviders,
      sampleData: false,
      // Even a build that cannot run live scans can run these: they ask nobody anything.
      unavailable: "This build cannot run live scans.",
      inspectSite,
      notify,
    });

    expect(outcome).toBe("succeeded");
    expect(await worker.getScan(scan.id)).toMatchObject({ status: "succeeded", sample_data: true });
    // Nothing real was asked, fetched or emailed.
    expect(real).not.toHaveBeenCalled();
    expect(inspectSite).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    // Generated data covers every surface, which is how these are told from a live scan's.
    const surfaces = new Set((await worker.listScanResults(scan.id)).map((r) => r.surface));
    expect(surfaces.size).toBeGreaterThan(2);
  });

  it("leave a real organization's scans in the same deployment real", async () => {
    const scan = await queueScan();
    await runScan(scan.id, { store: worker, providers, sampleProviders, sampleData: false });
    expect(await worker.getScan(scan.id)).toMatchObject({
      status: "succeeded",
      sample_data: false,
    });
    expect((await worker.listScanResults(scan.id)).map((result) => result.surface)).toEqual([
      "chatgpt",
      "gemini",
    ]);
  });
});

describe("emailMessage", () => {
  const email = { subject: "Joe's Pizza: visibility 80 of 100", text: "Latest scan" };
  const from = "Nearcited <reports@nearcited.example>";

  it("sends replies to the address that is read, when one is set", () => {
    const sent = emailMessage(
      { EMAIL_FROM: from, EMAIL_REPLY_TO: "support@nearcited.example" },
      ["owner@joes.example"],
      email,
    );
    expect(sent).toEqual({
      from,
      to: ["owner@joes.example"],
      replyTo: "support@nearcited.example",
      ...email,
    });
  });

  it("leaves replies to go to the sender when none is set", () => {
    for (const EMAIL_REPLY_TO of [undefined, "", "   "]) {
      const sent = emailMessage(
        { EMAIL_FROM: from, EMAIL_REPLY_TO },
        ["owner@joes.example"],
        email,
      );
      expect(sent).toEqual({ from, to: ["owner@joes.example"], ...email });
    }
  });
});

describe("buildScanReportEmail", () => {
  it("summarises the scan and links to the location", async () => {
    const scan = await queueScan("scheduled");
    let report: ScanReport | undefined;
    await runScan(scan.id, {
      store: worker,
      providers,
      notify: async (sent) => {
        report = sent;
        return true;
      },
    });
    if (!report) throw new Error("no report");

    const email = buildScanReportEmail(report, "https://app.example/");
    expect(email.subject).toBe("Joe's Pizza: visibility 40 of 100");
    expect(email.text).toContain("ChatGPT: named in 1 of 1");
    expect(email.text).toContain("Gemini: named in 0 of 1");
    expect(email.text).toContain(`https://app.example/locations/${locationId}`);
  });

  it("says which assistants were asked on a stronger model", async () => {
    const organization = db.organizations[0];
    if (organization) organization.stronger_surfaces = ["chatgpt"];
    const scan = await queueScan("scheduled");
    let report: ScanReport | undefined;
    await runScan(scan.id, {
      store: worker,
      providers,
      strongerProviders: { chatgpt: providers.chatgpt as NonNullable<ProviderRegistry["chatgpt"]> },
      notify: async (sent) => {
        report = sent;
        return true;
      },
    });
    if (!report) throw new Error("no report");
    const { text } = buildScanReportEmail(report, "https://app.example/");
    expect(text).toContain("ChatGPT (stronger): named in 1 of 1");
    expect(text).toContain("Gemini: named in 0 of 1");
  });
});

describe("tuning", () => {
  it("scores with the weights it is given", async () => {
    const scan = await queueScan();
    const weights = { unranked: 0, by_position: [{ through: 1, weight: 1 }], beyond: 0 };
    await runScan(scan.id, { store: worker, providers, weights });
    // ChatGPT names the business second, which these weights count as nothing.
    expect((await worker.getScan(scan.id))?.visibility_score).toBe(0);
  });

  it("fails every scan, without calling a provider, when the build cannot run live scans", async () => {
    const scan = await queueScan();
    const observe = vi.fn();
    const outcome = await runScan(scan.id, {
      store: worker,
      providers: { chatgpt: { surface: "chatgpt", observe } },
      unavailable: "Live scans are turned off.",
    });
    expect(outcome).toBe("failed");
    expect(observe).not.toHaveBeenCalled();
    expect((await worker.getScan(scan.id))?.error).toBe("Live scans are turned off.");
  });

  it("turns live scans off only for live mode on default tuning", () => {
    expect(liveScansUnavailable({ PROVIDER_MODE: "live" }, "default")).toMatch(/turned off/);
    expect(liveScansUnavailable({ PROVIDER_MODE: "live" }, "private")).toBeUndefined();
    expect(liveScansUnavailable({ PROVIDER_MODE: "mock" }, "default")).toBeUndefined();
  });
});

describe("the scan window", () => {
  /** Nobody names the business. */
  const silent: ProviderRegistry = {
    chatgpt: {
      surface: "chatgpt",
      observe: async () => ({
        kind: "answer",
        text: "Try Tony's Slice House.",
        businesses: ["Tony's Slice House"],
        cited_urls: [],
      }),
    },
    gemini: providers.gemini,
  };

  async function scan(registry: ProviderRegistry, options: { sampleData?: boolean } = {}) {
    const queued = await queueScan("scheduled");
    let report: ScanReport | undefined;
    await runScan(queued.id, {
      store: worker,
      providers: registry,
      sampleData: options.sampleData,
      notify: async (sent) => {
        report = sent;
        return true;
      },
    });
    if (!report) throw new Error("no report");
    return { report, stored: await worker.getScan(queued.id) };
  }

  it("scores over this scan and the ones before it", async () => {
    // ChatGPT names the business second (0.8) and Gemini does not: (0.8 + 0) / 2.
    expect((await scan(providers)).stored?.visibility_score).toBe(40);
    // Then nobody does. ChatGPT is now 1 of 2, so its cell is worth 0.4: (0.4 + 0) / 2.
    const second = await scan(silent);
    expect(second.stored?.visibility_score).toBe(20);
    expect(second.report.window.scans).toBe(2);
    expect(second.report.results).toHaveLength(2);
    expect(second.report.window.results).toHaveLength(4);
  });

  it("stops counting scans older than the window", async () => {
    await scan(providers);
    for (let i = 0; i < 6; i++) await scan(silent);
    // Seven scans: the one hit is still inside the window.
    expect((await worker.listScans(locationId, 1))[0]?.visibility_score).toBeCloseTo(5.7, 1);
    // The eighth pushes it out.
    expect((await scan(silent)).stored?.visibility_score).toBe(0);
  });

  it("derives recommendations from the window, not from one answer", async () => {
    await scan(providers);
    await scan(silent);
    const recommendations = await worker.listRecommendations(locationId);
    // ChatGPT named the business once in the window, so it is not reported as absent there.
    // Four answers in the window and none cited the business's own site, which is said too.
    expect(recommendations.map((recommendation) => recommendation.rule)).toEqual([
      "absent:gemini",
      "own_site_uncited",
    ]);
    expect(recommendations[0]?.detail).toContain("any of 2 checks");
  });

  it("asks for a page for a prompt none of the window's four answers named the business for", async () => {
    await scan(silent);
    const [query] = await worker.listQueries(locationId);
    // Two answers say too little.
    expect((await worker.listRecommendations(locationId)).map((r) => r.rule)).not.toContain(
      `page:${query?.id}`,
    );
    await scan(silent);
    const page = (await worker.listRecommendations(locationId)).find(
      (recommendation) => recommendation.rule === `page:${query?.id}`,
    );
    expect(page).toMatchObject({
      status: "open",
      title: "Publish a page that answers “best pizza in Raleigh”",
    });
    // An answer that names the business clears it.
    await scan(providers);
    expect(
      (await worker.listRecommendations(locationId)).find((r) => r.rule === `page:${query?.id}`)
        ?.status,
    ).toBe("done");
  });

  it("records the kind of scan and never mixes sample scans with real ones", async () => {
    const sample = await scan(providers, { sampleData: true });
    expect(sample.stored?.sample_data).toBe(true);

    const real = await scan(silent);
    expect(real.stored?.sample_data).toBe(false);
    // The sample scan named the business, but the real scan's window does not include it.
    expect(real.stored?.visibility_score).toBe(0);
    expect(real.report.window.scans).toBe(1);
  });

  it("says in the report how many scans the counts cover", async () => {
    await scan(providers);
    const { report } = await scan(silent);
    const email = buildScanReportEmail(report, "https://app.example");
    expect(email.subject).toBe("Joe's Pizza: visibility 20 of 100");
    expect(email.text).toContain("Where it was named, over the last 2 scans:");
    expect(email.text).toContain("ChatGPT: named in 1 of 2");
    expect(email.text).toContain("Gemini: named in 0 of 2");
  });
});

describe("one scan in flight per location", () => {
  it("refuses a second scan while one is queued or running, and allows one after", async () => {
    const first = await queueScan();
    await expect(queueScan()).rejects.toMatchObject({ kind: "conflict" });

    await worker.markScanRunning(first.id, false);
    await expect(queueScan()).rejects.toMatchObject({ kind: "conflict" });

    await worker.failScan(first.id, "upstream 503");
    expect((await queueScan()).status).toBe("queued");
  });

  it("skips a redelivered scan when a newer one for the location is in flight", async () => {
    const old = await queueScan();
    await worker.failScan(old.id, "upstream 503");
    const newer = await queueScan();

    expect(await runScan(old.id, { store: worker, providers })).toBe("skipped");
    expect((await worker.getScan(old.id))?.status).toBe("failed");
    expect((await worker.getScan(newer.id))?.status).toBe("queued");
  });
});

describe("failStaleScans", () => {
  // The in-memory store has its own clock, so "later" is measured from the scan itself.
  const since = (scan: { created_at: string }, ms: number) =>
    new Date(Date.parse(scan.created_at) + ms);

  it("fails a scan left queued too long, so the location can be scanned again", async () => {
    const stuck = await queueScan();
    expect(await failStaleScans(worker, since(stuck, STALE_AFTER_MS - 60_000))).toBe(0);
    expect((await worker.getScan(stuck.id))?.status).toBe("queued");

    expect(await failStaleScans(worker, since(stuck, STALE_AFTER_MS + 60_000))).toBe(1);
    expect(await worker.getScan(stuck.id)).toMatchObject({
      status: "failed",
      error: "The scan did not finish and was abandoned. Run it again.",
    });
    expect((await queueScan()).status).toBe("queued");
  });

  it("fails a scan left running too long, timed from when it started", async () => {
    const stuck = await queueScan();
    await worker.markScanRunning(stuck.id, false);
    expect(await failStaleScans(worker, since(stuck, STALE_AFTER_MS + 60_000))).toBe(1);
    expect((await worker.getScan(stuck.id))?.status).toBe("failed");
  });

  it("leaves finished scans alone", async () => {
    const done = await queueScan();
    await runScan(done.id, { store: worker, providers });
    expect(await failStaleScans(worker, since(done, STALE_AFTER_MS * 10))).toBe(0);
    expect((await worker.getScan(done.id))?.status).toBe("succeeded");
  });

  it("lets a scan that was failed as abandoned run if its message turns up", async () => {
    const late = await queueScan();
    await failStaleScans(worker, since(late, STALE_AFTER_MS + 60_000));
    expect(await runScan(late.id, { store: worker, providers })).toBe("succeeded");
  });
});

describe("usage caps", () => {
  it("do not count scheduled scans against the manual-scan limit", async () => {
    const organization = db.organizations[0];
    if (!organization) throw new Error("no organization");
    organization.max_manual_scans_per_month = 0;

    const scheduled = await worker.createScan(locationId, "scheduled", null);
    expect(scheduled.status).toBe("queued");
    await worker.failScan(scheduled.id, "upstream 503");
    await expect(
      memoryStore(db, owner).createScan(locationId, "manual", owner),
    ).rejects.toMatchObject({ kind: "limit" });
  });
});

describe("plan surfaces", () => {
  it("checks only the surfaces the organization's plan covers", async () => {
    const organization = db.organizations[0];
    if (!organization) throw new Error("no organization");
    organization.surfaces = ["chatgpt"];
    const gemini = vi.fn(providers.gemini?.observe);

    const scan = await queueScan();
    await runScan(scan.id, {
      store: worker,
      providers: { ...providers, gemini: { surface: "gemini", observe: gemini } },
    });

    // Gemini is set up but not in the plan, so it is never called and never charged for.
    expect(gemini).not.toHaveBeenCalled();
    expect((await worker.listScanResults(scan.id)).map((result) => result.surface)).toEqual([
      "chatgpt",
    ]);
  });

  it("fails without retrying when the plan covers no surface that is set up", async () => {
    const organization = db.organizations[0];
    if (!organization) throw new Error("no organization");
    organization.surfaces = ["perplexity"];
    const scan = await queueScan();
    expect(await runScan(scan.id, { store: worker, providers })).toBe("failed");
  });
});

describe("stronger models", () => {
  /** ChatGPT's stronger model names the business first. */
  const stronger = vi.fn(
    async (): Promise<Observation> => ({
      kind: "answer",
      text: "Joe's Pizza is the one.",
      businesses: ["Joe's Pizza"],
      cited_urls: [],
    }),
  );
  const strongerProviders: ProviderRegistry = {
    chatgpt: { surface: "chatgpt", observe: stronger },
  };
  const organization = () => {
    const found = db.organizations[0];
    if (!found) throw new Error("no organization");
    return found;
  };
  const tiers = async (scanId: string) =>
    (await worker.listScanResults(scanId)).map(({ surface, tier }) => [surface, tier]).sort();

  beforeEach(() => {
    stronger.mockClear();
  });

  it("asks an assistant paid Stronger on with the stronger settings, and keeps the tier", async () => {
    organization().stronger_surfaces = ["chatgpt"];
    const scan = await queueScan();
    await runScan(scan.id, { store: worker, providers, strongerProviders });
    expect(stronger).toHaveBeenCalledTimes(1);
    expect(await tiers(scan.id)).toEqual([
      ["chatgpt", "stronger"],
      ["gemini", "standard"],
    ]);
    // What the stronger model said is the result.
    const [chatgpt] = (await worker.listScanResults(scan.id)).filter(
      (r) => r.surface === "chatgpt",
    );
    expect(chatgpt).toMatchObject({ mentioned: true, position: 1 });
  });

  it("never asks a test organization's on Stronger, whatever it says it pays for", async () => {
    Object.assign(organization(), { is_test: true, stronger_surfaces: ["chatgpt"] });
    const scan = await queueScan();
    await runScan(scan.id, {
      store: worker,
      providers,
      strongerProviders,
      sampleProviders: createMockProviders(),
    });
    expect(stronger).not.toHaveBeenCalled();
    const asked = await worker.listScanResults(scan.id);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((result) => result.tier === "standard")).toBe(true);
  });

  it("asks everyone else with the standard settings", async () => {
    const scan = await queueScan();
    await runScan(scan.id, { store: worker, providers, strongerProviders });
    expect(stronger).not.toHaveBeenCalled();
    expect(await tiers(scan.id)).toEqual([
      ["chatgpt", "standard"],
      ["gemini", "standard"],
    ]);
  });

  it("asks on Standard, and says so, where the tuning has no stronger model", async () => {
    organization().stronger_surfaces = ["chatgpt"];
    const scan = await queueScan();
    await runScan(scan.id, { store: worker, providers, strongerProviders: {} });
    expect(await tiers(scan.id)).toEqual([
      ["chatgpt", "standard"],
      ["gemini", "standard"],
    ]);
  });

  it("are built only for the assistants the tuning has a stronger model for", () => {
    const env = { PROVIDER_MODE: "mock" } as Env;
    expect(Object.keys(createStrongerProviders(env, defaultTuning)).sort()).toEqual([
      "chatgpt",
      "claude",
    ]);
    const { stronger: _, ...claude } = defaultTuning.claude;
    expect(Object.keys(createStrongerProviders(env, { ...defaultTuning, claude }))).toEqual([
      "chatgpt",
    ]);
  });

  it("starts the assistant's score again on the stronger model", async () => {
    // Two scans on Standard, where ChatGPT named the business second, then one on Stronger.
    for (let i = 0; i < 2; i++) {
      await runScan((await queueScan()).id, { store: worker, providers, strongerProviders });
    }
    organization().stronger_surfaces = ["chatgpt"];
    const scan = await queueScan();
    await runScan(scan.id, { store: worker, providers, strongerProviders });
    const scored = await worker.getScan(scan.id);
    // ChatGPT is first on its one stronger check, and Gemini named only a competitor.
    expect(scored?.visibility_score).toBe(50);
  });
});

describe("the on-page check", () => {
  const page = (html: string | null) => async () => ({
    url: "https://joes.example/",
    status: html === null ? 503 : 200,
    html,
    robots_txt: null,
    noindex_header: false,
  });
  const words = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
  const siteRules = async () =>
    (await worker.listRecommendations(locationId))
      .filter((recommendation) => recommendation.status === "open")
      .map((recommendation) => recommendation.rule)
      .filter((rule) => rule.startsWith("site:"));
  const run = async (inspectSite?: Parameters<typeof runScan>[1]["inspectSite"]) => {
    const scan = await queueScan();
    return runScan(scan.id, { store: worker, providers, inspectSite });
  };

  it("turns what the page lacks into recommendations, and clears them when it is fixed", async () => {
    const inspected: string[] = [];
    await run(async (website) => {
      inspected.push(website);
      return page(`<p>Welcome. ${words}</p>`)();
    });
    expect(inspected).toEqual(["https://joes.example"]);
    expect(await siteRules()).toEqual([
      "site:names_business",
      "site:names_city",
      "site:structured_data",
    ]);

    await run(
      page(
        `<p>Joe's Pizza in Raleigh. ${words}</p><script type="application/ld+json">{"name":"Joe's Pizza","address":"1 Main St"}</script>`,
      ),
    );
    expect(await siteRules()).toEqual([]);
  });

  it("keeps the whole check with the scan, for the checklist and the action plan", async () => {
    await run(page(`<p>Joe's Pizza. ${words}</p>`));
    const kept = await worker.getSiteCheck(locationId);
    expect(kept?.checks.filter((check) => !check.passed).map((check) => check.id)).toEqual([
      "names_city",
      "structured_data",
    ]);

    // A later scan that does not look replaces it with nothing, rather than leaving a stale one.
    await run();
    expect(await worker.getSiteCheck(locationId)).toBeNull();
  });

  it("does not fail the scan when the site is gone or the fetch throws", async () => {
    expect(await run(async () => ({ ...(await page(null)()), status: 404 }))).toBe("succeeded");
    expect(await siteRules()).toEqual(["site:reachable"]);

    // A fetch that throws proves nothing about the site, so the earlier finding is dropped
    // rather than repeated, and nothing new is claimed.
    expect(
      await run(async () => {
        throw new Error("connection reset");
      }),
    ).toBe("succeeded");
    expect(await siteRules()).toEqual([]);
    expect((await worker.getSiteCheck(locationId))?.checks).toEqual([]);
  });

  it("says nothing about the site when it is not asked to look", async () => {
    await run();
    expect(await siteRules()).toEqual([]);
  });
});

describe("alerts", () => {
  /** Nobody names the business. */
  const silent: ProviderRegistry = {
    chatgpt: {
      surface: "chatgpt",
      observe: async () => ({
        kind: "answer",
        text: "Try Tony's Slice House.",
        businesses: ["Tony's Slice House"],
        cited_urls: [],
      }),
    },
    gemini: providers.gemini,
  };

  async function scans(registry: ProviderRegistry, count: number, sampleData = false) {
    for (let i = 0; i < count; i++) {
      const queued = await queueScan();
      await runScan(queued.id, { store: worker, providers: registry, sampleData });
    }
  }

  it("raises a drop at the third scan in a row that does not name the business", async () => {
    await scans(providers, 4);
    await scans(silent, 2);
    expect(db.alerts).toEqual([]);

    await scans(silent, 1);
    // ChatGPT named it four times and then stopped. Gemini never named it, which is not a drop.
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]).toMatchObject({
      location_id: locationId,
      kind: "drop",
      surface: "chatgpt",
      tracked_query_id: db.queries[0]?.id,
      facts: { prompt: "best pizza in Raleigh", missed: 3, checks_before: 4, named_before: 4 },
      scan_id: db.scans[6]?.id,
      cleared_at: null,
      dismissed_at: null,
    });
    // It dates from the first scan that missed, not from the one that raised it.
    expect(db.alerts[0]?.since).toBe(
      db.results.find((result) => result.scan_id === db.scans[4]?.id)?.sampled_at,
    );
  });

  it("says it once while it goes on, and clears it when the business is named again", async () => {
    await scans(providers, 4);
    await scans(silent, 5);
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]?.cleared_at).toBeNull();

    await scans(providers, 1);
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]).toMatchObject({ clear_reason: "named_again" });
    expect(db.alerts[0]?.cleared_at).not.toBeNull();
    expect(await worker.listAlerts(locationId, false)).toEqual([]);
  });

  it("does not clear one by age, however long the business stays unnamed", async () => {
    await scans(providers, 4);
    await scans(silent, 12);
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]?.cleared_at).toBeNull();
  });

  it("leaves a dismissed alert dismissed while the drop goes on, then clears it", async () => {
    await scans(providers, 4);
    await scans(silent, 3);
    const [raised] = db.alerts;
    expect(await memoryStore(db, owner).dismissAlert(raised?.id ?? "")).toMatchObject({
      dismissed_by_email: "owner@example.com",
    });

    // The rule still fires at the next scan. The dismissed alert stands in its way.
    await scans(silent, 1);
    expect(db.alerts).toHaveLength(1);
    expect(db.alerts[0]?.dismissed_at).not.toBeNull();

    await scans(providers, 1);
    expect(db.alerts[0]).toMatchObject({ clear_reason: "named_again" });
  });

  it("raises a drop again only once it has ended and begun afresh", async () => {
    await scans(providers, 4);
    await scans(silent, 3);
    await scans(providers, 4);
    await scans(silent, 3);
    expect(db.alerts.map((alert) => alert.clear_reason)).toEqual(["named_again", null]);
  });

  it("clears an alert about a prompt that is no longer asked", async () => {
    await scans(providers, 4);
    await scans(silent, 3);
    const user = memoryStore(db, owner);
    await user.setQueryActive(db.queries[0]?.id ?? "", false);
    await user.createQuery(locationId, { kind: "ai_prompt", text: "pizza delivery Raleigh" });

    await scans(silent, 1);
    expect(db.alerts[0]).toMatchObject({ clear_reason: "not_tracked" });
  });

  it("keeps the alerts of sample scans apart from those of real ones", async () => {
    await scans(providers, 4, true);
    await scans(silent, 3, true);
    expect(await worker.listAlerts(locationId, true)).toHaveLength(1);
    expect(await worker.listAlerts(locationId, false)).toEqual([]);

    // A real scan that names the business says nothing about the sample window's drop.
    await scans(providers, 1);
    expect((await worker.listAlerts(locationId, true))[0]?.cleared_at).toBeNull();
  });

  describe("in the report", () => {
    /** One scheduled scan, and the report it sent, if it sent one. */
    async function scheduled(registry: ProviderRegistry, sent: boolean | Error = true) {
      const queued = await queueScan("scheduled");
      let report: ScanReport | undefined;
      await runScan(queued.id, {
        store: worker,
        providers: registry,
        notify: async (given) => {
          if (sent instanceof Error) throw sent;
          report = given;
          return sent;
        },
      });
      return report;
    }
    const news = (report: ScanReport | undefined) => [
      report?.alerts.raised.length,
      report?.alerts.named_again.length,
    ];

    it("lead the report of the scan that raised them, once", async () => {
      await scans(providers, 4);
      await scans(silent, 2);
      const report = await scheduled(silent);
      expect(news(report)).toEqual([1, 0]);
      expect(report?.alerts.raised[0]?.facts).toMatchObject({ missed: 3, named_before: 4 });
      expect(db.alerts[0]?.told_at).not.toBeNull();

      // The drop goes on. The next report has nothing new to say about it.
      expect(news(await scheduled(silent))).toEqual([0, 0]);
    });

    it("say once that a drop the owners were told of has ended", async () => {
      await scans(providers, 4);
      await scans(silent, 2);
      await scheduled(silent);

      expect(news(await scheduled(providers))).toEqual([0, 1]);
      expect(db.alerts[0]?.cleared_told_at).not.toBeNull();
      expect(news(await scheduled(providers))).toEqual([0, 0]);
    });

    it("carry what a manual scan raised, if it is still open when the next report goes", async () => {
      await scans(providers, 4);
      await scans(silent, 3);
      expect(db.alerts[0]?.told_at).toBeNull();

      expect(news(await scheduled(silent))).toEqual([1, 0]);
    });

    it("say nothing of a drop that began and ended between two reports", async () => {
      await scans(providers, 4);
      await scans(silent, 3);
      await scans(providers, 1);
      expect(db.alerts[0]).toMatchObject({ clear_reason: "named_again", told_at: null });

      expect(news(await scheduled(providers))).toEqual([0, 0]);
    });

    it("say nothing of an alert a member dismissed first, nor that it ended", async () => {
      await scans(providers, 4);
      await scans(silent, 3);
      await memoryStore(db, owner).dismissAlert(db.alerts[0]?.id ?? "");

      expect(news(await scheduled(silent))).toEqual([0, 0]);
      expect(news(await scheduled(providers))).toEqual([0, 0]);
    });

    it("say nothing of the end of a drop that was dismissed after the owners were told", async () => {
      await scans(providers, 4);
      await scans(silent, 2);
      await scheduled(silent);
      await memoryStore(db, owner).dismissAlert(db.alerts[0]?.id ?? "");

      expect(news(await scheduled(providers))).toEqual([0, 0]);
    });

    it("say nothing of an alert that ended because its prompt was retired", async () => {
      await scans(providers, 4);
      await scans(silent, 2);
      await scheduled(silent);
      const user = memoryStore(db, owner);
      await user.setQueryActive(db.queries[0]?.id ?? "", false);
      await user.createQuery(locationId, { kind: "ai_prompt", text: "pizza delivery Raleigh" });

      expect(news(await scheduled(silent))).toEqual([0, 0]);
      expect(db.alerts[0]).toMatchObject({ clear_reason: "not_tracked", cleared_told_at: null });
    });

    it("stay untold when the report went to nobody, or was not sent, and go in the next", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      await scans(providers, 4);
      await scans(silent, 2);

      // Nobody is an owner with an address.
      expect(news(await scheduled(silent, false))).toEqual([1, 0]);
      expect(db.alerts[0]?.told_at).toBeNull();
      // The mail service refused it.
      await scheduled(silent, new Error("Resend is down"));
      expect(db.alerts[0]?.told_at).toBeNull();

      expect(news(await scheduled(silent))).toEqual([1, 0]);
      expect(db.alerts[0]?.told_at).not.toBeNull();
      errors.mockRestore();
    });

    it("do not hold the report back when they cannot be read", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      await scans(providers, 4);
      await scans(silent, 2);
      const queued = await queueScan("scheduled");
      let report: ScanReport | undefined;
      await runScan(queued.id, {
        store: {
          ...worker,
          listAlertsToTell: async () => {
            throw new Error("the database is away");
          },
        },
        providers: silent,
        notify: async (given) => {
          report = given;
          return true;
        },
      });

      // The report went, saying nothing of alerts, and the alert is still to tell.
      expect(report?.alerts).toEqual({ raised: [], named_again: [] });
      expect(db.alerts.map((alert) => alert.told_at)).toEqual([null]);
      expect(news(await scheduled(silent))).toEqual([1, 0]);
      errors.mockRestore();
    });

    it("stay untold where the plan sends no report", async () => {
      await scans(providers, 4);
      await scans(silent, 2);
      for (const organization of db.organizations) organization.emails_report = false;
      expect(await scheduled(silent)).toBeUndefined();
      expect(db.alerts.map((alert) => alert.told_at)).toEqual([null]);
    });

    it("stay untold for a test organization, which is sent no report", async () => {
      for (const organization of db.organizations) organization.is_test = true;
      const notify = vi.fn<(report: ScanReport) => Promise<boolean>>(async () => true);
      // Its scans are generated, by the providers of sample data.
      const generated = async (registry: ProviderRegistry, count: number) => {
        for (let i = 0; i < count; i++) {
          const queued = await queueScan("scheduled");
          await runScan(queued.id, {
            store: worker,
            providers: {},
            sampleProviders: registry,
            notify,
          });
        }
      };
      await generated(providers, 4);
      await generated(silent, 3);

      expect(db.alerts).toHaveLength(1);
      expect(db.alerts[0]).toMatchObject({ sample_data: true, told_at: null });
      expect(notify).not.toHaveBeenCalled();
    });

    it("put the alert in the subject and at the head of the message", async () => {
      await scans(providers, 4);
      await scans(silent, 2);
      const report = await scheduled(silent);
      if (!report) throw new Error("no report");
      const email = buildScanReportEmail(report, "https://app.example");

      expect(email.subject).toBe(
        'Joe\'s Pizza: No longer named for "best pizza in Raleigh" on ChatGPT',
      );
      const lines = email.text.split("\n");
      expect(lines.slice(0, 4)).toEqual([
        "Joe's Pizza has 1 new alert.",
        "",
        'No longer named for "best pizza in Raleigh" on ChatGPT',
        expect.stringMatching(
          /^ {2}Since October \d+, 2026\. It was named in 4 of the 4 checks before that and in none of the 3 since\.$/,
        ),
      ]);
      // The routine report follows, as it always did.
      expect(email.text).toContain("Latest scan for Joe's Pizza (Raleigh).");
      expect(email.text).toContain("ChatGPT: named in 4 of 7");
    });

    it("say in a line that the business is named again, under the usual subject", async () => {
      await scans(providers, 4);
      await scans(silent, 2);
      await scheduled(silent);
      const report = await scheduled(providers);
      if (!report) throw new Error("no report");
      const email = buildScanReportEmail(report, "https://app.example");

      expect(email.subject).toMatch(/^Joe's Pizza: visibility \d/);
      expect(email.text.split("\n")[0]).toMatch(
        /^Named again for "best pizza in Raleigh" on ChatGPT\. It had not been since October \d+, 2026\.$/,
      );
    });

    it("count several alerts in the subject, and show one surface's as one", async () => {
      const user = memoryStore(db, owner);
      await user.createQuery(locationId, { kind: "ai_prompt", text: "pizza delivery Raleigh" });
      await scans(providers, 4);
      await scans(silent, 2);
      const report = await scheduled(silent);
      if (!report) throw new Error("no report");
      const email = buildScanReportEmail(report, "https://app.example");

      expect(email.subject).toBe("Joe's Pizza: No longer named for 2 prompts on ChatGPT");
      expect(email.text).toContain("Joe's Pizza has 2 new alerts.");
      expect(email.text).toMatch(/\n {2}"pizza delivery Raleigh": Since October \d+, 2026\./);
    });
  });

  describe("a first sighting", () => {
    /** Both assistants name the businesses given and cite the pages given. */
    const answering = (names: string[], urls: string[] = []): ProviderRegistry =>
      Object.fromEntries(
        (["chatgpt", "gemini"] as const).map((surface) => [
          surface,
          {
            surface,
            observe: async (): Promise<Observation> => ({
              kind: "answer",
              text: `Try ${names.join(" or ")}.`,
              businesses: names,
              cited_urls: urls,
            }),
          },
        ]),
      );
    const usual = answering(["Tony's Slice House"], ["https://www.yelp.com/biz/tonys"]);
    const withOak = answering(
      ["Tony's Slice House", "Oak & Ember"],
      ["https://www.yelp.com/biz/tonys", "https://raleighfood.example/best-pizza"],
    );
    const kinds = () => db.alerts.map((alert) => alert.kind).sort();

    it("is raised for a business and a site the answers begin to name and cite", async () => {
      await scans(usual, 6);
      await scans(withOak, 1);
      // Two answers in one scan: not yet.
      expect(db.alerts).toEqual([]);

      await scans(withOak, 1);
      expect(kinds()).toEqual(["competitor", "site"]);
      const firstSeen = db.results.find((result) => result.scan_id === db.scans[6]?.id);
      expect(db.alerts.find((alert) => alert.kind === "competitor")).toMatchObject({
        subject: "oak and ember",
        facts: {
          name: "Oak & Ember",
          answers: 4,
          scans: 2,
          of_scans: 3,
          places: [{ prompt: "best pizza in Raleigh", surfaces: ["chatgpt", "gemini"] }],
          prompts: 1,
        },
        since: firstSeen?.sampled_at,
        scan_id: db.scans[7]?.id,
      });
      expect(db.alerts.find((alert) => alert.kind === "site")).toMatchObject({
        subject: "raleighfood.example",
        facts: {
          host: "raleighfood.example",
          answers: 4,
          named: 0,
          own: false,
          url: "https://raleighfood.example/best-pizza",
        },
      });

      // The answers go on naming it. It is said once.
      await scans(withOak, 3);
      expect(db.alerts).toHaveLength(2);
    });

    it("is not raised for what the record already holds, however long ago", async () => {
      await scans(withOak, 1);
      await scans(usual, 9);
      // Named and cited again, and by now out of the window: only the record remembers.
      await scans(withOak, 3);
      expect(db.alerts).toEqual([]);
    });

    it("is not raised in a location's first scans, which name everyone for the first time", async () => {
      await scans(withOak, 9);
      expect(db.alerts).toEqual([]);
    });

    it("reads the record only when a scan holds something that might be new", async () => {
      const read = vi.fn(worker.listSeenBefore);
      const store = { ...worker, listSeenBefore: read };
      const run = async (registry: ProviderRegistry, count: number) => {
        for (let i = 0; i < count; i++) {
          await runScan((await queueScan()).id, { store, providers: registry });
        }
      };
      await run(usual, 8);
      expect(read).not.toHaveBeenCalled();

      await run(withOak, 2);
      // The second scan with a newcomer is the first where it was named often enough.
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(locationId, false, 2);
    });

    it("is cleared as old news once seven more scans have passed, and never said again", async () => {
      await scans(usual, 6);
      await scans(withOak, 2);
      await scans(withOak, 6);
      expect(db.alerts.map((alert) => alert.cleared_at)).toEqual([null, null]);

      await scans(usual, 1);
      expect(db.alerts.map((alert) => alert.clear_reason)).toEqual(["old_news", "old_news"]);
      await scans(withOak, 4);
      expect(db.alerts).toHaveLength(2);
    });

    it("stays where a member dismissed it until it is old news", async () => {
      await scans(usual, 6);
      await scans(withOak, 2);
      for (const alert of db.alerts) await memoryStore(db, owner).dismissAlert(alert.id);

      await scans(withOak, 2);
      expect(db.alerts).toHaveLength(2);
      expect(db.alerts.every((alert) => alert.dismissed_at && !alert.cleared_at)).toBe(true);
    });

    it("says the business's own website apart, as the good news it is", async () => {
      const cited = answering(["Tony's Slice House"], ["https://joes.example/menu"]);
      await scans(usual, 6);
      await scans(cited, 2);
      expect(db.alerts).toHaveLength(1);
      expect(db.alerts[0]).toMatchObject({
        kind: "site",
        facts: { host: "joes.example", own: true, answers: 4, named: 4 },
      });
    });

    it("leads the report, in its subject and in its first lines", async () => {
      await scans(usual, 6);
      await scans(withOak, 1);
      const queued = await queueScan("scheduled");
      let report: ScanReport | undefined;
      await runScan(queued.id, {
        store: worker,
        providers: withOak,
        notify: async (given) => {
          report = given;
          return true;
        },
      });
      if (!report) throw new Error("no report");
      const email = buildScanReportEmail(report, "https://app.example");

      expect(email.subject).toBe("Joe's Pizza: 2 new alerts");
      expect(email.text).toContain("Oak & Ember is named for the first time\n  Since October");
      expect(email.text).toContain(
        'and in no answer before. It was named for "best pizza in Raleigh" on ChatGPT and Gemini.',
      );
      expect(email.text).toContain("raleighfood.example is read for the first time\n  Since");
      expect(email.text).toContain("None of those answers named the business.");
      expect(db.alerts.every((alert) => alert.told_at !== null)).toBe(true);
    });

    it("is said in the subject by name when it is the only news", async () => {
      await scans(usual, 6);
      await scans(answering(["Tony's Slice House", "Oak & Ember"], ["https://www.yelp.com/x"]), 1);
      const queued = await queueScan("scheduled");
      let report: ScanReport | undefined;
      await runScan(queued.id, {
        store: worker,
        providers: answering(["Tony's Slice House", "Oak & Ember"], ["https://www.yelp.com/x"]),
        notify: async (given) => {
          report = given;
          return true;
        },
      });
      if (!report) throw new Error("no report");
      expect(buildScanReportEmail(report, "https://app.example").subject).toBe(
        "Joe's Pizza: Oak & Ember is named for the first time",
      );
    });
  });

  describe("a phone number that is not the location's", () => {
    const ON_FILE = "+19195550100";
    /** Both assistants answer with this text, naming the two businesses. */
    const saying = (text: string): ProviderRegistry =>
      Object.fromEntries(
        (["chatgpt", "gemini"] as const).map((surface) => [
          surface,
          {
            surface,
            observe: async (): Promise<Observation> => ({
              kind: "answer",
              text,
              businesses: ["Tony's Slice House", "Joe's Pizza"],
              cited_urls: [],
            }),
          },
        ]),
      );
    const other = saying("Try Tony's Slice House, or Joe's Pizza on (919) 555-0199.");
    const none = saying("Try Tony's Slice House or Joe's Pizza.");
    const theirs = saying("Try Tony's Slice House on (919) 555-0142, or Joe's Pizza.");

    beforeEach(() => {
      for (const location of db.locations) location.phone = ON_FILE;
    });

    it("is kept with each answer that gave one for the business, and for no other", async () => {
      await scans(other, 1);
      expect(db.results.map((result) => result.phones)).toEqual([
        ["+19195550199"],
        ["+19195550199"],
      ]);
      // A number written for somebody else is not the business's.
      await scans(theirs, 1);
      expect(db.results.slice(2).map((result) => result.phones)).toEqual([[], []]);
    });

    it("is raised at the second scan whose answers give it, with the number on file beside it", async () => {
      await scans(other, 1);
      // Two answers, but one scan: the same reading of the same kind of answer.
      expect(db.alerts).toEqual([]);

      await scans(other, 1);
      expect(db.alerts).toHaveLength(1);
      expect(db.alerts[0]).toMatchObject({
        kind: "phone",
        subject: "+19195550199",
        facts: {
          number: "+19195550199",
          on_file: ON_FILE,
          country_code: "US",
          answers: 4,
          scans: 2,
          of_scans: 2,
          places: [{ prompt: "best pizza in Raleigh", surfaces: ["chatgpt", "gemini"] }],
          prompts: 1,
        },
        since: db.results[0]?.sampled_at,
      });
      await scans(other, 2);
      expect(db.alerts).toHaveLength(1);
    });

    it("is not raised where the answers give the number on file, or none is on file", async () => {
      await scans(saying("Try Tony's Slice House, or Joe's Pizza on 919-555-0100."), 3);
      expect(db.alerts).toEqual([]);

      for (const location of db.locations) location.phone = null;
      await scans(other, 3);
      expect(db.alerts).toEqual([]);
    });

    it("is cleared once the window holds no answer that gives it", async () => {
      await scans(other, 2);
      await scans(none, 6);
      expect(db.alerts[0]?.cleared_at).toBeNull();

      await scans(none, 1);
      expect(db.alerts[0]).toMatchObject({ clear_reason: "no_longer_given" });
    });

    it("is cleared when the number is put on file", async () => {
      await scans(other, 2);
      for (const location of db.locations) location.phone = "+19195550199";
      await scans(other, 1);
      expect(db.alerts).toHaveLength(1);
      expect(db.alerts[0]).toMatchObject({ clear_reason: "now_on_file" });
    });

    it("is never raised again once a member has said the number is theirs", async () => {
      await scans(other, 2);
      await memoryStore(db, owner).dismissAlert(db.alerts[0]?.id ?? "");

      // The answers stop giving it for longer than the window, then give it again.
      await scans(none, 9);
      await scans(other, 3);
      expect(db.alerts).toHaveLength(1);
      expect(db.alerts[0]).toMatchObject({ cleared_at: null });
      expect(db.alerts[0]?.dismissed_at).not.toBeNull();
    });

    it("leads the report by the number", async () => {
      await scans(other, 1);
      const queued = await queueScan("scheduled");
      let report: ScanReport | undefined;
      await runScan(queued.id, {
        store: worker,
        providers: other,
        notify: async (given) => {
          report = given;
          return true;
        },
      });
      if (!report) throw new Error("no report");
      const email = buildScanReportEmail(report, "https://app.example");

      expect(email.subject).toBe(
        "Joe's Pizza: The answers give a different phone number: (919) 555-0199",
      );
      expect(email.text).toContain("The number on file is (919) 555-0100.");
    });
  });

  it("changes no alert when the scan fails", async () => {
    await scans(providers, 4);
    await scans(silent, 2);
    const queued = await queueScan();
    const broken: ProviderRegistry = {
      chatgpt: {
        surface: "chatgpt",
        observe: async () => {
          throw new Error("provider is down");
        },
      },
    };
    await expect(runScan(queued.id, { store: worker, providers: broken })).rejects.toThrow();
    expect(db.alerts).toEqual([]);
  });
});

describe("Google results", () => {
  /** DataForSEO and Mapbox, answering as their recorded responses do. Only the shape matters. */
  const task = (items: unknown[]) => ({
    status_code: 20000,
    tasks: [
      { status_code: 20000, status_message: "Ok.", result: [{ items_count: items.length, items }] },
    ],
  });
  const answer = (text: string, url: string) => ({
    type: "ai_overview",
    items: [{ type: "ai_overview_element", text, references: [{ url }] }],
    references: [],
  });
  const vendor = {
    organic: task([
      answer("Joe's Pizza is a favourite.", "https://joes.example/menu"),
      {
        type: "organic",
        rank_group: 1,
        domain: "yelp.example",
        url: "https://yelp.example/",
        website_name: "Yelp",
      },
      {
        type: "organic",
        rank_group: 2,
        domain: "joes.example",
        url: "https://joes.example/",
        website_name: "Joe's Pizza",
      },
    ]),
    local_finder: task([
      { type: "local_pack", rank_group: 1, title: "Joe's Pizza", url: "https://joes.example/" },
      { type: "local_pack", rank_group: 2, title: "Tony's Slice House", url: null },
    ]),
    ai_mode: task([answer("Try Tony's Slice House.", "https://tonys.example/")]),
  };
  const feature = (latitude: number, longitude: number) => ({
    features: [
      { properties: { coordinates: { latitude, longitude }, match_code: { confidence: "exact" } } },
    ],
  });

  let places: Record<string, unknown>;
  let failing: string | null;
  /** What a call answers in place of the vendor's usual response. */
  let answered: Partial<Record<keyof typeof vendor, unknown>>;
  const fetchStub = vi.fn<typeof fetch>(async (url) => {
    const asked = new URL(String(url));
    if (asked.hostname === "api.mapbox.com") {
      const type = asked.searchParams.get("types") ?? "";
      return Response.json(places[type] ?? { features: [] });
    }
    const endpoint = asked.pathname.split("/")[4] as keyof typeof vendor;
    if (endpoint === failing) return new Response("busy", { status: 503 });
    return Response.json(answered[endpoint] ?? vendor[endpoint]);
  });
  const sentTo = (host: string) =>
    fetchStub.mock.calls
      .map(([url]) => new URL(String(url)))
      .filter((url) => url.hostname === host);

  const google = () => ({
    ...providers,
    ...createDataForSeoProviders({
      login: "l",
      password: "p",
      tuning: defaultTuning,
      fetch: fetchStub,
    }),
  });
  const geocode = createMapboxGeocoder({ token: "pk.test", fetch: fetchStub });
  const scanned = async () => {
    const scan = await queueScan();
    const outcome = await runScan(scan.id, { store: worker, providers: google(), geocode });
    return {
      outcome,
      surfaces: (await worker.listScanResults(scan.id)).map((r) => r.surface).sort(),
    };
  };
  const location = () => {
    const found = db.locations[0];
    if (!found) throw new Error("no location");
    return found;
  };
  const withGoogle = (included = true) => {
    const organization = db.organizations[0];
    if (!organization) throw new Error("no organization");
    organization.surfaces = ["chatgpt"];
    organization.allowances = included ? { google_results: true } : {};
  };

  beforeEach(async () => {
    fetchStub.mockClear();
    failing = null;
    answered = {};
    places = { address: feature(35.7795897, -78.6381787), place: feature(35.7721, -78.6386) };
    await memoryStore(db, owner).createQuery(locationId, {
      kind: "search_keyword",
      text: "pizza near me",
    });
    Object.assign(location(), { address_line: "1 Main St", postal_code: "27601" });
  });

  it("checks a keyword on all four Google surfaces where the plan includes Google results", async () => {
    withGoogle();
    expect(await scanned()).toEqual({
      outcome: "succeeded",
      surfaces: [
        "chatgpt",
        "google_ai_mode",
        "google_ai_overview",
        "google_local_pack",
        "google_organic",
      ],
    });
    const found = (surface: string) => db.results.find((result) => result.surface === surface);
    expect(found("google_local_pack")).toMatchObject({ mentioned: true, position: 1 });
    expect(found("google_organic")).toMatchObject({ mentioned: true, position: 2 });
    expect(found("google_ai_overview")).toMatchObject({ mentioned: true });
    expect(found("google_ai_mode")).toMatchObject({ mentioned: false });

    // From the point its street address was found at, which is kept on the location.
    expect(location()).toMatchObject({
      latitude: 35.7795897,
      longitude: -78.6381787,
      point_source: "address",
      geocoded_from: "1 Main St, Raleigh, NC 27601, US",
    });
    const map = fetchStub.mock.calls.find(([url]) => String(url).includes("local_finder"));
    expect(JSON.parse(String(map?.[1]?.body))[0].location_coordinate).toBe(
      "35.7795897,-78.6381787,14z",
    );
    // What each call used, the lookup included, for the operator's costs.
    expect(db.usage.map((row) => [row.surface, row.model, row.searches])).toEqual(
      expect.arrayContaining([
        [null, "mapbox/geocode-permanent", 1],
        ["google_ai_mode", "dataforseo/ai-mode", 1],
        ["google_ai_overview", "dataforseo/ai-overview", 1],
        ["google_local_pack", "dataforseo/local-finder", 1],
        ["google_organic", "dataforseo/organic", 1],
      ]),
    );
  });

  /** Google showed no AI Overview, no map results and no AI Mode answer; organic as usual. */
  const nothingShown = () => {
    answered = {
      organic: task(
        (vendor.organic.tasks[0]?.result[0]?.items ?? []).filter(
          (item) => (item as { type: string }).type === "organic",
        ),
      ),
      local_finder: task([]),
      ai_mode: task([]),
    };
  };

  it("keeps a Google search that showed nothing as nothing shown, and scores without it", async () => {
    withGoogle();
    nothingShown();
    const scan = await queueScan();
    await runScan(scan.id, { store: worker, providers: google(), geocode });
    const found = (surface: string) => db.results.find((result) => result.surface === surface);
    expect(found("google_ai_overview")).toMatchObject({ shown: false, mentioned: false });
    expect(found("google_local_pack")).toMatchObject({ shown: false, mentioned: false });
    expect(found("google_ai_mode")).toMatchObject({ shown: false, mentioned: false });
    expect(found("google_organic")).toMatchObject({ shown: true, mentioned: true, position: 2 });
    // An assistant always answers, whoever it names.
    expect(found("chatgpt")).toMatchObject({ shown: true });
    // ChatGPT and the organic results both name the business second (0.8 each); the three
    // surfaces that showed nothing count neither way: (0.8 + 0.8) / 2.
    expect((await worker.getScan(scan.id))?.visibility_score).toBe(80);
  });

  /** The location as its page reads it, through the API. */
  const page = async () => {
    const app = createApp({
      authenticate: async () => ({
        user: { id: owner, email: "owner@example.com" },
        store: memoryStore(db, owner),
      }),
      publicStore: () => memoryStore(db, "nobody"),
    });
    const response = await app.request(`/api/locations/${locationId}`, {}, {
      PROVIDER_MODE: "live",
    } as Env);
    return LocationDetailSchema.parse(await response.json());
  };
  const cell = (detail: Awaited<ReturnType<typeof page>>, surface: string) =>
    detail.window.cells.find((candidate) => candidate.surface === surface);

  it("counts a rate over the checks that showed something, and keeps the ones that did not", async () => {
    withGoogle();
    await scanned();
    nothingShown();
    await scanned();
    const detail = await page();
    expect(cell(detail, "google_ai_overview")).toMatchObject({
      checks: 1,
      mentions: 1,
      not_shown: 1,
      history: ["named", "not_shown"],
    });
    expect(cell(detail, "google_organic")).toMatchObject({
      checks: 2,
      mentions: 2,
      not_shown: 0,
      history: ["named", "named"],
    });
    expect(cell(detail, "chatgpt")).toMatchObject({ history: ["named", "named"] });
    // ChatGPT twice, and the AI Overview and AI Mode once each: the second scan's showed nothing.
    expect(detail.window.answers).toBe(4);
  });

  const organicOnly = () =>
    (vendor.organic.tasks[0]?.result[0]?.items ?? []).filter(
      (item) => (item as { type: string }).type === "organic",
    );
  /** An AI Overview that names only a competitor. */
  const overviewMisses = () => {
    answered = {
      organic: task([
        answer("Try Tony's Slice House.", "https://tonys.example/"),
        ...organicOnly(),
      ]),
    };
  };
  const drops = async () =>
    (await worker.listAlerts(locationId, false))
      .filter((alert) => alert.kind === "drop")
      .map((alert) => (alert.kind === "drop" ? [alert.surface, alert.facts] : null));

  it("raises no drop when an overview that named the business stops being shown", async () => {
    withGoogle();
    for (let i = 0; i < 4; i++) await scanned();
    nothingShown();
    for (let i = 0; i < 3; i++) await scanned();
    expect(await drops()).toEqual([]);
  });

  it("raises a drop over the checks that showed something, looking past one that did not", async () => {
    withGoogle();
    for (let i = 0; i < 3; i++) await scanned();
    nothingShown();
    await scanned();
    overviewMisses();
    for (let i = 0; i < 3; i++) await scanned();
    expect(await drops()).toEqual([
      [
        "google_ai_overview",
        expect.objectContaining({ missed: 3, checks_before: 3, named_before: 3 }),
      ],
    ]);
  });

  it("recommends nothing for a Google column where nothing was shown", async () => {
    withGoogle();
    nothingShown();
    await scanned();
    const rules = (await worker.listRecommendations(locationId)).map((r) => r.rule);
    expect(rules).not.toContain("absent:google_ai_overview");
    expect(rules).not.toContain("absent:google_local_pack");
    expect(rules).not.toContain("absent:google_ai_mode");
  });

  /** A scheduled scan's report email. */
  const emailed = async () => {
    const scan = await queueScan("scheduled");
    let report: ScanReport | undefined;
    await runScan(scan.id, {
      store: worker,
      providers: google(),
      geocode,
      notify: async (sent) => {
        report = sent;
        return true;
      },
    });
    if (!report) throw new Error("no report");
    return buildScanReportEmail(report, "https://app.example/").text;
  };

  it("says in the report how many searches showed nothing", async () => {
    withGoogle();
    await scanned();
    nothingShown();
    const text = await emailed();
    expect(text).toContain("AI Overview: named in 1 of 1, not shown for 1 search");
    expect(text).toContain("Organic: named in 2 of 2\n");
  });

  it("says in the report when a search showed nothing in any scan", async () => {
    withGoogle();
    nothingShown();
    await scanned();
    const text = await emailed();
    expect(text).toContain("AI Overview: not shown for any of 2 searches");
  });

  it("keeps empty organic results as nothing shown, and an assistant naming nobody as not named", async () => {
    withGoogle();
    answered = { organic: task([]) };
    const scan = await queueScan();
    await runScan(scan.id, {
      store: worker,
      providers: {
        ...google(),
        chatgpt: {
          surface: "chatgpt",
          observe: async () => ({ kind: "answer", text: "", businesses: [], cited_urls: [] }),
        },
      },
      geocode,
    });
    const found = (surface: string) => db.results.find((result) => result.surface === surface);
    expect(found("google_organic")).toMatchObject({ shown: false, mentioned: false });
    expect(found("chatgpt")).toMatchObject({ shown: true, mentioned: false });
  });

  it("gives no score when Google showed nothing for any of the searches", async () => {
    withGoogle();
    const organization = db.organizations[0];
    if (organization) organization.surfaces = [];
    nothingShown();
    answered.organic = task([]);
    const scan = await queueScan();
    expect(await runScan(scan.id, { store: worker, providers: google(), geocode })).toBe(
      "succeeded",
    );
    expect((await worker.getScan(scan.id))?.visibility_score).toBeNull();
  });

  it("checks no Google surface, and looks nothing up, where the plan does not include it", async () => {
    withGoogle(false);
    expect(await scanned()).toEqual({ outcome: "succeeded", surfaces: ["chatgpt"] });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(location().geocoded_from).toBeNull();
  });

  it("finds the point once, and again only after the address changes", async () => {
    withGoogle();
    await scanned();
    await scanned();
    expect(sentTo("api.mapbox.com")).toHaveLength(1);

    const { id, organization_id, paused_by_plan, last_scanned_at, created_at, ...held } =
      location();
    await memoryStore(db, owner).updateLocation(id, { ...held, address_line: "9 Oak Ave" });
    places.address = feature(35.8, -78.7);
    await scanned();
    expect(sentTo("api.mapbox.com").map((url) => url.searchParams.get("q"))).toEqual([
      "1 Main St, Raleigh, NC 27601, US",
      "9 Oak Ave, Raleigh, NC 27601, US",
    ]);
    expect(location()).toMatchObject({ latitude: 35.8, longitude: -78.7, point_source: "address" });
  });

  it("checks from the middle of the city when there is no street address", async () => {
    withGoogle();
    Object.assign(location(), { address_line: null });
    expect((await scanned()).surfaces).toContain("google_local_pack");
    expect(sentTo("api.mapbox.com")[0]?.searchParams.get("types")).toBe("place");
    expect(location()).toMatchObject({
      latitude: 35.7721,
      point_source: "city",
      geocoded_from: "Raleigh, NC, US",
    });
  });

  it("checks from the middle of the city when the street address cannot be found", async () => {
    withGoogle();
    places.address = { features: [] };
    await scanned();
    expect(location()).toMatchObject({
      latitude: 35.7721,
      point_source: "city",
      // The address that was looked for, so it is not looked for again until it changes.
      geocoded_from: "1 Main St, Raleigh, NC 27601, US",
    });
  });

  it("leaves Google out of a scan when the location cannot be placed, and looks again next time", async () => {
    withGoogle();
    places = {};
    expect(await scanned()).toEqual({ outcome: "succeeded", surfaces: ["chatgpt"] });
    expect(sentTo("api.dataforseo.com")).toEqual([]);
    expect(location()).toMatchObject({ latitude: null, point_source: null });

    places = { place: feature(35.7721, -78.6386) };
    expect((await scanned()).surfaces).toContain("google_local_pack");
    expect(location()).toMatchObject({ latitude: 35.7721, point_source: "city" });
  });

  it("says why, without retrying, when Google is all there is and the location cannot be placed", async () => {
    withGoogle();
    places = {};
    db.queries = db.queries.filter((query) => query.kind === "search_keyword");
    const scan = await queueScan();
    expect(await runScan(scan.id, { store: worker, providers: google(), geocode })).toBe("failed");
    expect((await worker.getScan(scan.id))?.error).toBe(
      "Google was not checked: the location's address could not be found on the map. Check its city and street address.",
    );
  });

  it("checks Google only where the allowances include it, whatever the surfaces say", async () => {
    withGoogle(false);
    const organization = db.organizations[0];
    if (!organization) throw new Error("no organization");
    organization.surfaces = null;
    expect((await scanned()).surfaces).toEqual(["chatgpt", "gemini"]);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("fails the whole scan when a Google call fails, for the queue to try again", async () => {
    withGoogle();
    failing = "local_finder";
    const scan = await queueScan();
    await expect(runScan(scan.id, { store: worker, providers: google(), geocode })).rejects.toThrow(
      "DataForSEO the map results failed (HTTP 503).",
    );
    expect((await worker.getScan(scan.id))?.status).toBe("failed");
    expect(db.results).toEqual([]);
  });
});
