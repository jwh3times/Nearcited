import { type LocationReceipts, RECEIPT_DROPS_DAYS } from "@nearcited/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { notFound } from "../errors";
import { uuidParam } from "../validation";
import { requireLocation } from "./locations";

/**
 * A location's receipts (issue #291, part of #146): the senders that copy receipts to its receipt
 * address, the customer contacts kept from them, masked, and how many receipts were dropped. Any
 * member and the operator read them; only an owner or admin confirms or declines a sender. No
 * route carries a contact's full address
 * (`docs/adr/0031-a-customer-contact-is-read-only-by-the-worker.md`).
 */
export const receiptRoutes = new Hono<AppEnv>();

/** The first day whose dropped receipts a location's page counts, as `YYYY-MM-DD` (UTC). */
const droppedSince = () =>
  new Date(Date.now() - RECEIPT_DROPS_DAYS * 86_400_000).toISOString().slice(0, 10);

/** A location's receipts, for anyone who can read the location. */
receiptRoutes.get("/locations/:locationId/receipts", async (c) => {
  const store = c.get("store");
  const location = await requireLocation(store, uuidParam(c, "locationId", "Location"));
  const [read, canManage] = await Promise.all([
    store.getLocationReceipts(location.id, droppedSince()),
    store.managesConnections(location.organization_id),
  ]);
  return c.json({ ...read, can_manage: canManage } satisfies LocationReceipts);
});

/**
 * Confirms a waiting sender as the business's own tool: what it sent that was held becomes ready.
 * Owner or admin only; to anyone else, and for a sender already decided, there is no such sender.
 */
receiptRoutes.post("/receipt-senders/:senderId/confirm", async (c) => {
  const sender = await c.get("store").confirmReceiptSender(uuidParam(c, "senderId", "Sender"));
  if (!sender) throw notFound("Sender");
  return c.json(sender);
});

/** Declines a waiting sender: what it sent that was held is deleted. As for confirming. */
receiptRoutes.post("/receipt-senders/:senderId/decline", async (c) => {
  const sender = await c.get("store").declineReceiptSender(uuidParam(c, "senderId", "Sender"));
  if (!sender) throw notFound("Sender");
  return c.json(sender);
});
