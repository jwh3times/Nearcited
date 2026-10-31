import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ErrorNote } from "../components/ErrorNote";
import { api } from "../lib/api";
import { forgetStarted, handedBack, startedFrom } from "../lib/wordpress";

/**
 * Where WordPress sends its owner back, having approved the connection or not. What it handed
 * back was taken off the address before the app drew anything (`keepHandedBack`). It is believed
 * only when this tab started the connection, and is then sent once, to be sealed.
 */
export function WordPressReturn() {
  const navigate = useNavigate();
  const back = handedBack();
  // Read once: the start is forgotten as the connection settles, before an error is drawn.
  const [from] = useState(() => (back.kind === "nothing" ? null : startedFrom(back.state)));
  const sent = useRef(false);
  const connect = useMutation({
    mutationFn: (locationId: string) =>
      back.kind === "approved"
        ? api.connectWordPress(locationId, back.approved)
        : Promise.reject(new Error("Nothing was approved.")),
    onSettled: forgetStarted,
    onSuccess: (_connected, locationId) =>
      navigate(`/locations/${locationId}?tab=website`, { replace: true }),
  });

  useEffect(() => {
    if (sent.current || back.kind !== "approved" || from === null) return;
    sent.current = true;
    connect.mutate(from);
  }, [back.kind, from, connect]);

  const toLocation = from ? `/locations/${from}?tab=website` : "/";

  return (
    <main className="page-narrow">
      <h1>Your WordPress site</h1>
      {back.kind === "nothing" ? (
        <p>There is nothing to finish here.</p>
      ) : from === null ? (
        <p>
          This was not started from this browser tab, so nothing was connected. Start again from the
          Website tab of the location the site belongs to.
        </p>
      ) : back.kind === "declined" ? (
        <p>You chose not to connect it, so nothing was connected.</p>
      ) : connect.isError ? (
        <ErrorNote error={connect.error} />
      ) : (
        <p role="status">Connecting your site</p>
      )}
      {(back.kind !== "approved" || from === null || connect.isError) && (
        <p>
          <Link to={toLocation}>Back to {from ? "the location" : "your locations"}</Link>
        </p>
      )}
    </main>
  );
}
