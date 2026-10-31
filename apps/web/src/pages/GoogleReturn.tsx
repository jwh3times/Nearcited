import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ErrorNote } from "../components/ErrorNote";
import { api } from "../lib/api";
import {
  forgetGoogleStarted,
  GOOGLE_WORDS,
  googleHandedBack,
  googleStartedFrom,
} from "../lib/google";

/**
 * Where Google sends its owner back, having agreed or not. What it handed back was taken off the
 * address before the app drew anything (`keepGoogleHandedBack`). It is believed only when this tab
 * started the sign-in, and is then sent once, to be sealed.
 */
export function GoogleReturn() {
  const navigate = useNavigate();
  const back = googleHandedBack();
  // Read once: the start is forgotten as the sign-in settles, before an error is drawn.
  const [from] = useState(() => (back.kind === "nothing" ? null : googleStartedFrom(back.state)));
  const sent = useRef(false);
  const connect = useMutation({
    mutationFn: (organizationId: string) =>
      back.kind === "agreed"
        ? api.connectGoogleAnalytics(organizationId, { code: back.code, state: back.state })
        : Promise.reject(new Error("Nothing was agreed.")),
    onSettled: forgetGoogleStarted,
    onSuccess: () => navigate("/connections", { replace: true }),
  });

  useEffect(() => {
    if (sent.current || back.kind !== "agreed" || from === null) return;
    sent.current = true;
    connect.mutate(from);
  }, [back.kind, from, connect]);

  return (
    <main className="page-narrow">
      <h1>{GOOGLE_WORDS.returnTitle}</h1>
      {back.kind === "nothing" ? (
        <p>{GOOGLE_WORDS.nothing}</p>
      ) : from === null ? (
        <p>{GOOGLE_WORDS.notFromHere}</p>
      ) : back.kind === "declined" ? (
        <p>{GOOGLE_WORDS.declined}</p>
      ) : connect.isError ? (
        <ErrorNote error={connect.error} />
      ) : (
        <p role="status">{GOOGLE_WORDS.connecting}</p>
      )}
      {(back.kind !== "agreed" || from === null || connect.isError) && (
        <p>
          <Link to="/connections">{GOOGLE_WORDS.back}</Link>
        </p>
      )}
    </main>
  );
}
