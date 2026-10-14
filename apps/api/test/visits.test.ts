import {
  LocationSchema,
  MOST_PAGES_A_DAY,
  MOST_VISITS_A_DAY,
  OrganizationSchema,
  VISITS_ALLOWANCE,
} from "@nearcited/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";

const SITE = "https://www.joespizza.example";
const NOBODYS = "0".repeat(32);

let db: MemoryDb;
let env: Env;
let locationId: string;
let key: string;

/** In these tests the bearer token is simply the user's ID. */
const app = createApp({
  authenticate: async (request) => {
    const userId = request.headers.get("Authorization")?.replace("Bearer ", "");
    return userId
      ? { user: { id: userId, email: `${userId}@example.com` }, store: memoryStore(db, userId) }
      : null;
  },
  publicStore: () => memoryStore(db, "nobody"),
});

function call(user: string, method: string, path: string, body?: unknown) {
  return app.request(
    `/api${path}`,
    {
      method,
      headers: { Authorization: `Bearer ${user}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

/** What the line on a site does: posts text, from the site, with no sign-in. */
function report(body: unknown, origin: string | null = SITE, headers: Record<string, string> = {}) {
  return app.request(
    "/api/visits",
    {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=UTF-8",
        ...(origin === null ? {} : { Origin: origin }),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
  );
}

const fromChatGpt = (path = "/menu") => ({ key, referrer: "chatgpt.com", tag: null, path });
const counted = () =>
  db.visits
    .map(({ assistant, path, count }) => ({ assistant, path, count }))
    .sort((a, b) => `${a.assistant}${a.path}`.localeCompare(`${b.assistant}${b.path}`));

beforeEach(async () => {
  db = createMemoryDb();
  db.now = "2026-10-13T15:00:00.000Z";
  env = {} as Env;
  const organization = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  const kept = db.organizations.find(({ id }) => id === organization.id);
  if (kept) kept.allowances = { [VISITS_ALLOWANCE]: true };
  const location = LocationSchema.parse(
    await (
      await call(alice, "POST", `/organizations/${organization.id}/locations`, {
        name: "Joe's Pizza",
        city: "Raleigh",
        region: "NC",
        website: "joespizza.example",
      })
    ).json(),
  );
  locationId = location.id;
  key = db.visitLines.get(location.id)?.key ?? "";
});

describe("POST /api/visits", () => {
  it("counts a visit from an assistant, for a caller who is not signed in", async () => {
    const response = await report(fromChatGpt());
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    await report(fromChatGpt());
    await report({ key, referrer: "www.perplexity.ai", tag: null, path: "/" });
    // A visit out of ChatGPT's app names no site and carries its tag.
    await report({ key, referrer: null, tag: "chatgpt.com", path: "/" });

    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(counted()).toEqual([
      { assistant: "chatgpt", path: "/", count: 1 },
      { assistant: "chatgpt", path: "/menu", count: 2 },
      { assistant: "perplexity", path: "/", count: 1 },
    ]);
    // Counted for the day it arrived, which is the server's to say.
    expect(db.visits.every((visit) => visit.day === "2026-10-13")).toBe(true);
    expect(db.visits.every((visit) => visit.location_id === locationId)).toBe(true);
  });

  it("works out the assistant from what the visit carried, and takes nobody's word for it", async () => {
    // A search, with the assistant claimed in the body.
    await report({ key, referrer: "google.com", tag: null, path: "/", assistant: "claude" });
    expect(counted()).toEqual([]);
    // A visit from ChatGPT that says it is from Claude.
    await report({ ...fromChatGpt("/"), assistant: "claude" });
    expect(counted()).toEqual([{ assistant: "chatgpt", path: "/", count: 1 }]);
    // A tagged link posted somewhere else arrives from somewhere else.
    await report({ key, referrer: "facebook.com", tag: "chatgpt.com", path: "/" });
    expect(counted()).toEqual([{ assistant: "chatgpt", path: "/", count: 1 }]);
  });

  it("counts only for a page on the location's own site, as the browser names it", async () => {
    for (const origin of [
      "https://elsewhere.example",
      "https://joespizza.example.elsewhere.example",
      "null",
      "",
      null,
    ]) {
      await report(fromChatGpt(), origin);
      // Naming the site in what is sent changes nothing.
      await report({ ...fromChatGpt(), host: "joespizza.example", origin: SITE }, origin);
    }
    expect(counted()).toEqual([]);

    for (const origin of [
      "https://joespizza.example",
      "http://WWW.JOESPIZZA.EXAMPLE:8080",
      "https://order.joespizza.example",
    ]) {
      await report(fromChatGpt(), origin);
    }
    expect(counted()).toEqual([{ assistant: "chatgpt", path: "/menu", count: 3 }]);
  });

  it("answers the same whatever became of the visit", async () => {
    for (const [body, origin] of [
      [fromChatGpt(), SITE],
      [{ ...fromChatGpt(), key: NOBODYS }, SITE],
      [{ ...fromChatGpt(), key: "not-a-key" }, SITE],
      [{ key, referrer: "google.com", tag: null, path: "/" }, SITE],
      [{ ...fromChatGpt(), path: "menu" }, SITE],
      [fromChatGpt(), "https://elsewhere.example"],
      [fromChatGpt(), null],
      [{ key }, SITE],
      ["not json", SITE],
      ["", SITE],
      ["null", SITE],
    ] as const) {
      const response = await report(body, origin);
      expect(response.status, JSON.stringify(body)).toBe(204);
      expect(await response.text()).toBe("");
    }
    // Only the first of those was a visit to count.
    expect(counted()).toEqual([{ assistant: "chatgpt", path: "/menu", count: 1 }]);
  });

  it("does not read more than a line would ever send", async () => {
    const long = { ...fromChatGpt(), padding: "x".repeat(5000) };
    expect((await report(long)).status).toBe(204);
    // Whatever the request says of its own length.
    expect((await report(fromChatGpt(), SITE, { "Content-Length": "999999" })).status).toBe(204);
    expect(counted()).toEqual([]);
  });

  it("keeps a page as a path, without what follows a question mark", async () => {
    await report(fromChatGpt("/menu?email=someone@example.com"));
    await report(fromChatGpt("/menu#order"));
    expect(counted()).toEqual([{ assistant: "chatgpt", path: "/menu", count: 2 }]);
  });

  it("counts nothing on a plan that leaves visits out, or for a location it does not cover", async () => {
    const organization = db.organizations[0];
    const location = db.locations[0];
    if (!organization || !location) throw new Error("The scene has no organization.");

    organization.allowances = {};
    await report(fromChatGpt());
    await report({ key, check: true });
    organization.allowances = { [VISITS_ALLOWANCE]: true };
    location.paused_by_plan = true;
    await report(fromChatGpt());
    expect(counted()).toEqual([]);
    expect(db.visitLines.get(locationId)?.checked_on).toBeNull();

    location.paused_by_plan = false;
    location.website = null;
    await report(fromChatGpt());
    expect(counted()).toEqual([]);
  });

  it("counts a day's visits under a bounded number of pages, and stops at the day's ceiling", async () => {
    for (let page = 1; page <= MOST_PAGES_A_DAY + 2; page += 1) {
      await report(fromChatGpt(`/page-${page}`));
    }
    await report(fromChatGpt("/page-1"));
    const pages = db.visits.filter((visit) => visit.path !== "");
    expect(pages).toHaveLength(MOST_PAGES_A_DAY);
    expect(db.visits.find((visit) => visit.path === "")?.count).toBe(2);
    expect(db.visits.find((visit) => visit.path === "/page-1")?.count).toBe(2);

    const first = db.visits.find((visit) => visit.path === "/page-1");
    if (first) first.count += MOST_VISITS_A_DAY - (MOST_PAGES_A_DAY + 3) - 1;
    const total = () => db.visits.reduce((sum, visit) => sum + visit.count, 0);
    expect(total()).toBe(MOST_VISITS_A_DAY - 1);
    await report(fromChatGpt("/page-1"));
    await report(fromChatGpt("/page-1"));
    await report({ key, referrer: "claude.ai", tag: null, path: "/" });
    expect(total()).toBe(MOST_VISITS_A_DAY);

    // The next day starts again.
    db.now = "2026-10-14T00:00:01.000Z";
    await report(fromChatGpt("/page-1"));
    expect(db.visits.filter((visit) => visit.day === "2026-10-14")).toEqual([
      {
        location_id: locationId,
        day: "2026-10-14",
        assistant: "chatgpt",
        path: "/page-1",
        count: 1,
      },
    ]);
  });

  it("notes a check that the line is there, and counts nothing for it", async () => {
    // From somewhere else, and for nobody's key: nothing.
    await report({ key, check: true }, "https://elsewhere.example");
    await report({ key: NOBODYS, check: true });
    expect(db.visitLines.get(locationId)?.checked_on).toBeNull();

    // A check is a check even when it arrived from an assistant.
    expect((await report({ key, check: true, referrer: "chatgpt.com", path: "/" })).status).toBe(
      204,
    );
    expect(db.visitLines.get(locationId)?.checked_on).toBe("2026-10-13");
    expect(counted()).toEqual([]);
  });

  it("is not a way to read anything", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await app.request("/api/visits", { method, headers: { Origin: SITE } }, env);
      // Past the public routes everything asks for a sign-in.
      expect(response.status, method).toBe(401);
    }
  });
});

describe("a location's line", () => {
  it("is made with the location and goes with it", async () => {
    expect(db.visitLines.size).toBe(1);
    await report(fromChatGpt());
    expect(db.visits).toHaveLength(1);

    expect((await call(alice, "DELETE", `/locations/${locationId}`)).status).toBeLessThan(300);
    expect(db.visitLines.size).toBe(0);
    expect(db.visits).toEqual([]);
    // The line left on the site reports to nobody now.
    await report(fromChatGpt());
    expect(db.visits).toEqual([]);
  });
});
