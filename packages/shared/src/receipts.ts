import { hashOf } from "./fetches";
import { RECEIPTS_DOMAIN } from "./review-requests";
import type { ReceiptDrop } from "./schemas";

/**
 * Receipts copied to a location's receipt address (issue #291, part of #146,
 * `docs/adr/0031-a-customer-contact-is-read-only-by-the-worker.md`).
 *
 * The business's own tool copies the receipt it sends a customer to the receipt address, and the
 * product keeps the customer's address and the day of the job from it, and nothing else. What a
 * receipt says is decided here, by rule: a message that does not pass DKIM or SPF, or from which
 * one customer cannot be picked out with certainty, is dropped and counted, never guessed at.
 */

/** A received message, as much of it as a receipt is read from. */
export interface ReceiptIn {
  /** The first `Authentication-Results` header: Cloudflare's own, prepended on arrival. */
  authentication_results: string | null;
  /** The `From:` header. */
  from: string | null;
  /** The envelope sender (`MAIL FROM`). Empty for a bounce. */
  envelope_from: string;
  /** The `To:` header. */
  to: string | null;
  /** The `Date:` header. */
  date: string | null;
  /** When it arrived. */
  received: Date;
}

/** What a receipt is read against: the business it was copied for. */
export interface ReceiptFor {
  website: string | null;
  /** Where a customer's reply goes: the business's own address. */
  reply_to: string;
  /** The location's IANA time zone. */
  time_zone: string | null;
}

/** What is kept from a receipt: who sent it, the one customer, and the local day of the job. */
export interface ReadReceipt {
  sender: string;
  customer: string;
  /** As `YYYY-MM-DD`, in the location's time zone. */
  job_day: string;
}

/**
 * Reads a receipt for a location: what is kept from it, or why it is dropped. A sender declined,
 * and review requests that are off, are the caller's to check: they are on file, not in the
 * message.
 */
export function readReceipt(
  message: ReceiptIn,
  business: ReceiptFor,
): { kept: ReadReceipt } | { dropped: ReceiptDrop } {
  const sender = senderOf(message);
  if (sender === null || !passesForSender(message.authentication_results, sender)) {
    return { dropped: "unauthenticated" };
  }
  const named = message.to === null ? null : addressesIn(message.to);
  const customers = (named ?? []).filter(
    (address) => !isProducts(address) && !isBusinessOwn(address, sender, business),
  );
  const [customer] = customers;
  if (named === null || customer === undefined) return { dropped: "no_customer" };
  if (customers.length > 1) return { dropped: "several_customers" };
  return {
    kept: {
      sender,
      customer,
      job_day: dayIn(jobTime(message.date, message.received), business.time_zone ?? "UTC"),
    },
  };
}

/**
 * Whether Cloudflare found the message passed DKIM or SPF for its sender's own domain: DMARC
 * passed, which says as much, or a DKIM signature (`header.d`, or else `header.i`) or the SPF
 * check (`smtp.mailfrom`) passed for the sender's domain, a domain above it or one below it.
 * A pass for any other domain says nothing about who the sender is, so a receipt could otherwise
 * carry a confirmed sender's address from anywhere.
 *
 * Only the first `Authentication-Results` header is Cloudflare's, prepended when the message
 * arrived: any after it came with the message. A header that reads any other way counts as
 * neither.
 */
function passesForSender(results: string | null, sender: string): boolean {
  if (!results) return false;
  // Comments say nothing a result rests on. A comment within a comment is not read at all.
  const bare = results.replace(/\((?:[^()\\]|\\.)*\)/g, " ");
  if (/[()]/.test(bare)) return false;
  // Several headers of the name are joined with commas; Cloudflare's is the first.
  const [own = ""] = bare.split(",");
  const [service, ...found] = own.split(";").map((part) => part.trim());
  if (service?.toLowerCase() !== "mx.cloudflare.net") return false;
  const domain = domainOf(sender);
  return found.some((result) => {
    const [method, ...properties] = result.split(/\s+/);
    const passed = /^(dkim|spf|dmarc)=pass$/i.exec(method ?? "")?.[1]?.toLowerCase();
    if (passed === "dmarc") return true;
    if (passed === undefined) return false;
    const property = (name: string) =>
      properties
        .find((p) => p.toLowerCase().startsWith(`${name}=`))
        ?.slice(name.length + 1)
        .toLowerCase();
    const signed =
      passed === "dkim"
        ? (property("header.d") ?? property("header.i"))
        : property("smtp.mailfrom");
    if (!signed) return false;
    const by = domainOf(signed);
    return within(domain, by) || within(by, domain);
  });
}

