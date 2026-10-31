import type { Connection, OrganizationConnections } from "@nearcited/shared";
import { api } from "./api";
import { windingDown } from "./hosted-pages";

/** How often the page asks again while something is waiting for the worker. */
const WAITING_MS = 2000;

/**
 * True while the worker owes a connection something the page is waiting to show: finishing a
 * removal, or the first sync, which is what tells the page what the account reaches.
 */
export const awaitingWorker = (connection: Connection): boolean =>
  connection.status === "removing" ||
  (connection.status === "working" && connection.last_synced_at === null);

/**
 * An organization's connections, read the same way by the page and by the sidebar. While the
 * worker owes one something it is asked for again every couple of seconds, since the worker
 * does that on its own time.
 */
export const connectionsQuery = (organizationId: string) => ({
  queryKey: ["connections", organizationId],
  queryFn: () => api.connections(organizationId),
  refetchInterval: (query: { state: { data?: OrganizationConnections } }) =>
    query.state.data?.connections.some(awaitingWorker) ? WAITING_MS : false,
});

/**
 * What a location can be matched to on one connection: every choice that is not another
 * location's already. Its own choice is among them, and still is when the last sync no longer
 * found it at the account: it is then named as such, so the owner can see what happened and
 * choose again.
 */
export function choicesFor(connection: Connection, locationId: string): Connection["choices"] {
  const own = connection.matches.find((match) => match.location_id === locationId);
  const taken = new Set(
    connection.matches
      .filter((match) => match.location_id !== locationId)
      .map((match) => match.external_id),
  );
  const offered = connection.choices.filter((choice) => !taken.has(choice.id));
  if (!own || offered.some((choice) => choice.id === own.external_id)) return offered;
  return [...offered, { id: own.external_id, label: `${own.external_label} (no longer found)` }];
}

/** How long a paused connection's sign-in is kept before it is removed. */
const KEPT_WHILE_PAUSED_MS = 30 * 86_400_000;

/**
 * What to say about a connection that is not working or not in use, or null for one that is
 * fine. `day` writes a date the way the page does.
 */
export function connectionNote(
  connection: Connection,
  day: (iso: string) => string,
): string | null {
  if (connection.status === "broken" && connection.kind === "cloudflare") {
    return connection.broken_reason === "refused"
      ? "Not working: Cloudflare refused the token, or it reaches no zone. Make a new token with both permissions, connect it, and remove this one."
      : "Not working: reading from Cloudflare has failed three days in a row. Nearcited tries again once a day, and it will start working again by itself if the cause passes.";
  }
  if (connection.status === "broken" && connection.kind === "google_analytics") {
    return connection.broken_reason === "refused"
      ? "Not working: Google refused the sign-in. It may have been taken away in your Google account. Remove it, and then sign in with Google again."
      : "Not working: reading from Google Analytics has failed three days in a row. Nearcited tries again once a day, and it will start working again by itself if the cause passes.";
  }
  if (connection.status === "broken") {
    return connection.broken_reason === "refused"
      ? "Not working: the account refused the sign-in. Remove it and connect it again."
      : "Not working: reading from it has failed three days in a row. Nearcited tries again once a day, and it will start working again by itself if the cause passes.";
  }
  if (
    connection.status === "paused" &&
    connection.kind === "hosted_pages" &&
    connection.paused_at
  ) {
    const { served, removed } = windingDown(connection.paused_at);
    return `Paused: your plan does not include pages on your own domain. The pages stay up until ${day(served)}, then send visitors to your website until ${day(removed)}, when the subdomain is removed.`;
  }
  if (connection.status === "paused") {
    const until = connection.paused_at
      ? ` Its sign-in is kept until ${day(new Date(Date.parse(connection.paused_at) + KEPT_WHILE_PAUSED_MS).toISOString())}, and then removed.`
      : "";
    return `Paused: your plan does not include this account, so nothing is read from it.${until}`;
  }
  return null;
}

/** How many of an organization's connections are broken, for the sidebar to say so. */
export function brokenConnections(found: OrganizationConnections | undefined): number {
  return found?.connections.filter((connection) => connection.status === "broken").length ?? 0;
}

/** Who removed a connection, in words: a person, or the thirty days it spent paused. */
export function removedBy(connection: Connection): string {
  if (connection.removal_reason === "plan") return "after thirty days on a plan without it";
  return `by ${connection.removed_by_email ?? "someone who has left"}`;
}

/** The connections still there, and the ones that are gone and kept as a record. */
export function splitConnections(connections: Connection[]): {
  current: Connection[];
  removed: Connection[];
} {
  return {
    current: connections.filter((connection) => connection.status !== "removed"),
    removed: connections.filter((connection) => connection.status === "removed"),
  };
}

/**
 * Whether there is anything on the Connections page worth a link to it: something connected or
 * once connected, or something that could be.
 */
export function hasConnectionsPage(found: OrganizationConnections | undefined): boolean {
  return found !== undefined && (found.available.length > 0 || found.connections.length > 0);
}
