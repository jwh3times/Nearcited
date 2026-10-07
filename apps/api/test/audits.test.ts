import { type Observation, PublicAuditSchema } from "@nearcited/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { runAuditPart } from "../src/audits/runner";
import type { Env } from "../src/env";
import type { ProviderRegistry } from "../src/providers";
import type { Store } from "../src/store/types";
import { createMemoryDb, type MemoryAudit, type MemoryDb, memoryStore } from "./memory-store";

const auditId = "c0000000-0000-4000-8000-000000000003";
const token = "ab".repeat(32);

let db: MemoryDb;
let worker: Store;

function addAudit(change: Partial<MemoryAudit> = {}): MemoryAudit {
  const audit: MemoryAudit = {
    id: auditId,
    token,
    business_name: "Joe's Pizza",
    website: "https://joes.example",
    city: "Raleigh",
    region: "NC",
    country_code: "US",
    prompts: ["best pizza", "late night food"],
    samples: 3,
    status: "queued",
    parts: {},
    error: null,
    revoked_at: null,
    created_at: "2026-10-07T00:00:00.000Z",
    expires_at: "2999-01-01T00:00:00.000Z",
    ...change,
  };
  db.audits.push(audit);
  return audit;
}

const answer = (...businesses: string[]): Observation => ({
  kind: "answer",
  text: `Try ${businesses.join(" or ")}.`,
  businesses,
  cited_urls: ["https://example.com/best-pizza"],
});

/** ChatGPT names the business second, two times in three. Claude never does. */
function providers() {
  let asked = 0;
  const chatgpt = vi.fn(async () =>
    asked++ % 3 === 2 ? answer("Tony's Slice House") : answer("Tony's Slice House", "Joe's Pizza"),
  );
  const claude = vi.fn(async () => answer("Tony's Slice House"));
  const registry: ProviderRegistry = {
    chatgpt: { surface: "chatgpt", observe: chatgpt },
    claude: { surface: "claude", observe: claude },
    // Not an assistant, so an audit must leave it alone.
    google_local_pack: {
      surface: "google_local_pack",
      observe: async () => {
        throw new Error("an audit asked the map");
      },
    },
  };
  return { registry, chatgpt, claude };
}

beforeEach(() => {
  db = createMemoryDb();
  worker = memoryStore(db, null);
});

describe("runAuditPart", () => {
  it("asks one prompt on every assistant, as many times as the audit says", async () => {
    const audit = addAudit();
    const { registry, chatgpt, claude } = providers();

    expect(
      await runAuditPart(auditId, 0, { store: worker, providers: registry, sampleData: false }),
    ).toBe("done");

    expect(chatgpt).toHaveBeenCalledTimes(3);
    expect(claude).toHaveBeenCalledTimes(3);
    const cells = audit.parts["0"]?.cells ?? [];
    expect(cells.map((cell) => [cell.surface, cell.checks, cell.mentions])).toEqual([
      ["chatgpt", 3, 2],
      ["claude", 3, 0],
    ]);
    expect(cells[0]).toMatchObject({
      positions: [2, 2],
      competitors: [{ name: "Tony's Slice House", count: 3 }],
      cited_urls: ["https://example.com/best-pizza"],
    });
    expect(cells[0]?.excerpt).toContain("Joe's Pizza");
  });

  it("asks about the audit's business in the audit's city", async () => {
    addAudit();
    const { registry, chatgpt } = providers();
    await runAuditPart(auditId, 1, { store: worker, providers: registry, sampleData: false });

    expect(chatgpt.mock.calls[0]).toMatchObject([
      {
        location: { name: "Joe's Pizza", city: "Raleigh", region: "NC", country_code: "US" },
        query: { kind: "ai_prompt", text: "late night food" },
      },
    ]);
  });

  it("is ready only once every prompt has reported", async () => {
    const audit = addAudit();
    const deps = { store: worker, providers: providers().registry, sampleData: false };

    await runAuditPart(auditId, 1, deps);
    expect(audit.status).toBe("queued");
    await runAuditPart(auditId, 0, deps);
    expect(audit.status).toBe("ready");
  });

  it("never builds a report from sample data", async () => {
    const audit = addAudit();
    const { registry, chatgpt } = providers();

    expect(
      await runAuditPart(auditId, 0, { store: worker, providers: registry, sampleData: true }),
    ).toBe("failed");
    expect(chatgpt).not.toHaveBeenCalled();
    expect(audit).toMatchObject({ status: "failed", parts: {} });
  });

  it("fails, without asking anything, when the build cannot run live checks", async () => {
    const audit = addAudit();
    const { registry, chatgpt } = providers();

    expect(
      await runAuditPart(auditId, 0, {
        store: worker,
        providers: registry,
        sampleData: false,
        unavailable: "This build has no tuning.",
      }),
    ).toBe("failed");
    expect(chatgpt).not.toHaveBeenCalled();
    expect(audit).toMatchObject({ status: "failed", error: "This build has no tuning." });
  });

  it("fails when no assistant is set up", async () => {
    const audit = addAudit();
    expect(
      await runAuditPart(auditId, 0, { store: worker, providers: {}, sampleData: false }),
    ).toBe("failed");
    expect(audit.status).toBe("failed");
  });

  it("skips an audit that is gone or revoked, and a prompt it does not have", async () => {
    const { registry, chatgpt } = providers();
    const deps = { store: worker, providers: registry, sampleData: false };
    expect(await runAuditPart(auditId, 0, deps)).toBe("skipped");

    const audit = addAudit();
    expect(await runAuditPart(auditId, 2, deps)).toBe("skipped");
    audit.revoked_at = "2026-10-07T01:00:00.000Z";
    expect(await runAuditPart(auditId, 0, deps)).toBe("skipped");
    expect(chatgpt).not.toHaveBeenCalled();
  });

  it("records a provider error, rethrows for the queue, and recovers on redelivery", async () => {
    const audit = addAudit({ prompts: ["best pizza"] });
    const { registry, claude } = providers();
    claude.mockRejectedValueOnce(new Error("upstream 503"));
    const deps = { store: worker, providers: registry, sampleData: false };

    await expect(runAuditPart(auditId, 0, deps)).rejects.toThrow("upstream 503");
    expect(audit).toMatchObject({ status: "failed", error: "upstream 503", parts: {} });

    expect(await runAuditPart(auditId, 0, deps)).toBe("done");
    expect(audit).toMatchObject({ status: "ready", error: null });
  });
});

