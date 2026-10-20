import {
  ACTION_KIND_DOING,
  type Action,
  type KindPermission,
  type LocationActions,
  NOTICE_HOLD_HOURS,
} from "@nearcited/shared";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import {
  actionState,
  actionText,
  END_QUESTION,
  editable,
  giveQuestion,
  isMarkup,
  isPage,
  pageAddress,
  permissionShown,
  standingLine,
  TAKE_BACK_QUESTION,
  whatItReplaced,
  writtenBy,
} from "../lib/actions";
import { api } from "../lib/api";
import { formatDay } from "../lib/billing";
import { ErrorNote } from "./ErrorNote";

interface ActionsProps {
  actions: LocationActions;
  /** The location's organization, whose standing permission this is. */
  organizationId: string;
  onChanged: () => void;
  /** True while the operator is reading a customer's account: they answer nothing. */
  readOnly?: boolean;
}

/**
 * What Nearcited would do for this location and is waiting for a yes, and the record of what
 * became of everything it proposed before. Nothing here is done until a member says so.
 */
export function Actions({ actions, organizationId, onChanged, readOnly }: ActionsProps) {
  const shown = actions.permissions.filter(
    (permission) => permissionShown(permission, actions) !== null,
  );
  return (
    <div className="stack">
      {actions.held && (
        <p className="error" role="alert">
          Nothing more is being carried out for your organization for now. Something was done more
          than {NOTICE_HOLD_HOURS} hours ago and its owners have not been told of it yet. What you
          have approved is kept, and is carried out once they have been.
        </p>
      )}
      {shown.length > 0 && (
        <section className="stack" aria-label="Standing permission">
          <div className="section-head">
            <h2>Standing permission</h2>
            <span className="small">An owner's or admin's yes in advance, for every location.</span>
          </div>
          {shown.map((permission) => (
            <Permission
              key={permission.kind}
              permission={permission}
              organizationId={organizationId}
              mayChange={actions.may_change_permission && !readOnly}
              onChanged={onChanged}
            />
          ))}
        </section>
      )}
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
            <Recorded
              key={action.id}
              action={action}
              takenBack={actions.record.some(
                (later) => later.takes_back === action.id && later.status !== "failed",
              )}
              onChanged={onChanged}
              readOnly={readOnly}
            />
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * Standing permission for one kind of action: offered to an owner or admin once three were
 * approved as proposed and done, or standing, with who gave it and a switch to end it.
 */
function Permission({
  permission,
  organizationId,
  mayChange,
  onChanged,
}: {
  permission: KindPermission;
  organizationId: string;
  /** Whether the reader may give or end it: an owner or admin, not the operator reading. */
  mayChange: boolean;
  onChanged: () => void;
}) {
  const give = useMutation({
    mutationFn: () => api.giveStandingPermission(organizationId, permission.kind),
    onSuccess: onChanged,
  });
  const end = useMutation({
    mutationFn: () => api.endStandingPermission(organizationId, permission.kind),
    onSuccess: onChanged,
  });
  const doing = ACTION_KIND_DOING[permission.kind];
  return (
    <article className="card action" aria-label={`Standing permission to ${doing}`}>
      {permission.standing ? (
        <>
          <h3 className="action-name">Done without asking: {doing}</h3>
          <p className="small muted">{standingLine(permission.standing, formatDay)}</p>
          {mayChange && (
            <div className="button-row">
              <button
                type="button"
                className="secondary"
                disabled={end.isPending}
                onClick={() => {
                  if (window.confirm(END_QUESTION)) end.mutate();
                }}
              >
                {end.isPending ? "Switching off" : "Switch it off"}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <h3 className="action-name">Stop asking: {doing}?</h3>
          <p className="small muted">
            Three of these were approved as proposed and carried out. Nearcited can do the next ones
            without waiting for a yes, at every location of your organization, and tell your owners
            afterwards. You can switch it off at any time.
          </p>
          <div className="button-row">
            <button
              type="button"
              disabled={give.isPending}
              onClick={() => {
                if (window.confirm(giveQuestion(permission.kind))) give.mutate();
              }}
            >
              {give.isPending ? "Giving permission" : "Do these without asking"}
            </button>
          </div>
        </>
      )}
      <ErrorNote error={give.error ?? end.error} />
    </article>
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
        <li className={isMarkup(action) && action.seen?.text ? "action-pair-code" : undefined}>
          <span>What is there now</span>
          <Shown action={action} text={action.seen?.text ?? null} empty="Nothing" />
        </li>
      </ul>
      {action.proposed_text !== null &&
        (readOnly || !editable(action) ? (
          <>
            {!readOnly && (
              <span className="small muted">What it would put there. {writtenBy(action)}.</span>
            )}
            <Shown action={action} text={action.proposed_text} empty="" block />
          </>
        ) : (
          <label className="stack-tight">
            <span className="small muted">What it would say. {writtenBy(action)}.</span>
            <textarea
              rows={isPage(action) ? 14 : 3}
              value={text}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
            />
            {isPage(action) && (
              <span className="small muted">
                The first line is the page's title, and a line starting “## ” is a heading. It is
                published at {pageAddress(action, text)}, with your business's name, address and
                phone number added at the end.
              </span>
            )}
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
  takenBack,
  onChanged,
  readOnly,
}: {
  action: Action;
  /** Whether it has been taken back, or is being, so there is nothing more to take back. */
  takenBack: boolean;
  onChanged: () => void;
  readOnly?: boolean;
}) {
  const retry = useMutation({ mutationFn: () => api.retryAction(action.id), onSuccess: onChanged });
  const takeBack = useMutation({
    mutationFn: () => api.takeBackAction(action.id),
    onSuccess: onChanged,
  });
  const text = actionText(action);
  const replaced = whatItReplaced(action, formatDay);
  return (
    <article className="card action" aria-label={action.summary}>
      <h3 className="action-name">{action.summary}</h3>
      {text !== null && <Shown action={action} text={text} empty="" block />}
      {text === null && action.takes_back !== null && (
        <p>It took away what the earlier action had put there.</p>
      )}
      {replaced !== null && (
        <ul className="facts">
          <li className={isMarkup(action) && action.seen?.text ? "action-pair-code" : undefined}>
            <span>{action.status === "done" ? "What it replaced" : "What was there"}</span>
            {action.seen_dropped_at === null ? (
              <Shown action={action} text={action.seen?.text ?? null} empty="Nothing" />
            ) : (
              <span>{replaced}</span>
            )}
          </li>
        </ul>
      )}
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
      {action.status === "done" && !takenBack && !readOnly && (
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            disabled={takeBack.isPending}
            onClick={() => {
              if (window.confirm(TAKE_BACK_QUESTION)) takeBack.mutate();
            }}
          >
            {takeBack.isPending ? "Asking" : "Take it back"}
          </button>
        </div>
      )}
      <ErrorNote error={retry.error ?? takeBack.error} />
    </article>
  );
}

/**
 * What an action read or would put there. Markup is shown as it is written, so nobody approves
 * code they were shown as prose; anything else is shown as text. `empty` stands for nothing.
 */
function Shown({
  action,
  text,
  empty,
  block = false,
}: {
  action: Action;
  text: string | null;
  empty: string;
  /** A paragraph of its own, rather than one side of a pair. */
  block?: boolean;
}) {
  if (text === null) return <span>{empty}</span>;
  if (isMarkup(action)) {
    return (
      <pre className="action-code">
        <code>{text}</code>
      </pre>
    );
  }
  if (isPage(action)) return <p className="action-copy">{text}</p>;
  return block ? <p>{text}</p> : <span>{text}</span>;
}
