import { type Observation, type ScanMessage, SURFACES } from "@nearcited/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScanReportEmail, emailMessage } from "../src/email/report";
import { liveScansUnavailable, type ProviderRegistry } from "../src/providers";
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
