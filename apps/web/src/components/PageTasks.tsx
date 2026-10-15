import {
  type DraftsStanding,
  type Location,
  type PageTask,
  readPageAddress,
} from "@nearcited/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { pageProof } from "../lib/pages";
import { markedDone } from "../lib/tasks";
import { ErrorNote } from "./ErrorNote";
import { Field } from "./Field";
import { TaskDraft } from "./TaskDraft";

interface PageTasksProps {
  tasks: PageTask[];
  location: Location;
  /** Where the organization's month of drafts stands. */
  drafts: DraftsStanding;
  onChanged: () => unknown;
  /** True while the operator is reading a customer's account: the tasks are shown, not acted on. */
  readOnly: boolean;
  /** Whether the location's WordPress site is connected, so a page's copy is offered for publishing. */
  publishes: boolean;
}

/**
 * A page for each prompt no answer named the business for. Its copy can be written as a draft,
 * which the owner publishes on their own site. Once it is up they mark the task done and may say
 * where the page is, and the scans before that day are set beside the scans since.
 */
export function PageTasks({
  tasks,
  location,
  drafts,
  onChanged,
  readOnly,
  publishes,
}: PageTasksProps) {
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

  return (
    <section className="page-tasks">
      <h3>Pages that answer your prompts</h3>
      <p className="lede">
        No answer to these prompts named {location.name}. A page on your own site that answers one
        in plain words gives an assistant something of yours to read for it.
      </p>
      {!readOnly && drafts.allowed === null && (
        <p className="footnote">
          Your plan does not include drafts written for you, so the copy for these pages is yours to
          write.
        </p>
      )}
      <ul className="steps">
        {tasks.map((task) => {
          const lines = pageProof(task);
          return (
            <li key={task.id} className="card also">
              <div className="task-body">
                <div className="step-title">
                  <h3>{task.title}</h3>
                </div>
                <p>{task.summary}</p>
                <TaskDraft
                  task={task}
                  location={location}
                  standing={drafts}
                  readOnly={readOnly}
                  isOwner={isOwner}
                  onChanged={onChanged}
                />
                {publishes && task.open && !task.page && task.draft?.text && (
                  <p className="task-proof">
                    Nearcited asks to publish this page on your WordPress site. Approve it, or
                    change it first, on the Actions tab.
                  </p>
                )}
                {task.acted_at && (
                  <PageAddress
                    task={task}
                    location={location}
                    readOnly={readOnly}
                    onChanged={onChanged}
                  />
                )}
                {task.acted_at && lines && (
                  <p className="task-proof">
                    {markedDone(task, formatDate(task.acted_at))}
                    <br />
                    {lines.before}
                    <br />
                    {lines.since}
                    {lines.cited && (
                      <>
                        <br />
                        {lines.cited}
                      </>
                    )}
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
                    {task.acted_at ? "Undo" : "Mark published"}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="footnote">
        The counts are what the scans saw of each prompt before you marked its page published and
        what they have seen since. Answers vary from one asking to the next, so a change is not
        proof the page caused it.
      </p>
      <ErrorNote error={mark.error} />
    </section>
  );
}

interface PageAddressProps {
  task: PageTask;
  location: Location;
  readOnly: boolean;
  onChanged: () => unknown;
}

/**
 * Where the page is, which a member gives once it is up so the scans can count the answers that
 * cite it. Only its shape is checked: a page of the location's own website. Nothing opens it.
 */
function PageAddress({ task, location, readOnly, onChanged }: PageAddressProps) {
  const url = task.page?.url ?? null;
  const [changing, setChanging] = useState(false);
  const [pasted, setPasted] = useState("");
  const [problem, setProblem] = useState<string>();

  const save = useMutation({
    mutationFn: (address: string) => api.setPromptPage(location.id, task.id, address),
    onSuccess: async () => {
      await onChanged();
      setChanging(false);
      setPasted("");
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removePromptPage(location.id, task.id),
    onSuccess: onChanged,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    // The same rule the API holds to, so what is wrong is said before anything is sent.
    const read = readPageAddress(location.website, pasted);
    setProblem("problem" in read ? read.problem : undefined);
    if ("url" in read) save.mutate(read.url);
  }

  if (url !== null && !changing) {
    return (
      <div className="paste-block">
        <p>{task.page?.action_id ? "Published by Nearcited at" : "The page is at"}</p>
        <p className="listing-link">
          <a href={url} target="_blank" rel="noopener noreferrer nofollow">
            {url}
          </a>
        </p>
        {!readOnly && !task.page?.action_id && (
          <div className="paste-actions">
            <button
              type="button"
              className="link"
              onClick={() => {
                setPasted(url);
                setProblem(undefined);
                setChanging(true);
              }}
            >
              Change
            </button>
            <button
              type="button"
              className="link"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Remove
            </button>
          </div>
        )}
        <ErrorNote error={remove.error} />
      </div>
    );
  }
  if (readOnly) return null;

  return (
    <div className="paste-block">
      <form onSubmit={submit} className="stack-tight" noValidate>
        <Field
          label="Where is the page?"
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://"
          value={pasted}
          disabled={save.isPending}
          onChange={(event) => setPasted(event.target.value)}
          error={problem}
          hint="Open the page on your site and copy the address from the top of the browser. With it, the scans count the answers that cite the page."
        />
        <div className="paste-actions">
          <button
            type="submit"
            className="secondary"
            disabled={save.isPending || pasted.trim() === ""}
          >
            {save.isPending ? "Saving" : "Save the address"}
          </button>
          {changing && (
            <button type="button" className="link" onClick={() => setChanging(false)}>
              Cancel
            </button>
          )}
        </div>
        <ErrorNote error={save.error} />
      </form>
    </div>
  );
}
