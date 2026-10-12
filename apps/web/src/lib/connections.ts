import type { Connection, OrganizationConnections } from "@nearcited/shared";
import { api } from "./api";

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
 * location's already. Its own choice is among them.
 */
export function choicesFor(connection: Connection, locationId: string): Connection["choices"] {
  const taken = new Set(
    connection.matches
      .filter((match) => match.location_id !== locationId)
      .map((match) => match.external_id),
  );
  return connection.choices.filter((choice) => !taken.has(choice.id));
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
