import {
  CONNECTION_KIND_ALLOWANCES,
  type Connection,
  type ConnectionChoice,
  type ConnectionKind,
  type ConnectionMessage,
  type Organization,
  REDIRECTED_FOR_DAYS,
  SERVED_AFTER_PAUSE_DAYS,
} from "@nearcited/shared";
import { type AnswerSubdomainEmail, buildAnswerSubdomainEmail } from "../email/answer-subdomain";
import { buildConnectionBrokenEmail } from "../email/connection-broken";
import type { Email } from "../email/report";
import type { Env } from "../env";
import { usesSampleData } from "../providers";
import { fetchSite } from "../site/fetch";
import type { Store } from "../store/types";
import {
  type Cloudflare,
  type HostedDeps,
  hostnameLive,
  linksTo,
  lookUp,
  registerHostname,
  unregisterHostname,
} from "./hosted";
import { open } from "./seal";
import {
  readSite,
  type WordPressDeps,
  WordPressRefused,
  type WordPressSignIn,
  withdrawPassword,
} from "./wordpress";

/**
 * The kinds of account an organization can connect in this deployment. None without a key to
 * seal the sign-in with, and none its allowances do not include. `sample` only where the data is
 * generated: a deployment on sample data, or a test organization in any deployment.
 */
export function availableConnectionKinds(
  env: Pick<Env, "CONNECTIONS_KEY" | "PROVIDER_MODE">,
  organization: Pick<Organization, "is_test" | "allowances">,
): ConnectionKind[] {
  if (!env.CONNECTIONS_KEY) return [];
  // A real account is written to, so it is offered only where nothing is generated: a test
  // organization's actions never leave the product, and nor do a sample deployment's.
  const offered: ConnectionKind[] =
    usesSampleData(env) || organization.is_test ? ["sample"] : ["wordpress"];
  return offered.filter((kind) => {
    const needed = CONNECTION_KIND_ALLOWANCES[kind];
    return needed === null || organization.allowances[needed] !== undefined;
  });
}

/**
 * Whether this deployment can register an answer subdomain to be served: it holds a token for
 * Cloudflare's custom hostnames and the zone they go on.
 */
export const hostingConfigured = (
  env: Pick<Env, "CLOUDFLARE_HOSTNAMES_TOKEN" | "CLOUDFLARE_ZONE_ID">,
): boolean => Boolean(env.CLOUDFLARE_HOSTNAMES_TOKEN && env.CLOUDFLARE_ZONE_ID);

/** What connecting an account comes to: what to call it, and the sign-in to keep. */
export interface Connected {
  label: string;
  signIn: string;
}

/**
 * Signs in to an account of a kind connected with one press. The sample kind has nowhere to sign
 * in to, so it makes one up. A WordPress site is connected by its owner approving on the site
 * itself, which `signInWith` (`./wordpress.ts`) takes it from, so it is not connected here.
 */
export async function connect(_kind: "sample"): Promise<Connected> {
  return { label: "Sample account", signIn: `sample-${crypto.randomUUID()}` };
}

/** A WordPress sign-in as it is sealed. */
export const wordpressSignIn = (signIn: WordPressSignIn): string => JSON.stringify(signIn);

/** A WordPress sign-in as it was sealed. Throws where what was kept is not one. */
export function readWordPressSignIn(kept: string): WordPressSignIn {
  const signIn = JSON.parse(kept) as Partial<WordPressSignIn>;
  if (
    typeof signIn.site !== "string" ||
    typeof signIn.api !== "string" ||
    typeof signIn.user !== "string" ||
    typeof signIn.password !== "string"
  ) {
    throw new Error("What was kept is not a WordPress sign-in.");
  }
  return {
    ...signIn,
    uuid: typeof signIn.uuid === "string" ? signIn.uuid : null,
  } as WordPressSignIn;
}

/** What a sync finds: the things the sign-in reaches, for a location to be matched to one. */
export interface Reached {
  choices: ConnectionChoice[];
}

