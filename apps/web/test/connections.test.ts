import type { Connection, OrganizationConnections } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import {
  awaitingWorker,
  choicesFor,
  connectionsQuery,
  hasConnectionsPage,
  splitConnections,
} from "../src/lib/connections";

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
  last_synced_at: "2026-10-12T09:00:05.000Z",
  choices: [],
  matches: [],
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

describe("awaitingWorker", () => {
  it("is true while a removal or the first sync is still to come, and the page keeps asking", () => {
    const fresh = { ...connection("working"), last_synced_at: null };
    expect(awaitingWorker(fresh)).toBe(true);
    expect(awaitingWorker(connection("removing"))).toBe(true);
    expect(awaitingWorker(connection("working"))).toBe(false);
    // One that is gone is waiting for nothing, synced or not.
    expect(awaitingWorker({ ...connection("removed"), last_synced_at: null })).toBe(false);
    expect(
      connectionsQuery("0a000000-0000-4000-8000-000000000001").refetchInterval({
        state: { data: found({ connections: [fresh] }) },
      }),
    ).toBe(2000);
  });
});

describe("choicesFor", () => {
  const main = "10000000-0000-4000-8000-000000000001";
  const uptown = "10000000-0000-4000-8000-000000000002";
  const account = {
    ...connection("working"),
    choices: [
      { id: "a", label: "Main Street" },
      { id: "b", label: "Riverside" },
      { id: "c", label: "Uptown" },
    ],
    matches: [
      {
        location_id: main,
        external_id: "a",
        external_label: "Main Street",
        matched_at: "2026-10-12T09:01:00.000Z",
      },
    ],
  };

  it("offers a location everything that is not another location's, its own choice included", () => {
    expect(choicesFor(account, main).map((choice) => choice.id)).toEqual(["a", "b", "c"]);
    expect(choicesFor(account, uptown).map((choice) => choice.id)).toEqual(["b", "c"]);
  });

  it("keeps a location's own choice in view when the last sync no longer found it", () => {
    const gone = { ...account, choices: account.choices.filter((choice) => choice.id !== "a") };
    expect(choicesFor(gone, main)).toEqual([
      { id: "b", label: "Riverside" },
      { id: "c", label: "Uptown" },
      { id: "a", label: "Main Street (no longer found)" },
    ]);
    // It is still that location's, so no other is offered it.
    expect(choicesFor(gone, uptown).map((choice) => choice.id)).toEqual(["b", "c"]);
  });
});
