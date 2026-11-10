import {
  LocationActionsSchema,
  LocationFoundAnswersSchema,
  LocationSchema,
  OrganizationSchema,
  REVIEW_FORM_SHOWN,
  ReviewRequestSettingsSchema,
} from "@nearcited/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { carryOutAction } from "../src/actions";
import { type Asking, askingKeys, proposeReviewRequests } from "../src/actions/review-requests";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { readFoundMessage, recordFound } from "../src/found";
import { receiveEmail } from "../src/receipts";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

/**
 * "How did you find us?" on the way from a review request to the review form (issue #148,
 * `docs/adr/0033-a-found-answer-is-counted-on-the-way-to-the-review-form.md`). The link in a
 * request is the product's: the page it opens asks the question, every tap lands on the review form
 * the email named, and the worker counts the first answer for the location by month. The route is
 * not signed in and reads nothing: it checks the link's signature and queues the worker.
 */

const alice = "a0000000-0000-4000-8000-000000000001";
const carol = "c0000000-0000-4000-8000-000000000003";

const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const FORM = "https://g.page/r/example/review";

let db: MemoryDb;
let env: Env;
let queued: unknown[];
let sent: { to: string; text: string; unsubscribe: string }[];
let sampleData: boolean;

const app = createApp({
  authenticate: async (request) => {
    const userId = request.headers.get("Authorization")?.replace("Bearer ", "");
    return userId
      ? { user: { id: userId, email: `${userId}@example.com` }, store: memoryStore(db, userId) }
      : null;
  },
  publicStore: () => memoryStore(db, "nobody"),
  // The question's route may use no store: a call to the worker's fails the test.
  workerStore: () => {
    throw new Error("The worker's store was used on a request");
  },
});