/** The sample account reaches three listings that exist nowhere, and are named as such. */
const SAMPLE_CHOICES: ConnectionChoice[] = [
  { id: "sample-listing-1", label: "Sample listing: Main Street" },
  { id: "sample-listing-2", label: "Sample listing: Riverside" },
  { id: "sample-listing-3", label: "Sample listing: Uptown" },
];

/**
 * Thrown by a read when the outside service refuses the sign-in: the password changed, or the
 * access was taken away there. Trying again will not help, so the connection breaks at once.
 */
export class SignInRefused extends Error {
  constructor(message = "The outside service refused the sign-in.") {
    super(message);
    this.name = "SignInRefused";
  }
}

/** Reads from an account of one kind with its sign-in. The sample kind asks nobody anything. */
async function read(
  kind: ConnectionKind,
  signIn: string,
  outside: WordPressDeps,
): Promise<Reached> {
  switch (kind) {
    case "sample":
      return { choices: SAMPLE_CHOICES };
    case "wordpress":
      try {
        return { choices: await readSite(readWordPressSignIn(signIn), outside) };
      } catch (error) {
        if (error instanceof WordPressRefused) throw new SignInRefused(error.message);
        throw error;
      }
    case "hosted_pages":
      // Checked, not read: `checkAnswerSubdomain`.
      return { choices: [] };
  }
}

/** Takes back, at the outside service, the access a sign-in gave. The sample kind gave none. */
async function withdraw(
  kind: ConnectionKind,
  signIn: string,
  outside: WordPressDeps,
): Promise<void> {
  switch (kind) {
    case "sample":
      return;
    case "wordpress":
      if (!(await withdrawPassword(readWordPressSignIn(signIn), outside))) {
        // Its copy is deleted all the same: the owner asked for it gone, and nobody then holds it.
        console.warn("A WordPress password could not be taken back at the site.");
      }
      return;
    case "hosted_pages":
      return;
  }
}

/** What the worker needs to do anything with a connection's sign-in. */
export interface ConnectionDeps {
  store: Store;
  /** The key this deployment seals with. Null where none is set. */
  key: CryptoKey | null;
  /** Sends an email. Absent where outgoing email is not set up, and then nobody is told. */
  send?: (to: string[], email: Email) => Promise<void>;
  appUrl?: string;
  /** Reads from the outside service. The tests put a failing one here. */
  read?: (kind: ConnectionKind, signIn: string) => Promise<Reached>;
  /** How an outside service is reached. The tests put a made-up WordPress here. */
  outside?: WordPressDeps;
  /** Where answer subdomains are registered to be served. Absent where nothing is. */
  hosting?: Hosting;
  now?: Date;
}

/** What the worker needs for answer subdomains. */
export interface Hosting extends HostedDeps {
  /** Null where this deployment cannot register a name to be served. */
  cloudflare: Cloudflare | null;
  /** True on sample data, where nothing is looked up or registered. */
  sampleData: boolean;
}

/**
 * Tells a broken connection's owners and admins, or reminds them, and keeps that it did. A test
 * organization's are never written to, and where email is not set up nobody is.
 */
async function tellBroken(
  connection: Connection,
  reminder: boolean,
  { store, send, appUrl, now }: ConnectionDeps,
): Promise<boolean> {
  if (!send || !appUrl || connection.broken_reason === null) return false;
  const organization = await store.getOrganization(connection.organization_id);
  if (!organization || organization.is_test) return false;
  const managers = await store.listManagerEmails(connection.organization_id);
  if (managers.length === 0) return false;
  await send(
    managers,
    buildConnectionBrokenEmail({
      organization: organization.name,
      label: connection.label,
      reason: connection.broken_reason,
      reminder,
      appUrl,
    }),
  );
  await store.markConnectionTold(
    connection.id,
    reminder ? "reminded" : "told",
    (now ?? new Date()).toISOString(),
  );
  return true;
}

