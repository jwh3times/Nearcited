import {
  type DraftKind,
  type DraftMessage,
  draftRequest,
  factsNobodyGave,
  NO_DRAFT,
} from "@nearcited/shared";
import type { Env } from "../env";
import { usageTally } from "../providers/usage";
import type { Store } from "../store/types";
import { currentTasks } from "../tasks";
import { type DraftWriter, sampleWriter } from "./sample";

/**
 * Drafts: the wording written for a task (docs/adr/0016-the-worker-writes-a-draft.md).
 *
 * Everything here runs in the worker. A request records that a member asked. Writing takes one
 * from the month's allowance and, on real data, calls a model, and neither is a member's to do.
 */

export interface DraftDeps {
  store: Store;
  /** True where this deployment makes no real requests: every draft is sample text. */
  sampleData: boolean;
  /** What writes a real draft. Absent where this deployment has nothing to write one with. */
  writer?: DraftWriter;
}

/** How many times a draft is tried, when something other than the writing goes wrong. */
const MOST_ATTEMPTS = 3;
/** How many times a draft is written before it is given up: once, and once more if it fails the check. */
const MOST_WRITES = 2;

export type Wrote = "written" | "failed" | "again" | "busy";

/**
 * What a draft of `kind` is written with: sample text for sample data, else whatever writes a
 * real one of that kind here. Null where nothing does.
 */
export function writerFor(
  sample: boolean,
  writer: DraftWriter | undefined,
  kind: DraftKind,
): DraftWriter | null {
  const chosen = sample ? sampleWriter : writer;
  return chosen?.kinds.includes(kind) ? chosen : null;
}

/**
 * Whether a real draft of `kind` can be written here: the build has instructions for it, which
 * come only with the private tuning, and a key to ask with. What the route refuses on, so nobody
 * waits for a draft that cannot come.
 */
export function writesRealDrafts(
  env: Pick<Env, "ANTHROPIC_API_KEY">,
  kinds: readonly DraftKind[] | undefined,
  kind: DraftKind,
): boolean {
  return Boolean(env.ANTHROPIC_API_KEY) && (kinds?.includes(kind) ?? false);
}

/**
 * Writes the draft a member asked for. The task, the page it is about and the location's details
 * are read here, from what is on file, so nothing a request said decides what the draft is
 * written from.
 *
 * A draft is checked by rule before it is kept (`factsNobodyGave`). One that states a number, a
 * web address or an email address nobody gave is thrown away and written once more, and if that
 * fails too nothing is kept. A draft that was not written gives back what it took from the month.
 */
export async function writeDraft(draftId: string, deps: DraftDeps): Promise<Wrote> {
  const { store } = deps;
  const attempt = await store.claimDraft(draftId);
  if (attempt === 0) return "busy";
  const fail = async (why: string): Promise<Wrote> => {
    await store.finishDraft(draftId, { outcome: "failed", why });
    return "failed";
  };

  try {
    const draft = await store.getDraft(draftId);
    const location = draft && (await store.getLocation(draft.location_id));
    const organization = location && (await store.getOrganization(location.organization_id));
    if (!draft || !location || !organization) return fail("The task is no longer there.");

    const sample = deps.sampleData || organization.is_test;
    const task = (await currentTasks(store, location, sample)).find(
      (candidate) => candidate.id === draft.recommendation_id,
    );
    const request = draftRequest(location, task);
    if (typeof request === "string") return fail(NO_DRAFT[request]);
    const writer = writerFor(sample, deps.writer, request.kind);
    if (!writer) return fail("Drafts cannot be written here yet.");

    // What the writing used is kept whether the draft is or not: a draft that was thrown away
    // was still paid for.
    const used = usageTally();
    const keepUsage = async () => {
      try {
        await store.recordUsage(
          { organization_id: organization.id, draft_id: draftId },
          used.take(),
        );
      } catch (error) {
        // Losing the record must not change what happens to the draft.
        console.error(`Draft ${draftId} could not record what it used`, error);
      }
    };

    for (let write = 1; write <= MOST_WRITES; write += 1) {
      let text: string;
      try {
        text = (await writer.write(request, used.on(null))).trim();
      } catch (error) {
        console.error(`Draft ${draftId}: it could not be written`, error);
        return fail("It could not be written. Nothing was counted.");
      } finally {
        // After each write, so one that failed is recorded as much as one that did not.
        await keepUsage();
      }
      const unknown = text === "" ? ["nothing"] : factsNobodyGave(text, request.given);
      if (unknown.length === 0) {
        await store.finishDraft(draftId, {
          outcome: "written",
          text,
          kind: request.kind,
          model: writer.model,
          sample_data: sample,
        });
        return "written";
      }
      // What it said is not logged: only how much of it nobody gave.
      console.warn(`Draft ${draftId}: write ${write} stated ${unknown.length} things nobody gave`);
    }
    return fail(
      "It stated something about the business that nobody gave, twice, so it was thrown away. Nothing was counted.",
    );
  } catch (error) {
    console.error(`Draft ${draftId}: a try at writing it failed`, error);
    if (attempt >= MOST_ATTEMPTS) return fail("It could not be written. Nothing was counted.");
    await store.finishDraft(draftId, { outcome: "again", why: "It could not be written yet." });
    return "again";
  }
}

/** The one queue method used here. `env.SCAN_QUEUE` satisfies it. */
type DraftQueue = Pick<Queue<DraftMessage>, "sendBatch">;

/**
 * How long an ask may sit before it is queued again. Longer than the ten minutes a worker's hold
 * on one lasts, so one a worker took and died with can be taken by the next.
 */
const STALLED_AFTER_MS = 15 * 60_000;

/**
 * Queues again every draft asked for that nobody is writing: its message was lost, the worker let
 * go of it to be tried again, or the worker that took it died. Returns how many.
 */
export async function requeueStalledDrafts(
  store: Store,
  queue: DraftQueue,
  now = Date.now(),
): Promise<number> {
  const stalled = await store.listStalledDrafts(new Date(now - STALLED_AFTER_MS).toISOString());
  if (stalled.length === 0) return 0;
  await queue.sendBatch(
    stalled.slice(0, 100).map((id) => ({ body: { draft_id: id, step: "write" as const } })),
  );
  return Math.min(stalled.length, 100);
}
