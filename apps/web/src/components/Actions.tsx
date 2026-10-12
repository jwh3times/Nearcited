import type { Action, LocationActions } from "@nearcited/shared";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { actionState, actionText, writtenBy } from "../lib/actions";
import { api } from "../lib/api";
import { formatDay } from "../lib/billing";
import { ErrorNote } from "./ErrorNote";

interface ActionsProps {
  actions: LocationActions;
  onChanged: () => void;
  /** True while the operator is reading a customer's account: they answer nothing. */
  readOnly?: boolean;
}

/**
 * What Nearcited would do for this location and is waiting for a yes, and the record of what
 * became of everything it proposed before. Nothing here is done until a member says so.
 */
export function Actions({ actions, onChanged, readOnly }: ActionsProps) {
  return (
    <div className="stack">
      <section className="stack" aria-label="Waiting for your yes">
        <div className="section-head">
          <h2>Waiting for your yes</h2>
          <span className="small">
            Nothing here is done until someone in your organization approves it.
          </span>
        </div>
        {actions.waiting.length === 0 && <p className="muted">Nothing is waiting.</p>}
        {actions.waiting.map((action) => (
          <Proposal key={action.id} action={action} onChanged={onChanged} readOnly={readOnly} />
        ))}
      </section>

      {actions.record.length > 0 && (
        <section className="stack" aria-label="What happened">
          <div className="section-head">
            <h2>What happened</h2>
            <span className="small">Everything that was proposed and what became of it.</span>
          </div>
          {actions.record.map((action) => (
            <Recorded key={action.id} action={action} onChanged={onChanged} readOnly={readOnly} />
          ))}
        </section>
      )}
    </div>
  );
}

/** One action waiting for an answer: what it would do, what it replaces, and the two answers. */
function Proposal({
  action,
  onChanged,
  readOnly,
}: {
  action: Action;
  onChanged: () => void;
  readOnly?: boolean;
}) {
  const [text, setText] = useState(action.proposed_text ?? "");
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const changed = action.proposed_text !== null && text.trim() !== action.proposed_text;
  const approve = useMutation({
    mutationFn: () => api.approveAction(action.id, changed ? text : undefined),
    onSuccess: onChanged,
  });
  const decline = useMutation({
    mutationFn: () => api.declineAction(action.id, reason.trim() || undefined),
    onSuccess: onChanged,
  });
  const busy = approve.isPending || decline.isPending;

  return (
    <article className="card action" aria-label={action.summary}>
      <h3 className="action-name">{action.summary}</h3>
      <ul className="facts">
        <li>
          <span>What is there now</span>
          <span>{action.seen?.text ?? "Nothing"}</span>
        </li>
      </ul>
      {action.proposed_text !== null &&
        (readOnly ? (
          <p>{action.proposed_text}</p>
        ) : (
          <label className="stack-tight">
            <span className="small muted">What it would say. {writtenBy(action)}.</span>
            <textarea
              rows={3}
              value={text}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
        ))}
      <p className="small muted">{actionState(action, formatDay)}</p>
      {!readOnly && !declining && (
        <div className="button-row">
          <button
            type="button"
            disabled={busy || (action.proposed_text !== null && text.trim() === "")}
            onClick={() => approve.mutate()}
          >
            {approve.isPending ? "Approving" : changed ? "Approve as changed" : "Approve"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setDeclining(true)}
          >
            Decline
          </button>
        </div>
      )}
      {!readOnly && declining && (
        <>
          <label className="stack-tight">
            <span className="small muted">
              Why not, if you want to say. It is kept with the record.
            </span>
            <input
              type="text"
              maxLength={200}
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="button-row">
            <button type="button" disabled={busy} onClick={() => decline.mutate()}>
              {decline.isPending ? "Declining" : "Decline it"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setDeclining(false)}
            >
              Back
            </button>
          </div>
        </>
      )}
      <ErrorNote error={approve.error ?? decline.error} />
    </article>
  );
}

/** One action that has been answered or has lapsed: what it was, and what became of it. */
function Recorded({
  action,
  onChanged,
  readOnly,
}: {
  action: Action;
  onChanged: () => void;
  readOnly?: boolean;
}) {
  const retry = useMutation({ mutationFn: () => api.retryAction(action.id), onSuccess: onChanged });
  const text = actionText(action);
  return (
    <article className="card action" aria-label={action.summary}>
      <h3 className="action-name">{action.summary}</h3>
      {text !== null && <p>{text}</p>}
      <p className="small muted">{actionState(action, formatDay)}</p>
      {action.status === "failed" && !readOnly && (
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            disabled={retry.isPending}
            onClick={() => retry.mutate()}
          >
            {retry.isPending ? "Asking again" : "Try again"}
          </button>
        </div>
      )}
      <ErrorNote error={retry.error} />
    </article>
  );
}