/**
 * Finishes removing a connection its owner asked to have removed: withdraws the access at the
 * outside service, then deletes the sign-in. Only the worker can do either, because only it can
 * read the sign-in. Safe to run twice.
 *
 * A sign-in that cannot be opened is deleted all the same: the owner asked for it gone, and one
 * this Worker cannot open is no use to it either.
 */
export async function removeConnection(
  connectionId: string,
  deps: ConnectionDeps,
): Promise<"removed" | "not_waiting"> {
  const { store, key, outside = {} } = deps;
  const connection = await store.getConnection(connectionId);
  if (connection?.status !== "removing") return "not_waiting";
  if (connection.kind === "hosted_pages") return removeAnswerSubdomain(connection, deps);

  const sealed = await store.getConnectionSecret(connectionId);
  if (sealed && key) {
    let signIn: string | null = null;
    try {
      signIn = await open(key, connectionId, sealed);
    } catch (error) {
      console.error(`Connection ${connectionId}: its sign-in could not be opened`, error);
    }
    if (signIn !== null) {
      try {
        await withdraw(connection.kind, signIn, outside);
      } catch (error) {
        // A sign-in kept in a shape this Worker cannot use is deleted all the same.
        console.error(`Connection ${connectionId}: its access could not be taken back`, error);
      }
    }
  }
  return (await store.finishConnectionRemoval(connectionId)) ? "removed" : "not_waiting";
}

/** Keeps that a sync failed, and tells the owners and admins where that broke the connection. */
async function recordFailure(connectionId: string, refused: boolean, deps: ConnectionDeps) {
  const outcome = await deps.store.recordConnectionFailure(connectionId, refused);
  if (!outcome?.newly_broken) return;
  const broken = await deps.store.getConnection(connectionId);
  // A failure to tell must not undo what was recorded: the daily run tells them later.
  if (broken) {
    await tellBroken(broken, false, deps).catch((sendError) =>
      console.error(`Connection ${connectionId}: its owners could not be told`, sendError),
    );
  }
}

/** Queues the worker to finish the removal of each connection whose removal was started. */
async function queueRemovals(
  ids: string[],
  queue: Pick<Queue<ConnectionMessage>, "sendBatch">,
): Promise<number> {
  if (ids.length === 0) return 0;
  await queue.sendBatch(
    ids.map((id) => ({ body: { connection_id: id, step: "remove" as const } })),
  );
  return ids.length;
}

/**
 * Syncs one connection: reads what its sign-in reaches and keeps that. Only the worker can,
 * because only it can read the sign-in. Safe to run twice.
 *
 * `unreadable` is a sign-in this Worker cannot open: there is no key, or it is not the key the
 * sign-in was sealed with. Nothing is changed, and trying again would not help.
 */
export async function syncConnection(
  connectionId: string,
  deps: ConnectionDeps,
): Promise<"synced" | "not_working" | "unreadable" | "refused" | "failed"> {
  const { store, key } = deps;
  const connection = await store.getConnection(connectionId);
  // One that only kept failing is still tried, and a sync that succeeds mends it.
  const tried =
    connection?.status === "working" ||
    (connection?.status === "broken" && connection.broken_reason === "failing");
  if (!connection || !tried) return "not_working";
  if (connection.kind === "hosted_pages") {
    try {
      return (await checkAnswerSubdomain(connection, deps)) ? "synced" : "not_working";
    } catch (error) {
      console.error(`Connection ${connectionId}: its check failed`, error);
      await recordFailure(connectionId, false, deps);
      return "failed";
    }
  }

  const sealed = await store.getConnectionSecret(connectionId);
  if (!sealed || !key) return "unreadable";
  let signIn: string;
  try {
    signIn = await open(key, connectionId, sealed);
  } catch (error) {
    console.error(`Connection ${connectionId}: its sign-in could not be opened`, error);
    return "unreadable";
  }

  let reached: Reached;
  try {
    reached = await (deps.read ?? ((kind, kept) => read(kind, kept, deps.outside ?? {})))(
      connection.kind,
      signIn,
    );
  } catch (error) {
    const refused = error instanceof SignInRefused;
    console.error(
      `Connection ${connectionId}: its sync ${refused ? "was refused" : "failed"}`,
      error,
    );
    await recordFailure(connectionId, refused, deps);
    return refused ? "refused" : "failed";
  }
  return (await store.recordConnectionSync(connectionId, reached.choices))
    ? "synced"
    : "not_working";
}

