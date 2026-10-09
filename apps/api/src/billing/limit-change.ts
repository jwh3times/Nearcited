import type { LimitChange, LimitChangeMessage, LimitChangeStep } from "@nearcited/shared";
import { buildLimitChangeEmail } from "../email/limit-change";
import type { Email } from "../email/report";
import type { Store } from "../store/types";
import { REMINDER_MS } from "./price-change";

export interface LimitChangeDeps {
  /** The worker's store. */
  store: Store;
  /** Sends an email to an organization's owners. Throws when it could not be sent. */
  send: (to: string[], email: Email) => Promise<void>;
  appUrl: string;
  now?: Date;
}

export type LimitStepOutcome = "told" | "reminded" | "told it is off" | "nothing to do" | "waiting";

/**
 * Tells one organization one thing about a reduction in what its plan allows: that it is
 * coming (or, on the free plan, that it has been made), that it is a week away, or that it has
 * been called off. Each is said once. An organization that has left the plan is told nothing.
 */
export async function runLimitChangeStep(
  message: LimitChangeMessage,
  deps: LimitChangeDeps,
): Promise<LimitStepOutcome> {
  const { store } = deps;
  const now = (deps.now ?? new Date()).toISOString();
  const { limit_change_id: id, organization_id: organizationId, step } = message;
  const change = await store.getLimitChange(id);
  const organization = await store.getOrganization(organizationId);
  if (!change || organization?.plan_key !== change.plan_key) return "nothing to do";
  const notice = (await store.listLimitChangeNotices(id)).find(
    (kept) => kept.organization_id === organizationId,
  );

  // A reduction already made is the free plan's: there is no day to wait for or to call off.
  const made = change.completed_at !== null;
  if (step === "announce") {
    if (notice?.announced_at || change.called_off_at) return "nothing to do";
  } else if (step === "remind") {
    if (!notice?.announced_at || notice.reminded_at || change.called_off_at || made) {
      return "nothing to do";
    }
  } else if (!notice?.announced_at || notice.called_off_at) {
    return "nothing to do";
  }

  const [owners, plans] = await Promise.all([
    store.listOwnerEmails(organizationId),
    store.listPlans(),
  ]);
  // Nobody to tell is not the same as told. The operator is shown who was not.
  if (owners.length === 0) return "waiting";
  await deps.send(
    owners,
    buildLimitChangeEmail({
      kind: step === "announce" && made ? "made" : step,
      organization: organization.name,
      plan: plans.find((plan) => plan.key === change.plan_key)?.name ?? change.plan_key,
      lowered: change.lowered,
      effective_at: change.effective_at,
      appUrl: deps.appUrl,
    }),
  );
  const field = { announce: "announced_at", remind: "reminded_at", call_off: "called_off_at" };
  await store.recordLimitChangeNotice(id, organizationId, { [field[step]]: now });
  return step === "announce" ? "told" : step === "remind" ? "reminded" : "told it is off";
}

/** The one queue method used here. `env.SCAN_QUEUE` satisfies it. */
export interface LimitChangeQueue {
  sendBatch(messages: Iterable<{ body: LimitChangeMessage }>): Promise<unknown>;
}

/** Cloudflare Queues accepts at most 100 messages per sendBatch call. */
const BATCH_LIMIT = 100;

export async function enqueueLimitChangeSteps(
  queue: LimitChangeQueue,
  change: Pick<LimitChange, "id">,
  organizationIds: readonly string[],
  step: LimitChangeStep,
): Promise<void> {
  for (let from = 0; from < organizationIds.length; from += BATCH_LIMIT) {
    await queue.sendBatch(
      organizationIds.slice(from, from + BATCH_LIMIT).map((organization_id) => ({
        body: { limit_change_id: change.id, organization_id, step },
      })),
    );
  }
}

/**
 * The daily look at every announced reduction. A week before its day the reminders are queued,
 * once. On the day it is made, for the plan and everyone on it together: a plan has one set of
 * limits, so nobody is left behind on the old ones. Returns how many reductions were made.
 */
export async function advanceLimitChanges(
  store: Store,
  queue: LimitChangeQueue,
  now: Date = new Date(),
): Promise<number> {
  let made = 0;
  for (const change of await store.listOpenLimitChanges()) {
    const effective = Date.parse(change.effective_at);
    if (now.getTime() >= effective) {
      if (await store.applyLimitChange(change.id)) made += 1;
    } else if (!change.reminded_at && now.getTime() >= effective - REMINDER_MS) {
      const organizations = await store.listPlanOrganizations(change.plan_key);
      await enqueueLimitChangeSteps(queue, change, organizations, "remind");
      await store.markLimitChangeReminded(change.id, now.toISOString());
    }
  }
  return made;
}
