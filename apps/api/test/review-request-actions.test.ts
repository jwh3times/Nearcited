import {
  LocationActionsSchema,
  LocationReceiptsSchema,
  LocationSchema,
  OPT_OUT_SHOWN,
  OrganizationSchema,
  ReviewRequestSettingsSchema,
} from "@nearcited/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { carryOutAction } from "../src/actions";
import { sendActionNotices } from "../src/actions/notice";
import { type Asking, askingKeys, proposeReviewRequests } from "../src/actions/review-requests";
import { createApp } from "../src/app";
import { reviewRequestPayload } from "../src/email/review-request";
import type { Env } from "../src/env";
import { receiveEmail } from "../src/receipts";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

/**
 * Review requests as actions (issue #292, part of #146): a ready customer contact becomes one
 * proposal, a member approves it, and the worker sends it at 10:00 in the location's time zone the
 * morning after the job, from the product under the business's name, with replies going to the
 * location's reply address and a link to opt out.
 */

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";

let db: MemoryDb;
let env: Env;

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

function call(user: string | null, method: string, path: string, body?: unknown) {
  return app.request(
    `/api${path}`,
    {
      method,
      headers: {
        ...(user ? { Authorization: `Bearer ${user}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

const worker = () => memoryStore(db, null);

/** A deployment's CONNECTIONS_KEY: 32 bytes in base64. */
const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

/** The email that went, as the fake sender keeps it. */
interface Sent {
  from_name: string;
  to: string;
  reply_to: string;
  subject: string;
  text: string;
  key: string;
}

let sent: Sent[];

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

/**
 * Alice's organization, with Bob a member, and Joe's Pizza in New York with review requests on,
 * asking for Google reviews with replies going to the owner.
 */
async function joes() {
  const organization = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  db.memberships.push({ organization_id: organization.id, user_id: bob, role: "member" });
  db.emails.set(alice, "alice@example.com");
  db.emails.set(bob, "bob@example.com");
  const kept = db.organizations.find((candidate) => candidate.id === organization.id);
  if (kept) {
    Object.assign(kept, {
      max_locations: 5,
      allowances: { ...kept.allowances, review_requests: 100 },
    });
  }
  const location = LocationSchema.parse(
    await (
      await call(alice, "POST", `/organizations/${organization.id}/locations`, {
        name: "Joe's Pizza",
        website: "https://www.joespizza.com",
        city: "Raleigh",
        region: "NC",
        primary_category: "Pizza restaurant",
        time_zone: "America/New_York",
      })
    ).json(),
  );
  await call(alice, "PUT", `/locations/${location.id}/listings/google.com`, {
    url: "https://g.page/r/joes-pizza/review",
  });
  const settings = ReviewRequestSettingsSchema.parse(
    await (
      await call(alice, "POST", `/locations/${location.id}/review-requests`, {
        site: "google.com",
        reply_to: "owner@joespizza.com",
        confirmed: true,
      })
    ).json(),
  );
  return { organization, location, settings };
}

/**
 * A receipt Square sent `customer` for a job on the evening of `day` (New York), copied to the
 * location's receipt address, received at `at`, with Square confirmed as its own tool.
 */
async function receipt(
  receiptAddress: string,
  locationId: string,
  customer: string,
  day = "2026-11-03",
  at = "2026-11-04T03:30:00.000Z",
) {
  const outcome = await receiveEmail(
    {
      to: receiptAddress,
      from: "bounces@squareup.com",
      headers: new Headers({
        "Authentication-Results": "mx.cloudflare.net; spf=pass; dkim=pass header.d=squareup.com",
        From: "Joe's Pizza <receipts@squareup.com>",
        To: customer,
        Date: `${new Date(`${day}T21:45:00-05:00`).toUTCString()}`,
      }),
    },
    { store: worker(), sampleData: false, now: new Date(at) },
  );
  const read = LocationReceiptsSchema.parse(
    await (await call(alice, "GET", `/locations/${locationId}/receipts`)).json(),
  );
  for (const sender of read.senders.filter((candidate) => candidate.status === "waiting")) {
    await call(alice, "POST", `/receipt-senders/${sender.id}/confirm`);
  }
  return outcome;
}

const actionsOf = async (locationId: string) =>
  LocationActionsSchema.parse(
    await (await call(bob, "GET", `/locations/${locationId}/actions`)).json(),
  );

beforeEach(() => {
  db = createMemoryDb();
  env = {
    PROVIDER_MODE: "mock",
    APP_URL: "https://nearcited.example",
    SCAN_QUEUE: { send: async () => {}, sendBatch: async () => {} },
  } as unknown as Env;
  sent = [];
});

describe("a review request", () => {
  it("is proposed for each ready customer, in the wording the owner approved", async () => {
    const { location, settings } = await joes();
    await receipt(settings.receipt_address, location.id, "Jane Doe <jane@example.org>");
    db.now = "2026-11-04T03:31:00.000Z";

    expect(await proposeReviewRequests({ store: worker(), asking: await asking() })).toBe(1);
    const { waiting } = await actionsOf(location.id);
    expect(waiting).toHaveLength(1);
    const [proposal] = waiting;
    expect(proposal).toMatchObject({
      kind: "review_request",
      summary: "Ask j•••@example.org for a review on Google",
      status: "proposed",
      // A week after the job, at 10:00 in New York.
      lapses_at: "2026-11-10T15:00:00.000Z",
      due_at: null,
    });
    expect(proposal?.proposed_text).toContain("https://g.page/r/joes-pizza/review");
    expect(proposal?.proposed_text).toContain(
      "Nearcited sends this email for Joe's Pizza. If you reply, your reply goes to Joe's Pizza.",
    );
    expect(proposal?.proposed_text).toContain(OPT_OUT_SHOWN);
    // Nobody's full address is in what a member is shown.
    expect(JSON.stringify(waiting)).not.toContain("jane@example.org");

    // Proposing again makes nothing more.
    expect(await proposeReviewRequests({ store: worker(), asking: await asking() })).toBe(0);
  });

  it("once approved, is sent at 10:00 the morning after the job, under the business's name", async () => {
    const { organization, location, settings } = await joes();
    await receipt(settings.receipt_address, location.id, "Jane Doe <jane@example.org>");
    db.now = "2026-11-04T03:31:00.000Z";
    await proposeReviewRequests({ store: worker(), asking: await asking() });
    const [proposal] = (await actionsOf(location.id)).waiting;
    const id = proposal?.id ?? "";
    expect((await call(bob, "POST", `/actions/${id}/approve`, {})).status).toBe(200);
    const deps = async () => ({
      store: worker(),
      key: null,
      asking: await asking(),
      now: new Date(db.now ?? ""),
    });

    // Before 10:00 in New York it waits, and says when it goes.
    db.now = "2026-11-04T14:59:00.000Z";
    expect(await carryOutAction(id, await deps())).toBe("not_yet");
    expect(sent).toEqual([]);
    expect((await actionsOf(location.id)).record).toMatchObject([
      { id, status: "approved", due_at: "2026-11-04T15:00:00.000Z" },
    ]);

    db.now = "2026-11-04T15:00:00.000Z";
    expect(await carryOutAction(id, await deps())).toBe("done");
    expect(sent).toHaveLength(1);
    const [email] = sent;
    expect(email).toMatchObject({
      from_name: "Joe's Pizza",
      to: "jane@example.org",
      reply_to: "owner@joespizza.com",
      subject: "Would you review Joe's Pizza on Google?",
      key: `review-request/${id}`,
    });
    expect(email?.text).toContain("https://g.page/r/joes-pizza/review");
    expect(email?.text).not.toContain(OPT_OUT_SHOWN);
    const optOut = email?.text.match(/https:\/\/nearcited\.example\/opt-out\/(\S+)/)?.[1] ?? "";
    // The link carries the organization and a fingerprint, signed, and never the address.
    expect(optOut.split(".")).toHaveLength(3);
    expect(optOut.startsWith(`${organization.id}.`)).toBe(true);
    expect(optOut).not.toContain("jane");

    // The same customer copied again is not asked a second time.
    await receipt(
      settings.receipt_address,
      location.id,
      "jane@example.org",
      "2026-11-05",
      "2026-11-06T03:30:00.000Z",
    );
    db.now = "2026-11-06T03:31:00.000Z";
    expect(await proposeReviewRequests({ store: worker(), asking: await asking() })).toBe(0);
    expect((await actionsOf(location.id)).waiting).toEqual([]);
  });

  /** Proposes, approves as Bob and carries out every request waiting, at `at`. */
  async function sendAll(locationId: string, at: string) {
    await proposeReviewRequests({ store: worker(), asking: await asking() });
    const ids: string[] = [];
    for (const proposal of (await actionsOf(locationId)).waiting) {
      expect((await call(bob, "POST", `/actions/${proposal.id}/approve`, {})).status).toBe(200);
      ids.push(proposal.id);
    }
    const before = db.now;
    db.now = at;
    const outcomes = [];
    for (const id of ids) {
      outcomes.push(
        await carryOutAction(id, {
          store: worker(),
          key: null,
          asking: await asking(),
          now: new Date(at),
        }),
      );
    }
    db.now = before;
    return outcomes;
  }

  it("sends nothing for a test organization, and is still done", async () => {
    const { organization, location, settings } = await joes();
    await receipt(settings.receipt_address, location.id, "jane@example.org");
    db.now = "2026-11-04T03:31:00.000Z";
    const kept = db.organizations.find((candidate) => candidate.id === organization.id);
    if (kept) kept.is_test = true;
    expect(await sendAll(location.id, "2026-11-04T15:00:00.000Z")).toEqual(["done"]);
    expect(sent).toEqual([]);
  });

  it("sends nothing on a deployment with sample data, and is still done", async () => {
    const { location, settings } = await joes();
    await receipt(settings.receipt_address, location.id, "jane@example.org");
    db.now = "2026-11-04T03:31:00.000Z";
    await proposeReviewRequests({ store: worker(), asking: await asking() });
    const [proposal] = (await actionsOf(location.id)).waiting;
    await call(bob, "POST", `/actions/${proposal?.id}/approve`, {});
    db.now = "2026-11-04T15:00:00.000Z";
    const outcome = await carryOutAction(proposal?.id ?? "", {
      store: worker(),
      key: null,
      asking: { ...(await asking()), sampleData: true },
      now: new Date("2026-11-04T15:00:00.000Z"),
    });
    expect(outcome).toBe("done");
    expect(sent).toEqual([]);
  });

  it("fails at once where outgoing email for review requests is not set up", async () => {
    const { location, settings } = await joes();
    await receipt(settings.receipt_address, location.id, "jane@example.org");
    db.now = "2026-11-04T03:31:00.000Z";
    await proposeReviewRequests({ store: worker(), asking: await asking() });
    const [proposal] = (await actionsOf(location.id)).waiting;
    await call(bob, "POST", `/actions/${proposal?.id}/approve`, {});
    const { send: _send, ...unsent } = await asking();
    db.now = "2026-11-04T15:00:00.000Z";
    expect(
      await carryOutAction(proposal?.id ?? "", {
        store: worker(),
        key: null,
        asking: unsent,
        now: new Date("2026-11-04T15:00:00.000Z"),
      }),
    ).toBe("failed");
    expect((await actionsOf(location.id)).record).toMatchObject([
      { status: "failed", failure: "Outgoing email for review requests is not set up." },
    ]);
  });

  it("is not proposed once the month's allowance is spoken for, and that is counted", async () => {
    const { organization, location, settings } = await joes();
    const kept = db.organizations.find((candidate) => candidate.id === organization.id);
    if (kept) {
      Object.assign(kept, {
        max_locations: 1,
        allowances: { ...kept.allowances, review_requests: 1 },
      });
    }
    await receipt(settings.receipt_address, location.id, "jane@example.org");
    await receipt(settings.receipt_address, location.id, "sam@example.org");
    db.now = "2026-11-04T03:31:00.000Z";

    expect(await proposeReviewRequests({ store: worker(), asking: await asking() })).toBe(1);
    const read = LocationReceiptsSchema.parse(
      await (await call(alice, "GET", `/locations/${location.id}/receipts`)).json(),
    );
    expect(read.dropped).toEqual({ allowance_used: 1 });
    // The customer not asked is not kept.
    expect(read.contacts.map((contact) => contact.masked)).toEqual(["j•••@example.org"]);
  });

  it("offers no take-back once it was sent", async () => {
    const { location, settings } = await joes();
    await receipt(settings.receipt_address, location.id, "jane@example.org");
    db.now = "2026-11-04T03:31:00.000Z";
    const [outcome] = await sendAll(location.id, "2026-11-04T15:00:00.000Z");
    expect(outcome).toBe("done");
    const [done] = (await actionsOf(location.id)).record;
    const asked = await call(bob, "POST", `/actions/${done?.id}/take-back`);
    expect(asked.status).toBe(409);
  });

  it("is told to the owners as one line for each location, linking to the list", async () => {
    const { location, settings } = await joes();
    await receipt(settings.receipt_address, location.id, "a@example.org");
    await receipt(settings.receipt_address, location.id, "b@example.org");
    db.now = "2026-11-04T03:31:00.000Z";
    await sendAll(location.id, "2026-11-04T15:00:00.000Z");
    await receipt(
      settings.receipt_address,
      location.id,
      "c@example.org",
      "2026-11-04",
      "2026-11-05T03:30:00.000Z",
    );
    db.now = "2026-11-05T03:31:00.000Z";
    await proposeReviewRequests({ store: worker(), asking: await asking() });

    const told: { to: string[]; text: string }[] = [];
    db.now = "2026-11-05T12:00:00.000Z";
    await sendActionNotices({
      store: worker(),
      send: async (to, email) => {
        told.push({ to, text: email.text });
      },
      appUrl: "https://nearcited.example",
    });
    expect(told).toHaveLength(1);
    const text = told[0]?.text ?? "";
    expect(text).toContain(
      `- Joe's Pizza: 2 review requests sent, 1 waiting for a yes. See them: https://nearcited.example/locations/${location.id}?tab=actions`,
    );
    // Not a line for each customer.
    expect(text).not.toContain("Ask ");
    expect(text).not.toContain("•••");
  });

  it("after three approved and sent, may go under standing permission without a member's yes", async () => {
    const { organization, location, settings } = await joes();
    const kept = db.organizations.find((candidate) => candidate.id === organization.id);
    if (kept) kept.allowances = { ...kept.allowances, standing_permission: true };
    for (const customer of ["a@example.org", "b@example.org", "c@example.org"]) {
      await receipt(settings.receipt_address, location.id, customer);
    }
    db.now = "2026-11-04T03:31:00.000Z";
    expect(await sendAll(location.id, "2026-11-04T15:00:00.000Z")).toEqual([
      "done",
      "done",
      "done",
    ]);
    // The day's notice tells the owners, as the schedule would.
    db.now = "2026-11-05T12:00:00.000Z";
    await sendActionNotices({
      store: worker(),
      send: async () => {},
      appUrl: "https://nearcited.example",
    });
    // Three approved as proposed and sent: standing permission is offered for them.
    expect((await actionsOf(location.id)).permissions).toEqual([
      { kind: "review_request", counted: 3, standing: null },
    ]);
    const given = await call(
      alice,
      "POST",
      `/organizations/${organization.id}/standing-permissions`,
      {
        kind: "review_request",
      },
    );
    expect(given.status).toBe(201);

    await receipt(
      settings.receipt_address,
      location.id,
      "d@example.org",
      "2026-11-05",
      "2026-11-06T03:30:00.000Z",
    );
    db.now = "2026-11-06T03:31:00.000Z";
    expect(await proposeReviewRequests({ store: worker(), asking: await asking() })).toBe(1);
    const { waiting, record } = await actionsOf(location.id);
    expect(waiting).toEqual([]);
    const [underPermission] = record;
    expect(underPermission).toMatchObject({
      status: "approved",
      due_at: "2026-11-06T15:00:00.000Z",
    });
    db.now = "2026-11-06T15:00:00.000Z";
    expect(
      await carryOutAction(underPermission?.id ?? "", {
        store: worker(),
        key: null,
        asking: await asking(),
        now: new Date("2026-11-06T15:00:00.000Z"),
      }),
    ).toBe("done");
    expect(sent.map((email) => email.to)).toEqual([
      "a@example.org",
      "b@example.org",
      "c@example.org",
      "d@example.org",
    ]);
  });
});

describe("a review request as the mail service is handed it", () => {
  it("is from the product's address under the business's name, which cannot add a header", () => {
    const payload = reviewRequestPayload("requests@ask.nearcited.example", {
      from_name: `Joe's "Best" Pizza\r\nBcc: everyone@example.org`,
      to: "jane@example.org",
      reply_to: "owner@joespizza.com",
      subject: "Would you review Joe's Pizza on Google?",
      text: "Hello",
      key: "review-request/1",
    });
    expect(payload).toEqual({
      from: `"Joe's \\"Best\\" Pizza Bcc: everyone@example.org" <requests@ask.nearcited.example>`,
      to: ["jane@example.org"],
      replyTo: "owner@joespizza.com",
      subject: "Would you review Joe's Pizza on Google?",
      text: "Hello",
    });
  });
});
