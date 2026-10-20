import { buildActionNoticeEmail, type NoticedAction } from "../email/action-notice";
import type { Email } from "../email/report";
import type { ActionToTell, PermissionToTell, Store } from "../store/types";

export interface NoticeDeps {
  store: Store;
  /** Sends an email. Absent where outgoing email is not set up, and then nobody is told. */
  send?: (to: string[], email: Email) => Promise<void>;
  appUrl: string;
  /** True where this deployment's data is generated, so nothing an action did left the product. */
  sampleData?: boolean;
  now?: Date;
}

/**
 * Tells each organization's owners, in one message, what was carried out for it since the last
 * and what is newly waiting for a yes, and any standing permission given or ended since. The daily
 * run calls it, so every action is told within about a day, well inside the 48 hours. A
 * permission given or ended holds nothing up while it is untold: only actions do.
 *
 * A test organization is never written to: its actions are marked told, since the record on its
 * page is the notice. The same goes for a deployment on sample data that has no email to send
 * with, where an action changes nothing outside the product. Anywhere else, where there is no
 * email to send with, or nobody to send to, nothing is marked: untold is not the same as told,
 * and after 36 hours the organization is held and the operator is shown it.
 *
 * Returns how many organizations were told.
 */
export async function sendActionNotices({
  store,
  send,
  appUrl,
  sampleData,
  now,
}: NoticeDeps): Promise<number> {
  const at = (now ?? new Date()).toISOString();
  const byOrganization = new Map<string, ActionToTell[]>();
  for (const row of await store.listActionsToTell()) {
    byOrganization.set(row.organization_id, [
      ...(byOrganization.get(row.organization_id) ?? []),
      row,
    ]);
  }
  const permissionsOf = new Map<string, PermissionToTell[]>();
  for (const row of await store.listPermissionsToTell()) {
    permissionsOf.set(row.organization_id, [
      ...(permissionsOf.get(row.organization_id) ?? []),
      row,
    ]);
    if (!byOrganization.has(row.organization_id)) byOrganization.set(row.organization_id, []);
  }

  let told = 0;
  for (const [organizationId, rows] of byOrganization) {
    const organization = await store.getOrganization(organizationId);
    if (!organization) continue;
    const pick = (status: "done" | "proposed"): NoticedAction[] =>
      rows.filter((row) => row.action.status === status);
    const done = pick("done");
    const waiting = pick("proposed");
    const permissions = permissionsOf.get(organizationId) ?? [];
    const given = permissions.filter((row) => row.given_untold).map((row) => row.permission);
    // A take-back that ended one is named by what it took back.
    const ended = await Promise.all(
      permissions
        .filter((row) => row.ended_untold)
        .map(async ({ permission }) => ({
          ...permission,
          taken_back: permission.ended_by_action
            ? ((await store.getAction(permission.ended_by_action))?.summary ?? null)
            : null,
        })),
    );
    const mark = async () => {
      await store.markPermissionsTold(
        given.map((permission) => permission.id),
        "given",
        at,
      );
      await store.markPermissionsTold(
        ended.map((permission) => permission.id),
        "ended",
        at,
      );
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

    if (organization.is_test || (sampleData && !send)) {
      await mark();
      continue;
    }
    if (!send) continue;
    const owners = await store.listOwnerEmails(organizationId);
    if (owners.length === 0) continue;
    try {
      await send(
        owners,
        buildActionNoticeEmail({
          organization: organization.name,
          done,
          waiting,
          given,
          ended,
          appUrl,
        }),
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