function call(user: string, method: string, path: string, body?: unknown) {
  return app.request(
    `/api${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${user}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

const worker = () => memoryStore(db, null);

async function asking(): Promise<Asking> {
  const keys = await askingKeys(SECRET);
  if (!keys) throw new Error("No keys");
  return {
    keys,
    appUrl: "https://nearcited.example",
    sampleData,
    send: async (message) => {
      sent.push(message);
    },
  };
}

/** An organization of `owner`'s with one location asking for reviews on Google. */
async function shop(owner: string, name: string, locationName: string) {
  const organization = OrganizationSchema.parse(
    await (await call(owner, "POST", "/organizations", { name })).json(),
  );
  db.emails.set(owner, `${owner}@example.com`);
  const kept = db.organizations.find((candidate) => candidate.id === organization.id);
  if (kept) {
    Object.assign(kept, {
      max_locations: 5,
      allowances: { ...kept.allowances, review_requests: 100 },
    });
  }
  const made = LocationSchema.parse(
    await (
      await call(owner, "POST", `/organizations/${organization.id}/locations`, {
        name: locationName,
        website: "https://www.example.com",
        city: "Raleigh",
        region: "NC",
        primary_category: "Pizza restaurant",
        time_zone: "America/New_York",
      })
    ).json(),
  );
  await call(owner, "PUT", `/locations/${made.id}/listings/google.com`, { url: FORM });
  const settings = ReviewRequestSettingsSchema.parse(
    await (
      await call(owner, "POST", `/locations/${made.id}/review-requests`, {
        site: "google.com",
        reply_to: `${owner}@example.com`,
        confirmed: true,
      })
    ).json(),
  );
  return { organization, id: made.id, receiptAddress: settings.receipt_address };
}

/** Square's receipt to `customer`, copied to the location, with Square confirmed. */
async function receipt(
  owner: string,
  at: { id: string; receiptAddress: string },
  customer: string,
) {
  await receiveEmail(
    {
      to: at.receiptAddress,
      from: "bounces@squareup.com",
      headers: new Headers({
        "Authentication-Results": "mx.cloudflare.net; spf=pass; dkim=pass header.d=squareup.com",
        From: "Receipts <receipts@squareup.com>",
        To: customer,
        Date: new Date("2026-11-03T21:45:00-05:00").toUTCString(),
      }),
    },
    { store: worker(), sampleData: false, now: new Date("2026-11-04T03:30:00.000Z") },
  );
  const read = await (await call(owner, "GET", `/locations/${at.id}/receipts`)).json();
  for (const sender of (read as { senders: { id: string; status: string }[] }).senders) {
    if (sender.status === "waiting")
      await call(owner, "POST", `/receipt-senders/${sender.id}/confirm`);
  }
}

const waitingAt = async (owner: string, locationId: string) =>
  LocationActionsSchema.parse(
    await (await call(owner, "GET", `/locations/${locationId}/actions`)).json(),
  ).waiting;

/** Proposes for every ready contact, approves the one at `locationId` and sends it. Its id. */
async function sendOne(owner: string, locationId: string) {
  db.now = "2026-11-04T03:31:00.000Z";
  await proposeReviewRequests({ store: worker(), asking: await asking() });
  const [proposal] = await waitingAt(owner, locationId);
  if (!proposal) throw new Error("Nothing waiting");
  await call(owner, "POST", `/actions/${proposal.id}/approve`, {});
  db.now = "2026-11-04T15:00:00.000Z";
  expect(
    await carryOutAction(proposal.id, {
      store: worker(),
      key: null,
      asking: await asking(),
      now: new Date(db.now),
    }),
  ).toBe("done");
  // Approving queued the action, which was just carried out here.
  queued = [];
  return proposal.id;
}

/** A customer of `owner`'s at a location of its own, sent a request. The link in the email. */
async function linkSent(owner = alice, business = "Joe's Pizza", customer = "jane@example.org") {
  const at = await shop(owner, `${business} Group`, business);
  await receipt(owner, at, customer);
  const actionId = await sendOne(owner, at.id);
  const email = sent.at(-1);
  if (!email) throw new Error("Nothing sent");
  const path = email.text.match(/https:\/\/nearcited\.example(\/r\/\S+)/)?.[1] ?? "";
  return { at, actionId, email, path };
}

/** Hands everything the routes queued to the worker, as the queue consumer does. */
async function work() {
  for (const body of queued.splice(0)) {
    const message = readFoundMessage(body);
    if (!message) throw new Error(`Not a message for recordFound: ${JSON.stringify(body)}`);
    await recordFound(message, { store: worker() });
  }
}

/** A customer's browser opening the link: no sign-in, no cookie. */
const open = (path: string) => app.request(path, { method: "GET" }, env);

/** A customer's tap on the page: a plain form post. */
const tap = (path: string, answer: string) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ answer }).toString(),
    },
    env,
  );

const foundAt = async (owner: string, locationId: string) =>
  LocationFoundAnswersSchema.parse(
    await (await call(owner, "GET", `/locations/${locationId}/found-answers`)).json(),
  );

beforeEach(() => {
  db = createMemoryDb();
  queued = [];
  sent = [];
  sampleData = false;
  env = {
    PROVIDER_MODE: "live",
    RESEND_API_KEY: "re_test",
    APP_URL: "https://nearcited.example",
    CONNECTIONS_KEY: SECRET,
    SCAN_QUEUE: {
      send: async (message: unknown) => {
        queued.push(message);
      },
      sendBatch: async (messages: { body: unknown }[]) => {
        queued.push(...messages.map((message) => message.body));
      },
    },
  } as unknown as Env;
});

describe("how did you find us?", () => {
  it("is answered in one tap on the way to the review form, and counted for the location", async () => {
    const { at, email, path } = await linkSent();
    expect(path).not.toBe("");
    expect(email.text).not.toContain(FORM);

    const page = await open(path);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(await page.text()).toContain("How did you find Joe&#39;s Pizza?");

    const answered = await tap(path, "assistant:chatgpt");
    expect(answered.status).toBe(303);
    expect(answered.headers.get("Location")).toBe(FORM);
    await work();

    expect(await foundAt(alice, at.id)).toEqual({
      months: [{ month: "2026-11", answer: "assistant", assistant: "chatgpt", count: 1 }],
      sample_data: false,
    });
  });

  it("is shown to a member as a placeholder, and the link carries no address", async () => {
    const at = await shop(alice, "Joe's Pizza Group", "Joe's Pizza");
    await receipt(alice, at, "jane@example.org");
    db.now = "2026-11-04T03:31:00.000Z";
    await proposeReviewRequests({ store: worker(), asking: await asking() });
    const [proposal] = await waitingAt(alice, at.id);
    expect(proposal?.proposed_text).toContain(REVIEW_FORM_SHOWN);
    expect(proposal?.proposed_text).not.toContain(FORM);

    const { path } = await linkSent(carol, "Durham Tacos", "jane@example.org");
    expect(path).not.toMatch(/jane/i);
    expect(atob(path.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? "")).not.toMatch(
      /jane/i,
    );
  });

  it("counts one answer for each request, and a second visit still reaches the form", async () => {
    const { at, path } = await linkSent();
    await tap(path, "search");
    const again = await open(path);
    expect(again.status).toBe(200);
    const second = await tap(path, "been_before");
    expect(second.headers.get("Location")).toBe(FORM);
    await work();

    expect((await foundAt(alice, at.id)).months).toEqual([
      { month: "2026-11", answer: "search", assistant: null, count: 1 },
    ]);
  });

  it("counts a skip, an assistant not named, and anything else tapped as a skip", async () => {
    const first = await linkSent(alice, "Joe's Pizza", "jane@example.org");
    await tap(first.path, "skipped");
    await work();
    const second = await linkSent(carol, "Durham Tacos", "ann@example.org");
    await tap(second.path, "assistant");
    await work();
    const third = await linkSent(
      "d0000000-0000-4000-8000-000000000004",
      "Cary Bagels",
      "sam@example.org",
    );
    const odd = await tap(third.path, "assistant:askjeeves");
    expect(odd.headers.get("Location")).toBe(FORM);
    await work();

    expect((await foundAt(alice, first.at.id)).months).toEqual([
      { month: "2026-11", answer: "skipped", assistant: null, count: 1 },
    ]);
    expect((await foundAt(carol, second.at.id)).months).toEqual([
      { month: "2026-11", answer: "assistant", assistant: null, count: 1 },
    ]);
    expect((await foundAt("d0000000-0000-4000-8000-000000000004", third.at.id)).months).toEqual([
      { month: "2026-11", answer: "skipped", assistant: null, count: 1 },
    ]);
  });

  it("still leads to the form once the request is gone, and counts nothing for it", async () => {
    const { at, actionId, path } = await linkSent();
    db.actions = db.actions.filter((action) => action.id !== actionId);
    const answered = await tap(path, "search");
    expect(answered.headers.get("Location")).toBe(FORM);
    await work();
    expect((await foundAt(alice, at.id)).months).toEqual([]);
  });

  it("turns away a link it did not sign with the same page, queuing nothing", async () => {
    const { path } = await linkSent();
    const [version, payload, signature] = path.slice("/r/".length).split(".");
    const keys = await askingKeys(btoa(String.fromCharCode(...new Uint8Array(32).fill(9))));
    const otherDeployment = await keys?.foundToken({
      action_id: crypto.randomUUID(),
      form: "https://evil.example/",
      business: "Joe's Pizza",
    });
    const forged = [
      `/r/${version}.${payload}.${"A".repeat(43)}`,
      `/r/${version}.${payload?.slice(0, -2)}.${signature}`,
      `/r/f9.${payload}.${signature}`,
      `/r/${otherDeployment}`,
      "/r/not-a-token",
    ];
    queued = [];
    const pages = new Set<string>();
    for (const bad of forged) {
      for (const answer of [await open(bad), await tap(bad, "search")]) {
        expect(answer.status).toBe(404);
        expect(answer.headers.get("Location")).toBeNull();
        pages.add(await answer.text());
      }
    }
    expect(pages.size).toBe(1);
    expect(queued).toEqual([]);
  });

  it("counts an opening for the deployment, and serves a page that runs nothing", async () => {
    const { path } = await linkSent();
    const page = await open(path);
    expect(queued).toEqual([{ found_opened: true }]);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(page.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).not.toMatch(/<script|<img|<iframe/i);
    expect(html).not.toMatch(/nearcited/i);
    expect(html).toContain("Skip to the review");
    expect(html).toContain("not kept with your name");
  });

  it("makes up an answer for a test organization's request, kept as sample data", async () => {
    const at = await shop(alice, "Joe's Pizza Group", "Joe's Pizza");
    await receipt(alice, at, "jane@example.org");
    // A test organization receives no real receipt: this one was made one after it arrived.
    const kept = db.organizations.find((o) => o.id === at.organization.id);
    if (kept) kept.is_test = true;
    await sendOne(alice, at.id);
    expect(sent).toEqual([]);

    const found = await foundAt(alice, at.id);
    expect(found.sample_data).toBe(true);
    expect(found.months).toHaveLength(1);
    expect(found.months[0]).toMatchObject({ month: "2026-11", count: 1 });
  });

  it("makes up answers on a deployment with sample data, and none are real", async () => {
    sampleData = true;
    env = { ...env, PROVIDER_MODE: "mock" } as Env;
    const at = await shop(alice, "Joe's Pizza Group", "Joe's Pizza");
    await receipt(alice, at, "jane@example.org");
    await sendOne(alice, at.id);
    expect(sent).toEqual([]);
    expect((await foundAt(alice, at.id)).months).toHaveLength(1);

    env = { ...env, PROVIDER_MODE: "live" } as Env;
    expect(await foundAt(alice, at.id)).toEqual({ months: [], sample_data: false });
  });

  it("is read only by the location's own organization", async () => {
    const { at, path } = await linkSent();
    await tap(path, "search");
    await work();
    const read = await call(carol, "GET", `/locations/${at.id}/found-answers`);
    expect(read.status).toBe(404);
  });
});
