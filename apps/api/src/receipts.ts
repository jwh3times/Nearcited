import { type ReceiptDrop, readReceipt, receiptName, sampleReceipts } from "@nearcited/shared";
import type { ReceiptOutcome, Store } from "./store/types";

/**
 * Receiving receipts copied to a location's receipt address (issue #291, part of #146,
 * `docs/adr/0031-a-customer-contact-is-read-only-by-the-worker.md`). The Worker's `email` handler
 * is the entry point: Cloudflare Email Routing hands it every message to the receipts mailbox and
 * its subaddresses, with no signed-in user, and it acts as the worker.
 */

/** A received message, as the email handler is given it. */
export interface InboundEmail {
  /** The envelope recipient: the receipt address. */
  to: string;
  /** The envelope sender. */
  from: string;
  headers: Pick<Headers, "get">;
}

export interface ReceiveDeps {
  store: Store;
  /** True where this deployment's data is generated: nothing is received. */
  sampleData: boolean;
  now?: Date;
}

/**
 * What became of a message: kept as a contact, `ready` or `held`; dropped and counted for its
 * location, for the reason; `sample`, not received, for a test organization or a deployment on
 * sample data; or `unknown`, for an address that is nobody's, which the handler refuses.
 */
export type Received = ReceiptOutcome | ReceiptDrop | "sample";

/**
 * Receives one message to the receipts mailbox. One to an address that is not a receipt address
 * (`receiptName`), or is nobody's, is `unknown`. A receipt that passes DKIM or SPF and names one
 * customer, for review requests that are on, is kept as a contact: held until an owner or admin
 * confirms its sender, ready from a confirmed one. Anything else is dropped and counted for its
 * location, and nothing of it is kept.
 */
export async function receiveEmail(message: InboundEmail, deps: ReceiveDeps): Promise<Received> {
  const { store } = deps;
  const name = receiptName(message.to);
  const owner = name === null ? null : await store.findReceiptAddress(name);
  if (!owner) return "unknown";
  // Their receipts are generated, when the review requests sync.
  if (deps.sampleData || owner.is_test) return "sample";

  const read = readReceipt(
    {
      authentication_results: message.headers.get("authentication-results"),
      from: message.headers.get("from"),
      envelope_from: message.from,
      to: message.headers.get("to"),
      date: message.headers.get("date"),
      received: deps.now ?? new Date(),
    },
    owner,
  );
  const drop = async (reason: ReceiptDrop) => {
    await store.recordReceiptDrop(owner.location_id, reason);
    return reason;
  };
  // Not shown to come from its sender, then off, then what the receipt itself says.
  if ("dropped" in read && read.dropped === "unauthenticated") return drop(read.dropped);
  if (!owner.on) return drop("not_on");
  if ("dropped" in read) return drop(read.dropped);
  return store.receiveReceipt({
    connection_id: owner.connection_id,
    ...read.kept,
    sample: false,
  });
}

/**
 * Makes up the day's receipts for a test organization's review requests, or any on a deployment
 * on sample data, as though its owner's tool had copied them: from a sender that waits to be
 * confirmed like any other. Nothing is received. Returns how many were kept.
 */
export async function receiveSampleReceipts(
  connectionId: string,
  location: { id: string; time_zone: string | null },
  { store, now }: { store: Store; now?: Date },
): Promise<number> {
  let kept = 0;
  for (const receipt of sampleReceipts(location.id, location.time_zone, now ?? new Date())) {
    const outcome = await store.receiveReceipt({
      connection_id: connectionId,
      ...receipt,
      sample: true,
    });
    if (outcome === "ready" || outcome === "held") kept++;
  }
  return kept;
}
