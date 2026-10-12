import type { Task } from "@nearcited/shared";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { KIND_LABELS, markedDone, proof } from "../lib/tasks";
import { ErrorNote } from "./ErrorNote";

interface TasksProps {
  tasks: Task[];
  onChanged: () => unknown;
  /** True while the operator is reading a customer's account: the tasks are shown, not acted on. */
  readOnly: boolean;
}

/**
 * The work that follows from the sources, one site each. Marking one done is kept with the
 * location, and the scans before that day are set beside the scans since. A task an action did
 * the work of is marked by that, and offers nothing to undo.
 */
export function Tasks({ tasks, onChanged, readOnly }: TasksProps) {
  const mark = useMutation({
    mutationFn: ({ id, acted }: { id: string; acted: boolean }) =>
      api.setRecommendationActed(id, acted),
    onSuccess: onChanged,
  });

  return (
    <>
      <h3>Your tasks</h3>
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
