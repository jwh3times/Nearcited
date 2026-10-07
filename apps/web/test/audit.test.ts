import type { AuditCell, PublicAudit } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import {
  AUDIT_WAIT_MS,
  auditAnswers,
  auditCompetitors,
  auditPending,
  auditSurfaces,
} from "../src/lib/audit";

const cell = (surface: AuditCell["surface"], competitors: [string, number][] = []): AuditCell => ({
  surface,
  checks: 5,
  mentions: 1,
  positions: [2],
  weight: 0.8,
  competitors: competitors.map(([name, count]) => ({ name, count })),
  excerpt: null,
  cited_urls: [],
  sources: [],
});

const audit = (change: Partial<PublicAudit> = {}): PublicAudit => ({
  business_name: "Joe's Pizza",
  website: null,
  city: "Raleigh",
  region: "NC",
  status: "queued",
  samples: 5,
  score: 8,
  prompts: [
    {
      text: "best pizza",
      cells: [
        cell("claude", [["Tony's", 4]]),
        cell("chatgpt", [
          ["Tony's", 5],
          ["Zed", 1],
        ]),
      ],
    },
    { text: "late night food", cells: null },
    { text: "pizza delivery", cells: [cell("chatgpt", [["Alpha", 1]])] },
  ],
  sources: [],
  site: null,
  created_at: "2026-10-07T12:00:00.000Z",
  expires_at: "2026-11-06T12:00:00.000Z",
  ...change,
});

describe("auditSurfaces", () => {
  it("lists the assistants that answered, in the product's order", () => {
    expect(auditSurfaces(audit())).toEqual(["chatgpt", "claude"]);
    expect(auditSurfaces(audit({ prompts: [{ text: "x", cells: null }] }))).toEqual([]);
  });
});

describe("auditAnswers", () => {
  it("counts every answer behind the report so far", () => {
    expect(auditAnswers(audit())).toBe(15);
  });
});

describe("auditCompetitors", () => {
  it("adds up who else was named across prompts and assistants", () => {
    expect(auditCompetitors(audit())).toEqual([
      { name: "Tony's", count: 9 },
      { name: "Alpha", count: 1 },
      { name: "Zed", count: 1 },
    ]);
    expect(auditCompetitors(audit(), 1)).toEqual([{ name: "Tony's", count: 9 }]);
  });

  it("counts two spellings of one business together, under the shorter name", () => {
    const prompts = [
      {
        text: "best pizza",
        cells: [
          cell("chatgpt", [
            ["Tony's, LLC", 3],
            ["Zed", 4],
          ]),
          cell("claude", [["Tony's", 2]]),
        ],
      },
    ];
    expect(auditCompetitors(audit({ prompts }))).toEqual([
      { name: "Tony's", count: 5 },
      { name: "Zed", count: 4 },
    ]);
  });
});

describe("auditPending", () => {
  const created = new Date("2026-10-07T12:00:00.000Z").getTime();

  it("waits for an unfinished report, but not for ever", () => {
    expect(auditPending(audit(), new Date(created + 60_000))).toBe(true);
    expect(auditPending(audit(), new Date(created + AUDIT_WAIT_MS))).toBe(false);
  });

  it("does not wait for one that is finished or has failed", () => {
    expect(auditPending(audit({ status: "ready" }), new Date(created))).toBe(false);
    expect(auditPending(audit({ status: "failed" }), new Date(created))).toBe(false);
  });
});