/**
 * Tells the owners and admins of every broken connection nobody has been told of yet: the email
 * could not be sent when it broke. One with nobody to tell, a test organization's among them,
 * is looked at again each day and stays untold. Returns how many were told.
 */
export async function tellBrokenConnections(deps: ConnectionDeps): Promise<number> {
  let told = 0;
  for (const id of await deps.store.listBrokenConnectionsUntold()) {
    const connection = await deps.store.getConnection(id);
    if (connection?.status === "broken" && (await tellBroken(connection, false, deps))) told++;
  }
  return told;
}

/** How long after its owners and admins were told a connection broke they are reminded, once. */
const REMIND_AFTER_MS = 7 * 86_400_000;

/**
 * Reminds the owners and admins of every connection they were told a week ago had broken and
 * that is still broken. Each is reminded once. Returns how many were.
 */
export async function remindBrokenConnections(deps: ConnectionDeps): Promise<number> {
  const now = deps.now ?? new Date();
  const due = await deps.store.listBrokenConnectionsToRemind(
    new Date(now.getTime() - REMIND_AFTER_MS).toISOString(),
  );
  let reminded = 0;
  for (const id of due) {
    const connection = await deps.store.getConnection(id);
    if (connection?.status === "broken" && (await tellBroken(connection, true, deps))) reminded++;
  }
  return reminded;
}

/**
 * Starts the removal of every connection its plan has not included for thirty days, and queues
 * the worker to finish each: take back the access and delete the sign-in. Returns how many.
 */
export async function expirePausedConnections(
  store: Store,
  queue: Pick<Queue<ConnectionMessage>, "sendBatch">,
): Promise<number> {
  return queueRemovals(await store.expirePausedConnections(), queue);
}

/** The most connections one run of the schedule queues, which is one `sendBatch`. */
const BATCH_LIMIT = 100;

/**
 * Queues a sync for every working connection that is due: once a day each. Returns how many.
 * Connections beyond the limit wait for the next run; the longest-waiting go first.
 */
export async function enqueueDueSyncs(
  store: Store,
  queue: Pick<Queue<ConnectionMessage>, "sendBatch">,
): Promise<number> {
  const due = await store.listConnectionsDueForSync(BATCH_LIMIT);
  if (due.length === 0) return 0;
  await queue.sendBatch(due.map((id) => ({ body: { connection_id: id, step: "sync" as const } })));
  return due.length;
}

/** How long a new connection's first sync may be missing before it is asked for again. */
const FIRST_SYNC_AFTER_MS = 15 * 60_000;
/** After this long the daily run has it, so the sweep stops asking. */
const FIRST_SYNC_UNTIL_MS = 24 * 3_600_000;

/**
 * Queues again the first sync of every connection made in the last day that still has none: its
 * message was lost, or the worker failed. Without it the owner would wait for the daily run to
 * choose what each location is matched to. Returns how many.
 */
export async function requeueFirstSyncs(
  store: Store,
  queue: Pick<Queue<ConnectionMessage>, "sendBatch">,
  now = Date.now(),
): Promise<number> {
  const waiting = await store.listConnectionsAwaitingFirstSync(
    new Date(now - FIRST_SYNC_UNTIL_MS).toISOString(),
    new Date(now - FIRST_SYNC_AFTER_MS).toISOString(),
  );
  if (waiting.length === 0) return 0;
  await queue.sendBatch(
    waiting
      .slice(0, BATCH_LIMIT)
      .map((id) => ({ body: { connection_id: id, step: "sync" as const } })),
  );
  return Math.min(waiting.length, BATCH_LIMIT);
}

