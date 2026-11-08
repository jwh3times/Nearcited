import {
  LocationActionsSchema,
  LocationSchema,
  OrganizationSchema,
  ReviewRequestSettingsSchema,
} from "@nearcited/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { carryOutAction } from "../src/actions";
import {
  type Asking,
  askingKeys,
  proposeReviewRequests,
  readDoNotAskMessage,
  recordDoNotAsk,
} from "../src/actions/review-requests";
import { createApp } from "../src/app";
import { reviewRequestPayload } from "../src/email/review-request";
import type { Env } from "../src/env";
import { receiveEmail } from "../src/receipts";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

/**
 * Opting out of review requests, and stopping at a bounce or a complaint (issue #293, part of
 * #146). The link in a request, and the one-click unsubscribe its headers name, opt the address
 * out of the organization; a signed report of a hard bounce or a complaint stops it everywhere.
 * Neither route is signed in or reads anything: each checks a signature and queues the worker.
 */

const alice = "a0000000-0000-4000-8000-000000000001";
const carol = "c0000000-0000-4000-8000-000000000003";

const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const WEBHOOK_SECRET = `whsec_${btoa("a webhook secret, 32 bytes long!")}`;

let db: MemoryDb;
let env: Env;
let queued: unknown[];
let sent: { to: string; text: string; unsubscribe: string }[];

const app = createApp({
  authenticate: async (request) => {
    const userId = request.headers.get("Authorization")?.replace("Bearer ", "");
    return userId
      ? { user: { id: userId, email: `${userId}@example.com` }, store: memoryStore(db, userId) }
      : null;
  },
  publicStore: () => memoryStore(db, "nobody"),
  // Neither route may use the worker's store: a call to it fails the test.
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
    sampleData: false,
    send: async (message) => {
      sent.push(message);
    },
  };
}

/** An organization of `owner`'s with one location asking for reviews. */
async function shop(owner: string, name: string) {
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
  const asks = async (locationName: string) => {
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
    await call(owner, "PUT", `/locations/${made.id}/listings/google.com`, {
      url: "https://g.page/r/example/review",
    });
    const settings = ReviewRequestSettingsSchema.parse(
      await (
        await call(owner, "POST", `/locations/${made.id}/review-requests`, {
          site: "google.com",
          reply_to: `${owner}@example.com`,
          confirmed: true,
        })
      ).json(),
    );
    return { id: made.id, receiptAddress: settings.receipt_address };
  };
  return { organization, asks };
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

/** Proposes for every ready contact, as the worker's run does. How many were proposed. */
const propose = async () => {
  db.now = "2026-11-04T03:31:00.000Z";
  return proposeReviewRequests({ store: worker(), asking: await asking() });
};

/** Sends the one request waiting at `locationId`, approved by its owner. The email. */
async function sendOne(owner: string, locationId: string) {
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
  const email = sent.at(-1);
  if (!email) throw new Error("Nothing sent");
  return email;
}

/** Hands everything the routes queued to the worker, as the queue consumer does. */
async function work() {
  for (const body of queued.splice(0)) {
    const message = readDoNotAskMessage(body);
    if (!message) throw new Error(`Not a message for recordDoNotAsk: ${JSON.stringify(body)}`);
    await recordDoNotAsk(message, { store: worker() });
  }
}

/** A request with no sign-in. */
const post = (path: string, body = "", headers: Record<string, string> = {}) =>
  app.request(`/api${path}`, { method: "POST", headers, body }, env);

/** A webhook signed as Resend signs one: Standard Webhooks, HMAC-SHA256 over id.timestamp.body. */
async function signed(body: string, secret = WEBHOOK_SECRET) {
  const id = `msg_${crypto.randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret.slice("whsec_".length)), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`,
    "Content-Type": "application/json",
  };
}

/** What Resend reports of an email to `to`. */
const report = (
  type: "email.bounced" | "email.complained" | "email.delivered",
  to: string,
  extra: Record<string, unknown> = {},
  tags: Record<string, string> = { kind: "review_request" },
) =>
  JSON.stringify({
    type,
    created_at: "2026-11-04T15:01:00.000Z",
    data: {
      created_at: "2026-11-04T15:00:00.000Z",
      email_id: crypto.randomUUID(),
      from: "Joe's Pizza <requests@ask.nearcited.example>",
      to: [to],
      subject: "Would you review Joe's Pizza on Google?",
      tags,
      ...extra,
    },
  });

const hardBounce = {
  bounce: { message: "No such mailbox", subType: "General", type: "Permanent" },
};
const softBounce = {
  bounce: { message: "Mailbox full", subType: "MailboxFull", type: "Transient" },
};

