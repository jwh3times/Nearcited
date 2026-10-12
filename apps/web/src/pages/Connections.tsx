import {
  CONNECTION_KIND_LABELS,
  type Connection,
  type ConnectionKind,
  type Location,
  type Organization,
} from "@nearcited/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorNote } from "../components/ErrorNote";
import { api } from "../lib/api";
import { formatDay } from "../lib/billing";
import { choicesFor, connectionsQuery, splitConnections } from "../lib/connections";

/**
 * The accounts an organization has connected: what is connected, who connected it, and for its
 * owner or an admin, connecting another and removing one. A sign-in is never shown: the API does
 * not have one to send.
 */
export function Connections({ organization }: { organization: Organization }) {
  const queryClient = useQueryClient();
  const found = useQuery(connectionsQuery(organization.id));
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["connections", organization.id] });
  const connect = useMutation({
    mutationFn: (kind: ConnectionKind) => api.connect(organization.id, kind),
    onSuccess: refresh,
  });

  // The sidebar reads the same list, so this costs nothing more.
  const locations = useQuery({
    queryKey: ["locations", organization.id],
    queryFn: () => api.listLocations(organization.id),
  });

  const { current, removed } = splitConnections(found.data?.connections ?? []);
  const canManage = found.data?.can_manage ?? false;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <p className="small muted">{organization.name}</p>
          <h1>Connections</h1>
        </div>
      </div>

      <div className="settings">
        <section className="card settings-main" aria-label="Connected accounts">
          <div>
            <h2>Connected accounts</h2>
            <p className="small muted">
              An account is signed in to once, and Nearcited works from it after that. The sign-in
              is kept sealed: nobody can read it back, here or anywhere else.
            </p>
          </div>
          {found.isPending && <p className="status">Loading</p>}
          <ErrorNote error={found.error} />
          {found.data && current.length === 0 && <p className="muted">Nothing is connected.</p>}
          {current.map((connection) => (
            <ConnectedAccount
              key={connection.id}
              connection={connection}
              locations={locations.data ?? []}
              canManage={canManage}
              onChanged={refresh}
            />
          ))}

          {found.data?.available.map((kind) => (
            <div key={kind} className="button-row">
              <button
                type="button"
                disabled={!canManage || connect.isPending}
                onClick={() => connect.mutate(kind)}
              >
                {connect.isPending
                  ? "Connecting"
                  : `Connect a ${CONNECTION_KIND_LABELS[kind].toLowerCase()}`}
              </button>
            </div>
          ))}
          {found.data && found.data.available.length === 0 && (
            <p className="small muted">Nothing can be connected here yet.</p>
          )}
          {found.data && found.data.available.length > 0 && !canManage && (
            <p className="small muted">
              Only the organization's owner or an admin can connect an account or remove one.
            </p>
          )}
          <ErrorNote error={connect.error} />
        </section>

        {removed.length > 0 && (
          <div className="settings-side">
            <section className="card side-card" aria-label="Removed">
              <h3 className="side-title">Removed</h3>
              <ul className="plan-facts">
                {removed.map((connection) => (
                  <li key={connection.id}>
                    {connection.label}: connected by{" "}
                    {connection.connected_by_email ?? "someone who has left"} on{" "}
                    {formatDay(connection.connected_at)}, removed by{" "}
                    {connection.removed_by_email ?? "someone who has left"}
                    {connection.removed_at ? ` on ${formatDay(connection.removed_at)}` : ""}.
                  </li>
                ))}
              </ul>
              <p className="small muted">
                A removed account's sign-in is deleted, with everything that was read from it.
              </p>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}

/** One connected account, with the way to remove it for whoever may. Removing asks twice. */
function ConnectedAccount({
  connection,
  locations,
  canManage,
  onChanged,
}: {
  connection: Connection;
  locations: Location[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.removeConnection(connection.id),
    onSuccess: onChanged,
  });
  const removing = connection.status === "removing";

  return (
    <article className="connection" aria-label={connection.label}>
      <ul className="facts">
        <li>
          <span>Account</span>
          <span>{connection.label}</span>
        </li>
        {removing && (
          <li>
            <span>Status</span>
            <span>Being removed</span>
          </li>
        )}
        <li>
          <span>Connected by</span>
          <span>
            {connection.connected_by_email ?? "Someone who has left"} on{" "}
            {formatDay(connection.connected_at)}
          </span>
        </li>
        {!removing && (
          <li>
            <span>Last read</span>
            <span>
              {connection.last_synced_at
                ? formatDay(connection.last_synced_at)
                : "Reading what this account reaches"}
            </span>
          </li>
        )}
      </ul>
      {!removing && connection.last_synced_at && (
        <Matches
          connection={connection}
          locations={locations}
          canManage={canManage}
          onChanged={onChanged}
        />
      )}
      {canManage && !removing && !asking && (
        <div className="button-row">
          <button type="button" className="secondary" onClick={() => setAsking(true)}>
            Remove
          </button>
        </div>
      )}
      {canManage && !removing && asking && (
        <>
          <p className="error" role="alert">
            Removing {connection.label} stops Nearcited working from it, takes back the access it
            was given, and deletes the sign-in and everything read from it. It cannot be undone:
            connecting again means signing in again.
          </p>
          <div className="button-row">
            <button type="button" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending ? "Removing" : `Remove ${connection.label}`}
            </button>
            <button type="button" className="secondary" onClick={() => setAsking(false)}>
              Keep it
            </button>
          </div>
        </>
      )}
      <ErrorNote error={remove.error} />
    </article>
  );
}

/**
 * Which of the things an account reaches is each location's. An owner or admin chooses; everyone
 * else reads. What is another location's already is not offered twice.
 */
function Matches({
  connection,
  locations,
  canManage,
  onChanged,
}: {
  connection: Connection;
  locations: Location[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const choose = useMutation({
    mutationFn: ({ locationId, externalId }: { locationId: string; externalId: string }) =>
      externalId === ""
        ? api.unmatchConnectionLocation(connection.id, locationId)
        : api.matchConnectionLocation(connection.id, locationId, externalId),
    onSuccess: onChanged,
  });
  if (locations.length === 0) {
    return <p className="small muted">Add a location to say which of these is its own.</p>;
  }

  return (
    <div className="stack-tight">
      <h3 className="side-title">Which is each location's</h3>
      <ul className="facts">
        {locations.map((location) => {
          const match = connection.matches.find((kept) => kept.location_id === location.id);
          return (
            <li key={location.id}>
              <span>{location.name}</span>
              {canManage ? (
                <select
                  aria-label={`${connection.label} for ${location.name}`}
                  value={match?.external_id ?? ""}
                  disabled={choose.isPending}
                  onChange={(event) =>
                    choose.mutate({ locationId: location.id, externalId: event.target.value })
                  }
                >
                  <option value="">Not matched</option>
                  {choicesFor(connection, location.id).map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span>{match?.external_label ?? "Not matched"}</span>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorNote error={choose.error} />
    </div>
  );
}
