import type { Connection, OrganizationConnections } from "@nearcited/shared";
import { api } from "./api";

/** How often the page asks again while a removal is waiting for the worker. */
const WAITING_MS = 2000;

/**
 * An organization's connections, read the same way by the page and by the sidebar. While one is
 * being removed it is asked for again every couple of seconds, since the worker finishes that
 * on its own time.
 */
export const connectionsQuery = (organizationId: string) => ({
  queryKey: ["connections", organizationId],
  queryFn: () => api.connections(organizationId),
  refetchInterval: (query: { state: { data?: OrganizationConnections } }) =>
    query.state.data?.connections.some((connection) => connection.status === "removing")
      ? WAITING_MS
      : false,
});

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