describe("GET /api/audits/:token", () => {
  const app = createApp({
    authenticate: async () => null,
    publicStore: () => memoryStore(db, "nobody"),
  });
  const get = (value: string) => app.request(`/api/audits/${value}`, {}, {} as Env);

  it("serves the report to anyone holding the link, with nothing but what the page shows", async () => {
    addAudit({ prompts: ["best pizza"] });
    await runAuditPart(auditId, 0, {
      store: worker,
      providers: providers().registry,
      sampleData: false,
    });

    const response = await get(token);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const body = await response.json();
    const audit = PublicAuditSchema.parse(body);
    expect(audit).toMatchObject({ business_name: "Joe's Pizza", status: "ready", samples: 3 });
    // ChatGPT named it second twice in three; Claude never did.
    expect(audit.score).toBeGreaterThan(0);
    expect(audit.prompts[0]?.cells).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain(auditId);
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it("shows a report that is still being put together", async () => {
    addAudit();
    const audit = PublicAuditSchema.parse(await (await get(token)).json());
    expect(audit).toMatchObject({ status: "queued", score: null });
    expect(audit.prompts.map((prompt) => prompt.cells)).toEqual([null, null]);
  });

  it("answers 404 for an unknown, revoked or expired link, and for anything that is not a token", async () => {
    expect((await get(token)).status).toBe(404);

    const audit = addAudit();
    expect((await get(token)).status).toBe(200);
    expect((await get("cd".repeat(32))).status).toBe(404);
    expect((await get(auditId)).status).toBe(404);

    audit.revoked_at = "2026-10-07T01:00:00.000Z";
    expect((await get(token)).status).toBe(404);
    audit.revoked_at = null;
    audit.expires_at = "2026-01-01T00:00:00.000Z";
    expect((await get(token)).status).toBe(404);
  });

  it("does not let a signed-in user reach the worker's side of an audit", async () => {
    addAudit();
    const user = memoryStore(db, "nobody");
    await expect(user.getAudit(auditId)).rejects.toMatchObject({ kind: "forbidden" });
    await expect(user.recordAuditPart(auditId, 0, { cells: [] })).rejects.toMatchObject({
      kind: "forbidden",
    });
    await expect(user.failAudit(auditId, "x")).rejects.toMatchObject({ kind: "forbidden" });
  });
});
