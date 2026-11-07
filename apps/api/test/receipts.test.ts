import {
  LocationReceiptsSchema,
  LocationSchema,
  OrganizationSchema,
  ReceiptSenderSchema,
  ReviewRequestSettingsSchema,
} from "@nearcited/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { sendActionNotices } from "../src/actions/notice";
import { createApp } from "../src/app";
import { syncConnection } from "../src/connections";
import type { Email } from "../src/email/report";
import type { Env } from "../src/env";
import { receiveEmail } from "../src/receipts";
import { createMemoryDb, type MemoryDb, memoryStore } from "./memory-store";

const alice = "a0000000-0000-4000-8000-000000000001";
const bob = "b0000000-0000-4000-8000-000000000002";
const carol = "c0000000-0000-4000-8000-000000000003";
const dave = "d0000000-0000-4000-8000-000000000004";
const erin = "e0000000-0000-4000-8000-000000000005";

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

/**
 * Alice's organization, with Bob a member, Dave an admin and Erin the operator, and Joe's Pizza in
 * New York with review requests on. Its receipt address, written out whole.
 */
async function asking() {
  const organization = OrganizationSchema.parse(
    await (await call(alice, "POST", "/organizations", { name: "Raleigh Pizza Group" })).json(),
  );
  db.memberships.push({ organization_id: organization.id, user_id: bob, role: "member" });
  db.memberships.push({ organization_id: organization.id, user_id: dave, role: "admin" });
  db.operators.add(erin);
  db.emails.set(alice, "alice@example.com");
  db.emails.set(dave, "dave@example.com");
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
  return { organization, location, settings, address: settings.receipt_address };
}

/** A receipt Square sends Jane, copied to `to`, as the email handler is given it. */
const receipt = (to: string, headers: Record<string, string | null> = {}) => {
  const all: Record<string, string | null> = {
    "Authentication-Results": "mx.cloudflare.net; spf=pass; dkim=pass header.d=squareup.com",
    From: "Joe's Pizza <receipts@squareup.com>",
    To: "Jane Doe <jane@example.org>",
    Date: "Tue, 03 Nov 2026 21:45:00 -0500",
    ...headers,
  };
  return {
    to,
    from: "bounces@squareup.com",
    headers: new Headers(
      Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== null),
    ),
  };
};

const receive = (message: ReturnType<typeof receipt>) =>
  receiveEmail(message, {
    store: worker(),
    sampleData: false,
    now: new Date("2026-11-04T03:30:00.000Z"),
  });

const readReceipts = async (user: string, locationId: string) => {
  const response = await call(user, "GET", `/locations/${locationId}/receipts`);
  return { status: response.status, body: await response.json() };
};

beforeEach(() => {
  db = createMemoryDb();
  env = {
    PROVIDER_MODE: "mock",
    SCAN_QUEUE: { send: async () => {}, sendBatch: async () => {} },
  } as unknown as Env;
});

