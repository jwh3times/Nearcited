import { type Observation, type ScanMessage, SURFACES } from "@nearcited/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScanReportEmail } from "../src/email/report";
import type { ProviderRegistry } from "../src/providers";
import { createMockProviders } from "../src/providers/mock";
import { runScan, type ScanReport } from "../src/scans/runner";
import { enqueueDueScans } from "../src/scans/schedule";
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
    scan_frequency: "weekly",
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
    const notify = vi.fn<(report: ScanReport) => Promise<void>>(async () => {});

    const manual = await queueScan("manual");
    await runScan(manual.id, { store: worker, providers, notify });
    expect(notify).not.toHaveBeenCalled();

    const scheduled = await queueScan("scheduled");
    await runScan(scheduled.id, { store: worker, providers, notify });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ score: 40 });
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

describe("buildScanReportEmail", () => {
  it("summarises the scan and links to the location", async () => {
    const scan = await queueScan("scheduled");
    let report: ScanReport | undefined;
    await runScan(scan.id, {
      store: worker,
      providers,
      notify: async (sent) => {
        report = sent;
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
