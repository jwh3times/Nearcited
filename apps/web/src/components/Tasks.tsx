import { DRAFTS_ALLOWANCE, type DraftsStanding, type Location, type Task } from "@nearcited/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../lib/api";
import { plansLineBelongs } from "../lib/drafts";
import { formatDate } from "../lib/format";
import { KIND_LABELS, markedDone, proof } from "../lib/tasks";
import { ErrorNote } from "./ErrorNote";
import { TaskAsking } from "./TaskAsking";
import { TaskCitedPage } from "./TaskCitedPage";
import { TaskDraft } from "./TaskDraft";
import { TaskListing } from "./TaskListing";

interface TasksProps {
  tasks: Task[];
  location: Location;
  /** Where the organization's month of drafts stands. */
  drafts: DraftsStanding;
  onChanged: () => unknown;
  /** True while the operator is reading a customer's account: the tasks are shown, not acted on. */
  readOnly: boolean;
}

/**
 * The work that follows from the sources, one site each. Marking one done is kept with the
 * location, and the scans before that day are set beside the scans since. A task an action did
 * the work of is marked by that, and offers nothing to undo.
 */
export function Tasks({ tasks, location, drafts, onChanged, readOnly }: TasksProps) {
  const mark = useMutation({
    mutationFn: ({ id, acted }: { id: string; acted: boolean }) =>
      api.setRecommendationActed(id, acted),
    onSuccess: onChanged,
  });
  // The way to the plans is the owner's, and the account page has already asked who that is.
  const account = useQuery({
    queryKey: ["account", location.organization_id],
    queryFn: () => api.organizationAccount(location.organization_id),
    enabled: !readOnly,
  });
  const isOwner = account.data?.billing != null;
  // A plan with no drafts is said so only where some plan has them.
  const withoutDrafts = plansLineBelongs(tasks, drafts, readOnly);
  const plans = useQuery({
    queryKey: ["plans"],
    queryFn: api.plans,
    staleTime: 300_000,
    enabled: withoutDrafts,
  });
  const offered = plans.data?.some((plan) => plan.allowances[DRAFTS_ALLOWANCE] !== undefined);

  return (
    <>
      <h3>Your tasks</h3>
      {withoutDrafts && offered && (
        <p className="footnote">
          Your plan does not include drafts written for you.{" "}
          {isOwner && <Link to="/pricing">See plans</Link>}
        </p>
      )}
      <ul className="steps">
        {tasks.map((task) => {
          const lines = proof(task);
          return (
            <li key={task.id} className="card also">
              <div className="task-body">
                <div className="step-title">
                  <h3>{task.title}</h3>
                  <span className="kind">{KIND_LABELS[task.kind]}</span>
                </div>
                <p>{task.summary}</p>
                <p>{task.detail}</p>
                {task.url && (
                  <p>
                    <a href={task.url} target="_blank" rel="noopener noreferrer nofollow">
                      Open the page that was read
                    </a>
                  </p>
                )}
                {task.cited_page && <TaskCitedPage page={task.cited_page} location={location} />}
                <TaskListing
                  task={task}
                  locationId={location.id}
                  readOnly={readOnly}
                  onChanged={onChanged}
                />
                <TaskAsking task={task} location={location} />
                <TaskDraft
                  task={task}
                  location={location}
                  standing={drafts}
                  readOnly={readOnly}
                  isOwner={isOwner}
                  onChanged={onChanged}
                />
                {task.acted_at && lines && (
                  <p className="task-proof">
                    {markedDone(task, formatDate(task.acted_at))}
                    <br />
                    {lines.before}
                    <br />
                    {lines.since}
                  </p>
                )}
              </div>
              {!readOnly && !task.acted_by_action && (
                <div className="row-actions">
                  <button
                    type="button"
                    className={task.acted_at ? "link" : "secondary"}
                    disabled={mark.isPending}
                    onClick={() => mark.mutate({ id: task.id, acted: !task.acted_at })}
                  >
                    {task.acted_at ? "Undo" : "Mark done"}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="footnote">
        The counts are what the scans saw before you marked a task done and what they have seen
        since. Answers vary from one asking to the next, so a change is not proof the task caused
        it.
      </p>
      <ErrorNote error={mark.error} />
    </>
  );
}
