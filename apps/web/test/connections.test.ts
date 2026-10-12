import type { Connection, OrganizationConnections } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import { connectionsQuery, hasConnectionsPage, splitConnections } from "../src/lib/connections";

const connection = (status: Connection["status"], id = status): Connection => ({
  id: `c0000000-0000-4000-8000-0000000000${String(id.length).padStart(2, "0")}`,
  organization_id: "0a000000-0000-4000-8000-000000000001",
  kind: "sample",
  label: "Sample account",
  status,
  connected_by_email: "owner@example.com",
  connected_at: "2026-10-12T09:00:00.000Z",
  removed_by_email: null,
  removal_requested_at: null,
  removed_at: null,
});

const found = (extra: Partial<OrganizationConnections> = {}): OrganizationConnections => ({
  available: [],
  can_manage: true,
  connections: [],
  ...extra,
});

describe("splitConnections", () => {
  it("keeps one being removed among the current ones until the worker has finished", () => {
    const all = [connection("working"), connection("removing"), connection("removed")];
    expect(splitConnections(all)).toEqual({
      current: [all[0], all[1]],
      removed: [all[2]],
    });
    expect(splitConnections([])).toEqual({ current: [], removed: [] });
  });
});

describe("hasConnectionsPage", () => {
  it("is false until it is known, and while there is nothing connected or to connect", () => {
    expect(hasConnectionsPage(undefined)).toBe(false);
    expect(hasConnectionsPage(found())).toBe(false);
  });

  it("is true once something can be connected, is, or was", () => {
    expect(hasConnectionsPage(found({ available: ["sample"] }))).toBe(true);
    expect(hasConnectionsPage(found({ connections: [connection("working")] }))).toBe(true);
    expect(hasConnectionsPage(found({ connections: [connection("removed")] }))).toBe(true);
  });
});

describe("connectionsQuery", () => {
  const interval = (connections: Connection[]) =>
    connectionsQuery("0a000000-0000-4000-8000-000000000001").refetchInterval({
      state: { data: found({ connections }) },
    });

  it("asks again while a removal is waiting for the worker, and not otherwise", () => {
    expect(interval([connection("working")])).toBe(false);
    expect(interval([connection("removed")])).toBe(false);
    expect(interval([connection("working"), connection("removing")])).toBe(2000);
    expect(
      connectionsQuery("0a000000-0000-4000-8000-000000000001").refetchInterval({ state: {} }),
    ).toBe(false);
  });
});
