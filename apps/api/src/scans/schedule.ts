import type { ScanMessage } from "@nearcited/shared";
import type { Store } from "../store/types";

/** Cloudflare Queues accepts at most 100 messages per sendBatch call. */
const BATCH_LIMIT = 100;

/** The one queue method the scheduler uses. `env.SCAN_QUEUE` satisfies it. */
export interface ScanQueue {
  sendBatch(messages: Iterable<{ body: ScanMessage }>): Promise<unknown>;
}

/**
 * Queues a scheduled scan for every location that is due. Returns how many were queued.
 * Locations beyond the limit wait for the next run; they sort oldest-scan-first, so none starve.
 */
export async function enqueueDueScans(
  store: Store,
  queue: ScanQueue,
  limit = BATCH_LIMIT,
): Promise<number> {
  const locationIds = await store.listLocationsDueForScan(Math.min(limit, BATCH_LIMIT));
  if (locationIds.length === 0) return 0;

  const messages: { body: ScanMessage }[] = [];
  for (const locationId of locationIds) {
    const scan = await store.createScan(locationId, "scheduled", null);
    messages.push({ body: { scan_id: scan.id } });
  }
  await queue.sendBatch(messages);
  return messages.length;
}
