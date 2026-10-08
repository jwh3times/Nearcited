import type { ScanMessage } from "@nearcited/shared";
import { type Store, StoreError } from "../store/types";

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
    try {
      const scan = await store.createScan(locationId, "scheduled", null);
      messages.push({ body: { scan_id: scan.id } });
    } catch (error) {
      // Someone started a manual scan between the due list and now. That scan will do.
      if (error instanceof StoreError && error.kind === "conflict") continue;
      throw error;
    }
  }
  if (messages.length > 0) await queue.sendBatch(messages);
  return messages.length;
}

/** How long a scan may sit queued or running, or an audit queued, before it is given up on. */
export const STALE_AFTER_MS = 30 * 60 * 1000;

const ABANDONED = "The scan did not finish and was abandoned. Run it again.";

/**
 * Fails scans that have been in flight too long, so their locations can be scanned again.
 * Returns how many.
 *
 * A scan ends up here when its queue message was never sent or was lost, or when the worker was
 * cut off mid-scan. A queue invocation is limited to fifteen minutes, so a scan still in flight
 * after thirty is not coming back. If its message does turn up later, the scan simply runs.
 */
export async function failStaleScans(store: Store, now: Date = new Date()): Promise<number> {
  return store.failStaleScans(new Date(now.getTime() - STALE_AFTER_MS).toISOString(), ABANDONED);
}

const UNFINISHED = "Some prompts could not be checked.";

/**
 * Fails audits that are still waiting on a prompt long after they were made. Returns how many.
 *
 * Each prompt is its own queue message. One that runs out of retries never reports, and a later
 * success from another prompt puts the audit back to queued, so nothing else would end it. The
 * prompts that did report stay on the audit and the page goes on showing them. If the missing
 * one does turn up later, the audit becomes ready.
 */
export async function failStaleAudits(store: Store, now: Date = new Date()): Promise<number> {
  return store.failStaleAudits(new Date(now.getTime() - STALE_AFTER_MS).toISOString(), UNFINISHED);
}
