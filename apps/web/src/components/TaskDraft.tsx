import { type DraftsStanding, type Location, type Task, WHAT_WE_DO_MAX } from "@nearcited/shared";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { useCopy } from "../lib/copy";
import { draftLabel, draftOffer, draftsLeft, usedUpLine } from "../lib/drafts";
import { locationFormValues } from "../lib/location";
import { ErrorNote } from "./ErrorNote";
import { LongField } from "./Field";

interface TaskDraftProps {
  task: Task;
  location: Location;
  /** Where the organization's month of drafts stands. */
  standing: DraftsStanding;
  /** True while the operator is reading a customer's account: a draft is read, not asked for. */
  readOnly: boolean;
  /** Whether the reader is the organization's owner, who is the one shown the way to the plans. */
  isOwner: boolean;
  onChanged: () => unknown;
}

/**
 * The draft for one task: the wording an owner would otherwise write. It is written when they
 * ask, kept, and shown labelled with who wrote it. Nothing here edits it: it is copied and
 * changed wherever it is going. A draft is written from what the business says it does, so a
 * location that has not said is asked first, here.
 */
export function TaskDraft({
  task,
  location,
  standing,
  readOnly,
  isOwner,
  onChanged,
}: TaskDraftProps) {
  const { draft } = task;
  const offer = draftOffer(task, standing, readOnly);
  const { copied, copy } = useCopy();
  // Open once the reader asks for a draft of a business that has not said what it does.
  const [said, setSaid] = useState<string | null>(null);

  const ask = useMutation({
    mutationFn: async (whatWeDo: string | null) => {
      if (whatWeDo !== null) {
        await api.updateLocation(location.id, {
          ...locationFormValues(location),
          what_we_do: whatWeDo,
        });
      }
      return api.askDraft(location.id, task.id);
    },
    onSuccess: () => setSaid(null),
    // Saving what the business does may have worked where the ask did not.
    onSettled: onChanged,
  });

  if (offer === "nothing" && !draft) return null;

  function start() {
    if (location.what_we_do) ask.mutate(null);
    else setSaid("");
  }
  function saveAndStart(event: FormEvent) {
    event.preventDefault();
    if (said?.trim()) ask.mutate(said);
  }
  const left = draftsLeft(standing);

  return (
    <div className="paste-block">
      {draft?.text && (
        <>
          <p>{draftLabel(draft)}</p>
          <p className="draft-text">{draft.text}</p>
          <div className="paste-actions">
            <button type="button" className="secondary" onClick={() => copy(draft.text ?? "")}>
              {copied === "yes" ? "Copied" : "Copy the draft"}
            </button>
            <span role="status">
              {copied === "no" && "It could not be copied for you. Select it above and copy it."}
            </span>
          </div>
        </>
      )}
      {offer === "writing" && <p role="status">Writing a draft. This takes a moment.</p>}
      {draft?.status === "failed" && offer !== "writing" && (
        <p className="task-proof">No draft was written. {draft.failure}</p>
      )}
      {offer === "used_up" && (
        <p>
          {usedUpLine(standing)} {isOwner && <Link to="/pricing">See plans</Link>}
        </p>
      )}
      {(offer === "write" || offer === "again") &&
        (said === null ? (
          <div className="paste-actions">
            <button
              type="button"
              className={offer === "again" ? "link" : "secondary"}
              disabled={ask.isPending}
              onClick={start}
            >
              {offer === "again" ? "Write it again" : "Write a draft"}
            </button>
            <span>
              {offer === "again" && "It replaces this one and counts as one more. "}
              {left}
            </span>
          </div>
        ) : (
          <form onSubmit={saveAndStart} className="stack-tight" noValidate>
            <LongField
              label="What we do"
              maxLength={WHAT_WE_DO_MAX}
              autoFocus
              value={said}
              disabled={ask.isPending}
              onChange={(event) => setSaid(event.target.value)}
              hint="A few sentences in your own words: what you do, who for, and what you are known for. A draft is written from this and from this location's details, and states nothing else about the business. You can change it in Settings."
            />
            <div className="paste-actions">
              <button
                type="submit"
                className="secondary"
                disabled={ask.isPending || said.trim() === ""}
              >
                {ask.isPending ? "Saving" : "Save and write a draft"}
              </button>
              <button type="button" className="link" onClick={() => setSaid(null)}>
                Cancel
              </button>
            </div>
          </form>
        ))}
      <ErrorNote error={ask.error} />
    </div>
  );
}