/** How long a removal may wait before the schedule asks the worker for it again. */
const STALLED_AFTER_MS = 15 * 60_000;

/**
 * Queues again every removal that was asked for and has not been finished: its message was lost,
 * or the worker failed part-way. Returns how many.
 */
export async function requeueStalledRemovals(
  store: Store,
  queue: Pick<Queue<ConnectionMessage>, "sendBatch">,
  now = Date.now(),
): Promise<number> {
  const stalled = await store.listStalledRemovals(new Date(now - STALLED_AFTER_MS).toISOString());
  if (stalled.length === 0) return 0;
  await queue.sendBatch(
    stalled.map((id) => ({ body: { connection_id: id, step: "remove" as const } })),
  );
  return stalled.length;
}

/** Where a location's Website tab is, for an email to send its owners to. */
const websiteTab = (appUrl: string, locationId: string | null) =>
  `${appUrl.replace(/\/$/, "")}/locations/${locationId ?? ""}?tab=website`;

/** Emails an organization's owners and admins about its answer subdomain. False where nobody was. */
async function tellAboutSubdomain(
  organizationId: string,
  locationId: string | null,
  hostname: string,
  event: AnswerSubdomainEmail["event"],
  { store, send, appUrl }: ConnectionDeps,
  until?: AnswerSubdomainEmail["until"],
): Promise<boolean> {
  if (!send || !appUrl) return false;
  const organization = await store.getOrganization(organizationId);
  if (!organization || organization.is_test) return false;
  const managers = await store.listManagerEmails(organizationId);
  if (managers.length === 0) return false;
  await send(
    managers,
    buildAnswerSubdomainEmail({
      organization: organization.name,
      hostname,
      event,
      page: websiteTab(appUrl, locationId),
      until,
    }),
  );
  return true;
}

/**
 * Checks an answer subdomain, as its sync: what its name points at, and, once it points at the
 * connection's own target, registers it at Cloudflare and waits for it to be served with its
 * certificate. Nothing is registered for a name pointing anywhere else, so an account that made
 * the subdomain first cannot take it from the domain's owner. Once it is live, the business's home
 * page is read for a link to it, and the owners are told it works, once. On sample data nothing
 * is looked up or registered. False for a connection with no subdomain.
 */
async function checkAnswerSubdomain(
  connection: Connection,
  deps: ConnectionDeps,
): Promise<boolean> {
  const { store, hosting } = deps;
  const kept = await store.getAnswerSubdomain(connection.id);
  if (!kept) return false;
  if (!hosting || hosting.sampleData) {
    return store.recordAnswerSubdomainCheck(connection.id, {
      record: null,
      cloudflare_id: null,
      live: false,
      home_links: null,
    });
  }
  const record = await lookUp(kept.hostname, kept.target, hosting);
  const { cloudflare } = hosting;
  let registered = kept.cloudflare_id;
  if (!registered && record === "ours" && cloudflare) {
    registered = await registerHostname(kept.hostname, cloudflare, hosting);
  }
  const live =
    kept.live_at !== null ||
    (registered !== null &&
      cloudflare !== null &&
      (await hostnameLive(registered, cloudflare, hosting)));
  let homeLinks: boolean | null = null;
  if (live && kept.location_id) {
    const location = await store.getLocation(kept.location_id);
    if (location?.website) {
      const home = await fetchSite(location.website, hosting.fetch);
      if (home.html !== null) homeLinks = linksTo(home.html, kept.hostname);
    }
  }
  const recorded = await store.recordAnswerSubdomainCheck(connection.id, {
    record,
    cloudflare_id: registered,
    live,
    home_links: homeLinks,
  });
  if (recorded && live && kept.live_told_at === null) {
    try {
      const told = await tellAboutSubdomain(
        kept.organization_id,
        kept.location_id,
        kept.hostname,
        "live",
        deps,
      );
      if (told) await store.markAnswerSubdomainTold(connection.id);
    } catch (error) {
      // The next check tells them.
      console.error(`Connection ${connection.id}: its owners could not be told it is live`, error);
    }
  }
  return recorded;
}