/** The sender: the one address `From:` names, or else the envelope's. */
function senderOf(message: ReceiptIn): string | null {
  const from = message.from === null ? null : addressesIn(message.from);
  if (from?.length === 1 && from[0]) return from[0];
  const envelope = addressesIn(message.envelope_from);
  return envelope?.length === 1 && envelope[0] ? envelope[0] : null;
}

/** The product's own domain, and every name under it. */
const PRODUCT_DOMAIN = RECEIPTS_DOMAIN.split(".").slice(-2).join(".");

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);
const within = (domain: string, of: string) => domain === of || domain.endsWith(`.${of}`);

function isProducts(address: string): boolean {
  return within(domainOf(address), PRODUCT_DOMAIN);
}

/** The business's own: its tool that sent the receipt, its reply address and its website's mail. */
function isBusinessOwn(address: string, sender: string, business: ReceiptFor): boolean {
  if (address === sender || address === business.reply_to.trim().toLowerCase()) return true;
  const host = websiteHost(business.website);
  return host !== null && within(domainOf(address), host);
}

function websiteHost(website: string | null): string | null {
  if (!website) return null;
  try {
    return new URL(website).hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** One address, as this reads it: no quoted or bracketed part, and a dot in the domain. */
const ADDRESS = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[^\s@<>()[\]",;:\\.]+$/;
/** A mailbox with a display name: the address is what is in the angle brackets. */
const NAMED = /^(?:"(?:[^"\\]|\\.)*"|[^<>"])*<([^<>]*)>$/;

/**
 * The addresses an address header names, in lower case and each once, in the order named. Reads
 * display names, quoted strings, comments and groups (RFC 5322). Null where any part of it
 * cannot be read with certainty.
 */
export function addressesIn(header: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let comment = 0;
  let angled = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i] ?? "";
    if (quoted) {
      current += ch;
      if (ch === "\\") current += header[++i] ?? "";
      else if (ch === '"') quoted = false;
      continue;
    }
    if (comment > 0) {
      if (ch === "\\") i++;
      else if (ch === "(") comment++;
      else if (ch === ")") comment--;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "(") {
      comment = 1;
      continue;
    } else if (ch === "<") {
      if (angled) return null;
      angled = true;
    } else if (ch === ">") {
      if (!angled) return null;
      angled = false;
    } else if (!angled && (ch === "," || ch === ";")) {
      parts.push(current);
      current = "";
      continue;
    } else if (!angled && ch === ":") {
      // A group's name. Its members follow, up to the `;`.
      current = "";
      continue;
    }
    current += ch;
  }
  if (quoted || comment > 0 || angled) return null;
  parts.push(current);

  const addresses: string[] = [];
  for (const part of parts.map((p) => p.trim())) {
    if (part === "") continue;
    const address = (NAMED.exec(part)?.[1] ?? part).trim().toLowerCase();
    if (!ADDRESS.test(address)) return null;
    if (!addresses.includes(address)) addresses.push(address);
  }
  return addresses;
}

const DAY_MS = 86_400_000;

/** When the job was: the receipt's `Date`, unless that is missing, unreadable or in the future. */
function jobTime(date: string | null, received: Date): Date {
  const sent = date === null ? null : new Date(date);
  return sent && !Number.isNaN(sent.getTime()) && sent.getTime() <= received.getTime() + DAY_MS
    ? sent
    : received;
}

/** The day a moment falls on in a time zone, as `YYYY-MM-DD`. */
function dayIn(moment: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(moment);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * A customer's address as every member and the operator see it: the first letter of the name and
 * the domain. The database writes the same in `customer_contacts.masked`, and a test holds the two
 * together.
 */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf("@");
  return `${address.slice(0, 1)}•••@${address.slice(at + 1)}`;
}

/** The made-up tool a sample location's receipts come from. */
export const SAMPLE_SENDER = "receipts@example.com";

/**
 * Made-up receipts for the day before `now` in a location's time zone, for a test organization
 * and a deployment on sample data: one to three customers at `example.com`, from
 * `SAMPLE_SENDER`. The same location and day always give the same ones, so making them again
 * keeps nothing more. Nobody was served.
 */
export function sampleReceipts(
  locationId: string,
  timeZone: string | null,
  now: Date,
): ReadReceipt[] {
  const day = dayIn(new Date(now.getTime() - DAY_MS), timeZone ?? "UTC");
  const count = (hashOf(`receipts|${locationId}|${day}`) % 3) + 1;
  return Array.from({ length: count }, (_, i) => ({
    sender: SAMPLE_SENDER,
    customer: `customer-${hashOf(`receipts|${locationId}|${day}|${i}`) % 100_000}@example.com`,
    job_day: day,
  }));
}