describe("a receipt copied to a receipt address", () => {
  it("from a new sender is held until an owner or admin confirms the sender, and is then ready", async () => {
    const { location, address } = await asking();
    expect(await receive(receipt(address))).toBe("held");
    expect(await receive(receipt(address, { To: "John <john@example.org>" }))).toBe("held");

    const { body } = await readReceipts(bob, location.id);
    const read = LocationReceiptsSchema.parse(body);
    expect(read.can_manage).toBe(false);
    expect(read.senders).toMatchObject([{ address: "receipts@squareup.com", status: "waiting" }]);
    expect(
      read.contacts.map((contact) => [contact.masked, contact.job_day, contact.status]),
    ).toEqual([
      ["j•••@example.org", "2026-11-03", "held"],
      ["j•••@example.org", "2026-11-03", "held"],
    ]);
    expect(JSON.stringify(body)).not.toMatch(/jane@|john@/);

    const sender = read.senders[0]?.id;
    for (const user of [bob, carol, erin]) {
      const refused = await call(user, "POST", `/receipt-senders/${sender}/confirm`);
      expect(refused.status, user).toBeGreaterThanOrEqual(403);
    }
    const confirmed = await call(dave, "POST", `/receipt-senders/${sender}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(ReceiptSenderSchema.parse(await confirmed.json())).toMatchObject({
      status: "confirmed",
      decided_by_email: "dave@example.com",
    });
    const after = LocationReceiptsSchema.parse((await readReceipts(alice, location.id)).body);
    expect(after.can_manage).toBe(true);
    expect(after.contacts.map((contact) => contact.status)).toEqual(["ready", "ready"]);

    // The next one is ready at once.
    expect(await receive(receipt(address, { To: "ann@example.org" }))).toBe("ready");
  });

  it("from a declined sender is deleted, and what it sends later is dropped and counted", async () => {
    const { location, address } = await asking();
    expect(await receive(receipt(address))).toBe("held");
    const [sender] = LocationReceiptsSchema.parse(
      (await readReceipts(alice, location.id)).body,
    ).senders;
    const declined = await call(alice, "POST", `/receipt-senders/${sender?.id}/decline`);
    expect(declined.status).toBe(200);
    expect(await receive(receipt(address, { To: "sam@example.org" }))).toBe("declined_sender");
    const read = LocationReceiptsSchema.parse((await readReceipts(alice, location.id)).body);
    expect(read.contacts).toEqual([]);
    expect(read.dropped).toEqual({ declined_sender: 1 });
  });

  it("is dropped and counted when it cannot be read with certainty", async () => {
    const { location, address } = await asking();
    expect(
      await receive(
        receipt(address, { "Authentication-Results": "mx.cloudflare.net; spf=fail; dkim=fail" }),
      ),
    ).toBe("unauthenticated");
    expect(await receive(receipt(address, { To: "orders@joespizza.com" }))).toBe("no_customer");
    expect(await receive(receipt(address, { To: null }))).toBe("no_customer");
    expect(await receive(receipt(address, { To: "a@example.org, b@example.org" }))).toBe(
      "several_customers",
    );
    const read = LocationReceiptsSchema.parse((await readReceipts(alice, location.id)).body);
    expect(read.contacts).toEqual([]);
    expect(read.senders).toEqual([]);
    expect(read.dropped).toEqual({ unauthenticated: 1, no_customer: 2, several_customers: 1 });
  });

  it("is not received where review requests are off, and that is counted", async () => {
    const { location, address, settings } = await asking();
    const connection = db.connections.find((c) => c.id === settings.connection_id);
    if (connection) connection.status = "paused";
    expect(await receive(receipt(address))).toBe("not_on");
    const read = LocationReceiptsSchema.parse((await readReceipts(alice, location.id)).body);
    expect(read.contacts).toEqual([]);
    expect(read.dropped).toEqual({ not_on: 1 });
  });

  it("is refused for an address that is nobody's", async () => {
    const { location, address } = await asking();
    for (const to of [
      "receipts+00000000000000000000000000000000@nearcited.com",
      address.replace("@nearcited.com", "@elsewhere.example"),
      // The form before #300, which nothing routed.
      address.replace(/^receipts\+(\w+)@/, "$1@receipts."),
      "receipts@nearcited.com",
      "postmaster@nearcited.com",
    ]) {
      expect(await receive(receipt(to)), to).toBe("unknown");
    }
    // A replaced address is nobody's from then on.
    await call(alice, "POST", `/locations/${location.id}/review-requests/address`);
    expect(await receive(receipt(address))).toBe("unknown");
    expect(db.customerContacts).toEqual([]);
    expect(db.receiptDrops).toEqual([]);
  });

  it("is never received for a test organization or on sample data", async () => {
    const { organization, address } = await asking();
    expect(await receiveEmail(receipt(address), { store: worker(), sampleData: true })).toBe(
      "sample",
    );
    const kept = db.organizations.find((candidate) => candidate.id === organization.id);
    if (kept) kept.is_test = true;
    expect(await receive(receipt(address))).toBe("sample");
    expect(db.customerContacts).toEqual([]);
    expect(db.receiptDrops).toEqual([]);
  });
});

describe("a location's receipts", () => {
  it("are read by members and the operator, and by nobody else", async () => {
    const { location, address } = await asking();
    await receive(receipt(address));
    for (const user of [alice, bob, dave, erin]) {
      const { status, body } = await readReceipts(user, location.id);
      expect(status, user).toBe(200);
      expect(LocationReceiptsSchema.parse(body).contacts, user).toHaveLength(1);
    }
    expect((await readReceipts(carol, location.id)).status).toBe(404);
  });

  it("are generated, never received, for a test organization when its review requests sync", async () => {
    const { organization, location, settings } = await asking();
    const kept = db.organizations.find((candidate) => candidate.id === organization.id);
    if (kept) kept.is_test = true;
    db.now = "2026-11-04T15:00:00.000Z";
    const now = new Date("2026-11-04T15:00:00.000Z");
    expect(await syncConnection(settings.connection_id, { store: worker(), key: null, now })).toBe(
      "synced",
    );
    const read = LocationReceiptsSchema.parse((await readReceipts(alice, location.id)).body);
    expect(read.contacts.length).toBeGreaterThan(0);
    for (const contact of read.contacts) {
      expect(contact).toMatchObject({ sample_data: true, job_day: "2026-11-03", status: "held" });
    }
    // Syncing again the same day makes nothing more.
    const count = read.contacts.length;
    await syncConnection(settings.connection_id, { store: worker(), key: null, now });
    expect(
      LocationReceiptsSchema.parse((await readReceipts(alice, location.id)).body).contacts,
    ).toHaveLength(count);
  });
});

describe("the daily action notice", () => {
  it("names a sender waiting for confirmation, once for what it holds", async () => {
    const { address } = await asking();
    await receive(receipt(address));
    const sent: { to: string[]; email: Email }[] = [];
    const send = async (to: string[], email: Email) => {
      sent.push({ to, email });
    };
    expect(await sendActionNotices({ store: worker(), send, appUrl: "https://app.example" })).toBe(
      1,
    );
    expect(sent[0]?.to).toEqual(["alice@example.com"]);
    expect(sent[0]?.email.text).toContain("receipts@squareup.com");
    expect(sent[0]?.email.text).toContain("Joe's Pizza");

    // Told once; a new receipt held tells it again.
    expect(await sendActionNotices({ store: worker(), send, appUrl: "https://app.example" })).toBe(
      0,
    );
    await receive(receipt(address, { To: "kim@example.org" }));
    expect(await sendActionNotices({ store: worker(), send, appUrl: "https://app.example" })).toBe(
      1,
    );
  });
});