beforeEach(() => {
  db = createMemoryDb();
  queued = [];
  sent = [];
  env = {
    PROVIDER_MODE: "mock",
    APP_URL: "https://nearcited.example",
    CONNECTIONS_KEY: SECRET,
    RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
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

describe("opting out of review requests", () => {
  it("one click on a request's link stops the organization asking that address anywhere, and no other", async () => {
    const pizza = await shop(alice, "Raleigh Pizza Group");
    const north = await pizza.asks("Joe's Pizza North");
    const south = await pizza.asks("Joe's Pizza South");
    const tacos = await (await shop(carol, "Durham Tacos")).asks("Durham Tacos");
    await receipt(alice, north, "jane@example.org");
    await propose();
    const email = await sendOne(alice, north.id);

    const link = email.text.match(/https:\/\/nearcited\.example\/opt-out\/(\S+)/)?.[1] ?? "";
    expect(link).not.toBe("");
    const answer = await post(`/opt-out/${link}`);
    expect(answer.status).toBe(200);
    // The route only queued the worker.
    expect(queued).toHaveLength(1);
    await work();

    await receipt(alice, south, "Jane Doe <JANE@example.org>");
    await receipt(carol, tacos, "jane@example.org");
    expect(await propose()).toBe(1);
    expect(await waitingAt(alice, south.id)).toEqual([]);
    expect(await waitingAt(carol, tacos.id)).toHaveLength(1);
  });

  it("does the same from the one-click unsubscribe the request's headers name", async () => {
    const pizza = await shop(alice, "Raleigh Pizza Group");
    const north = await pizza.asks("Joe's Pizza North");
    await receipt(alice, north, "jane@example.org");
    await propose();
    const email = await sendOne(alice, north.id);

    const payload = reviewRequestPayload("requests@ask.nearcited.example", {
      ...email,
      from_name: "Joe's Pizza",
      reply_to: "owner@example.com",
      subject: "Would you review Joe's Pizza on Google?",
      key: "review-request/1",
    });
    expect(payload.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const url = payload.headers["List-Unsubscribe"].match(/^<(https:\/\/[^>]+)>$/)?.[1] ?? "";
    expect(url.startsWith("https://nearcited.example/api/opt-out/")).toBe(true);
    // Only review requests are reported on, by the tag they carry.
    expect(payload.tags).toEqual([{ name: "kind", value: "review_request" }]);

    // What a mail client sends for one click: a POST of this form, with no cookie.
    const answer = await post(
      url.replace("https://nearcited.example/api", ""),
      "List-Unsubscribe=One-Click",
      {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    );
    expect(answer.status).toBe(200);
    await work();

    await receipt(alice, north, "jane@example.org");
    expect(await propose()).toBe(0);
  });

  it("sends a mail client that opens the unsubscribe link to the page, and records nothing", async () => {
    const keys = await askingKeys(SECRET);
    if (!keys) throw new Error("No keys");
    const token = await keys.optOutToken(
      crypto.randomUUID(),
      await keys.fingerprint("a@example.org"),
    );
    const opened = await app.request(`/api/opt-out/${token}`, { method: "GET" }, env);
    expect(opened.status).toBe(303);
    expect(opened.headers.get("Location")).toBe(`/opt-out/${token}`);
    expect(queued).toEqual([]);
  });

  it("answers the same for every address, and turns away a link it did not sign", async () => {
    const keys = await askingKeys(SECRET);
    if (!keys) throw new Error("No keys");
    const org = crypto.randomUUID();
    const known = await keys.optOutToken(org, await keys.fingerprint("jane@example.org"));
    const unknown = await keys.optOutToken(org, await keys.fingerprint("nobody@example.org"));
    const first = await post(`/opt-out/${known}`);
    const second = await post(`/opt-out/${unknown}`);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await first.text()).toBe(await second.text());

    const [carried, fingerprint] = known.split(".");
    const forged = [
      `${carried}.${fingerprint}.${"A".repeat(43)}`,
      `${crypto.randomUUID()}.${fingerprint}.${known.split(".")[2]}`,
      "not-a-token",
    ];
    queued = [];
    for (const token of forged) expect((await post(`/opt-out/${token}`)).status).toBe(404);
    expect(queued).toEqual([]);
  });
});

describe("a bounce or a complaint", () => {
  it("stops every organization asking an address that bounced hard or complained", async () => {
    const pizza = await (await shop(alice, "Raleigh Pizza Group")).asks("Joe's Pizza");
    const tacos = await (await shop(carol, "Durham Tacos")).asks("Durham Tacos");

    for (const [type, extra] of [
      ["email.bounced", hardBounce],
      ["email.complained", {}],
    ] as const) {
      const customer = `${type}@example.org`;
      const body = report(type, `Jane <${customer.toUpperCase()}>`, extra);
      expect((await post("/resend/webhook", body, await signed(body))).status).toBe(200);
      await work();
      await receipt(alice, pizza, customer);
      await receipt(carol, tacos, customer);
      expect(await propose()).toBe(0);
    }
  });

  it("changes nothing for a soft bounce, another email, or a report it cannot trust", async () => {
    const pizza = await (await shop(alice, "Raleigh Pizza Group")).asks("Joe's Pizza");
    const ignored = [
      report("email.bounced", "soft@example.org", softBounce),
      report("email.delivered", "fine@example.org"),
      // A scan report or an invitation, not a review request.
      report("email.bounced", "owner@example.org", hardBounce, { category: "report" }),
    ];
    for (const body of ignored) {
      expect((await post("/resend/webhook", body, await signed(body))).status).toBe(200);
    }
    const forged = report("email.bounced", "forged@example.org", hardBounce);
    const wrongKey = await signed(forged, `whsec_${btoa("somebody else's secret, 32 bytes")}`);
    expect((await post("/resend/webhook", forged, wrongKey)).status).toBe(400);
    expect(
      (await post("/resend/webhook", forged, { "Content-Type": "application/json" })).status,
    ).toBe(400);
    expect(queued).toEqual([]);

    for (const customer of ["soft@example.org", "owner@example.org", "forged@example.org"]) {
      await receipt(alice, pizza, customer);
    }
    expect(await propose()).toBe(3);
  });
});
