import { describe, expect, it } from "vitest";
import { addressesIn, maskAddress, type ReceiptIn, readReceipt } from "../src/receipts";

const RECEIVED = new Date("2026-11-04T03:30:00.000Z");

/** A receipt from Square to one customer, copied to the receipt address, as it arrives. */
const receipt = (changes: Partial<ReceiptIn> = {}): ReceiptIn => ({
  authentication_results:
    "mx.cloudflare.net; spf=pass smtp.mailfrom=squareup.com; dkim=pass header.d=squareup.com; dmarc=pass",
  from: "Joe's Pizza via Square <receipts@messaging.squareup.com>",
  envelope_from: "bounces+x1y2@messaging.squareup.com",
  to: "Jane Doe <Jane.Doe@Gmail.com>",
  date: "Tue, 03 Nov 2026 21:45:00 -0500",
  received: RECEIVED,
  ...changes,
});

/** Joe's Pizza in New York, whose replies go to the owner. */
const JOES = {
  website: "https://www.joespizza.com/",
  reply_to: "owner@joespizza.com",
  time_zone: "America/New_York",
};

describe("reading a copied receipt", () => {
  it("keeps the sender, the one customer and the day of the job in the location's time zone", () => {
    expect(readReceipt(receipt(), JOES)).toEqual({
      kept: {
        sender: "receipts@messaging.squareup.com",
        customer: "jane.doe@gmail.com",
        job_day: "2026-11-03",
      },
    });
    // The same moment is already the next day in Tokyo.
    expect(readReceipt(receipt(), { ...JOES, time_zone: "Asia/Tokyo" })).toMatchObject({
      kept: { job_day: "2026-11-04" },
    });
  });

  it("counts a message that passes DKIM or SPF for its sender's domain, as Cloudflare found them", () => {
    // The sender is receipts@messaging.squareup.com.
    for (const results of [
      "mx.cloudflare.net; spf=fail smtp.mailfrom=squareup.com; dkim=pass header.d=squareup.com",
      "mx.cloudflare.net; spf=pass smtp.mailfrom=bounces+x1@messaging.squareup.com; dkim=none",
      "mx.cloudflare.net; spf=none; dkim=pass header.i=@mail.messaging.squareup.com",
      "MX.Cloudflare.net;\r\n dkim=fail (bad signature) header.d=evil.example;\r\n dkim=pass header.d=SquareUp.com",
      // DMARC passing says the sender's domain passed.
      "mx.cloudflare.net; spf=pass smtp.mailfrom=sendgrid.net; dkim=none; dmarc=pass header.from=messaging.squareup.com",
    ]) {
      expect(
        readReceipt(receipt({ authentication_results: results }), JOES),
        results,
      ).toHaveProperty("kept");
    }
  });

  it("drops a message that fails both, passes only for another domain, or whose results are not Cloudflare's own", () => {
    for (const results of [
      "mx.cloudflare.net; spf=fail smtp.mailfrom=squareup.com; dkim=fail header.d=squareup.com",
      "mx.cloudflare.net; spf=softfail; dkim=none; dmarc=none",
      "mx.cloudflare.net; spf=neutral (spf=pass in a comment)",
      // A pass for someone else's domain says nothing about this sender.
      "mx.cloudflare.net; spf=pass smtp.mailfrom=evil.example; dkim=pass header.d=evil.example; dmarc=fail",
      "mx.cloudflare.net; spf=pass smtp.mailfrom=notsquareup.com",
      "mx.cloudflare.net; spf=pass; dkim=pass",
      // The sender's own header, read after Cloudflare's, is not Cloudflare's word.
      "mx.cloudflare.net; spf=fail; dkim=fail, mx.cloudflare.net; dmarc=pass",
      "evil.example; dmarc=pass; spf=pass smtp.mailfrom=squareup.com",
      // A comment within a comment, or one left open, is not read at all.
      "mx.cloudflare.net; dmarc=pass (a (nested) comment)",
      "mx.cloudflare.net; dmarc=pass (left open",
      "mx.cloudflare.net; dmarc=pass (escaped \\) close",
      "mx.cloudflare.net; dmarc=pass ) stray",
      "",
      null,
    ]) {
      expect(
        readReceipt(receipt({ authentication_results: results }), JOES),
        String(results),
      ).toEqual({ dropped: "unauthenticated" });
    }
  });

  it("reads a header crafted to be slow in the time a plain one takes", () => {
    // Anyone can send mail to a receipt address, so the header is read in one pass.
    const results = `mx.cloudflare.net; dmarc=pass (${"\\(".repeat(100_000)}`;
    const started = performance.now();
    expect(readReceipt(receipt({ authentication_results: results }), JOES)).toEqual({
      dropped: "unauthenticated",
    });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("picks the customer from the addresses that are neither the business's own nor the product's", () => {
    const to = [
      '"Joe\'s Pizza, Raleigh" <orders@joespizza.com>',
      "receipts@messaging.squareup.com",
      "Owner <owner@joespizza.com>",
      "abc123@receipts.nearcited.com",
      "help@nearcited.com",
      "jane@example.org (Jane)",
      "Shop <shop@mail.joespizza.com>",
    ].join(", ");
    expect(readReceipt(receipt({ to }), JOES)).toMatchObject({
      kept: { customer: "jane@example.org" },
    });
  });

  it("never guesses: no customer, or more than one, drops the message", () => {
    for (const to of [
      null,
      "",
      "undisclosed-recipients:;",
      "orders@joespizza.com, abc@receipts.nearcited.com",
      "not an address",
      "Jane <jane@example.org",
    ]) {
      expect(readReceipt(receipt({ to }), JOES), String(to)).toEqual({ dropped: "no_customer" });
    }
    for (const to of [
      "jane@example.org, john@example.org",
      "Family: jane@example.org, John <john@example.org>;",
    ]) {
      expect(readReceipt(receipt({ to }), JOES), to).toEqual({ dropped: "several_customers" });
    }
    // The same address twice is one customer.
    expect(
      readReceipt(receipt({ to: "jane@example.org, Jane <JANE@example.org>" }), JOES),
    ).toMatchObject({ kept: { customer: "jane@example.org" } });
  });

  it("names the sender from From, or from the envelope where From names no single address", () => {
    expect(readReceipt(receipt({ from: null }), JOES)).toMatchObject({
      kept: { sender: "bounces+x1y2@messaging.squareup.com" },
    });
    expect(readReceipt(receipt({ from: null, envelope_from: "" }), JOES)).toEqual({
      dropped: "unauthenticated",
    });
  });

  it("takes the day it arrived where Date is missing, unreadable or in the future", () => {
    for (const date of [null, "yesterday", "Fri, 20 Nov 2026 10:00:00 -0500"]) {
      // 03:30 UTC on the 4th is 22:30 on the 3rd in New York.
      expect(readReceipt(receipt({ date }), JOES), String(date)).toMatchObject({
        kept: { job_day: "2026-11-03" },
      });
    }
  });
});

describe("the addresses a header names", () => {
  it("reads display names, quoted commas, comments and groups", () => {
    expect(
      addressesIn(
        '"Doe, Jane" <jane@example.org>, john@example.org (John), Team: a@x.io, B <b@x.io>;, =?UTF-8?Q?Ren=C3=A9?= <rene@example.fr>',
      ),
    ).toEqual(["jane@example.org", "john@example.org", "a@x.io", "b@x.io", "rene@example.fr"]);
  });

  it("is null where any part of it cannot be read with certainty", () => {
    for (const header of ["jane", "<jane@example.org", '"Doe <jane@example.org>', "a@b"]) {
      expect(addressesIn(header), header).toBeNull();
    }
  });
});

describe("a masked address", () => {
  it("shows the first letter and the domain, and nothing else of the name", () => {
    expect(maskAddress("jane.doe@gmail.com")).toBe("j•••@gmail.com");
    expect(maskAddress("j@gmail.com")).toBe("j•••@gmail.com");
  });
});