/**
 * Finishes removing an answer subdomain: takes its name off Cloudflare where it was registered,
 * lets the name go, and tells the owners what to do with their record. Safe to run twice.
 */
async function removeAnswerSubdomain(
  connection: Connection,
  deps: ConnectionDeps,
): Promise<"removed" | "not_waiting"> {
  const { store, hosting } = deps;
  const kept = await store.getAnswerSubdomain(connection.id);
  if (kept?.cloudflare_id && hosting?.cloudflare) {
    await unregisterHostname(kept.cloudflare_id, hosting.cloudflare, hosting);
  }
  if (!(await store.finishConnectionRemoval(connection.id))) return "not_waiting";
  if (kept) {
    const reason = connection.removal_reason ?? "asked";
    await tellAboutSubdomain(
      kept.organization_id,
      kept.location_id,
      kept.hostname,
      reason,
      deps,
    ).catch((error) =>
      console.error(`Connection ${connection.id}: its owners could not be told`, error),
    );
  }
  return "removed";
}

/** How long after a check an answer subdomain still waiting is checked again. */
const CHECK_AGAIN_MS = 10 * 60_000;

/**
 * Queues a check of every answer subdomain still waiting for its record or its certificate, so
 * an owner who has just added the record sees it work within minutes, not the next day. Returns
 * how many.
 */
export async function requeueAnswerSubdomainChecks(
  store: Store,
  queue: Pick<Queue<ConnectionMessage>, "sendBatch">,
  now = Date.now(),
): Promise<number> {
  const due = await store.listAnswerSubdomainsToCheck(new Date(now - CHECK_AGAIN_MS).toISOString());
  if (due.length === 0) return 0;
  await queue.sendBatch(
    due.slice(0, BATCH_LIMIT).map((id) => ({ body: { connection_id: id, step: "sync" as const } })),
  );
  return Math.min(due.length, BATCH_LIMIT);
}

/**
 * Starts the removal of every answer subdomain that has not started working in thirty days, and
 * queues the worker to finish each and tell its owners. Returns how many.
 */
export async function expireUnclaimedAnswerSubdomains(
  store: Store,
  queue: Pick<Queue<ConnectionMessage>, "sendBatch">,
): Promise<number> {
  return queueRemovals(await store.expireUnclaimedAnswerSubdomains(), queue);
}

/**
 * Tells the owners of each answer subdomain that has just been paused, once a pause, when its
 * pages stop being served as they are and when it will be removed. One with nobody to tell is
 * looked at again the next day. Returns how many were told.
 */
export async function tellPausedAnswerSubdomains(deps: ConnectionDeps): Promise<number> {
  const { store } = deps;
  let told = 0;
  for (const id of await store.listPausedAnswerSubdomainsUntold()) {
    const kept = await store.getAnswerSubdomain(id);
    if (!kept?.paused_at) continue;
    const paused = Date.parse(kept.paused_at);
    const served = paused + SERVED_AFTER_PAUSE_DAYS * 86_400_000;
    const until = {
      served: new Date(served).toISOString(),
      removed: new Date(served + REDIRECTED_FOR_DAYS * 86_400_000).toISOString(),
    };
    try {
      if (
        await tellAboutSubdomain(
          kept.organization_id,
          kept.location_id,
          kept.hostname,
          "paused",
          deps,
          until,
        )
      ) {
        await store.markAnswerSubdomainPauseTold(id);
        told++;
      }
    } catch (error) {
      console.error(`Connection ${id}: its owners could not be told it is paused`, error);
    }
  }
  return told;
}
