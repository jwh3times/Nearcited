import { buildActionNoticeEmail, type NoticedAction } from "../email/action-notice";
import type { Email } from "../email/report";
import type { ActionToTell, Store } from "../store/types";

export interface NoticeDeps {
  store: Store;
  /** Sends an email. Absent where outgoing email is not set up, and then nobody is told. */
  send?: (to: string[], email: Email) => Promise<void>;
  appUrl: string;
  now?: Date;
}

/**
 * Tells each organization's owners, in one message, what was carried out for it since the last
 * and what is newly waiting for a yes. The daily run calls it, so every action is told within
 * about a day, well inside the 48 hours.
 *
 * A test organization is never written to: its actions are marked told, since the record on its
 * page is the notice. Where there is no email to send with, or nobody to send to, nothing is
 * marked: untold is not the same as told, and after 36 hours the organization is held and the
 * operator is shown it.
 *
 * Returns how many organizations were told.
 */
export async function sendActionNotices({ store, send, appUrl, now }: NoticeDeps): Promise<number> {
  const at = (now ?? new Date()).toISOString();
  const byOrganization = new Map<string, ActionToTell[]>();
  for (const row of await store.listActionsToTell()) {
    byOrganization.set(row.organization_id, [
      ...(byOrganization.get(row.organization_id) ?? []),
      row,
    ]);
  }

  let told = 0;
  for (const [organizationId, rows] of byOrganization) {
    const organization = await store.getOrganization(organizationId);
    if (!organization) continue;
    const pick = (status: "done" | "proposed"): NoticedAction[] =>
      rows.filter((row) => row.action.status === status);
    const done = pick("done");
    const waiting = pick("proposed");
    const mark = async () => {
      await store.markActionsTold(
        done.map((row) => row.action.id),
        "done",
        at,
      );
      await store.markActionsTold(
        waiting.map((row) => row.action.id),
        "waiting",
        at,
      );
    };

    if (organization.is_test) {
      await mark();
      continue;
    }
    if (!send) continue;
    const owners = await store.listOwnerEmails(organizationId);
    if (owners.length === 0) continue;
    try {
      await send(
        owners,
        buildActionNoticeEmail({ organization: organization.name, done, waiting, appUrl }),
      );
    } catch (error) {
      // One organization's failed email must not stop the others being told.
      console.error(`Organization ${organizationId}: its action notice could not be sent`, error);
      continue;
    }
    await mark();
    told++;
  }
  return told;
}
