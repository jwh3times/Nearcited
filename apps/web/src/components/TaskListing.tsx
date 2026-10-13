import { type TaskListing as Held, readListing, type Task } from "@nearcited/shared";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { useCopy } from "../lib/copy";
import { askWords, keptWords, listingView, sentLink } from "../lib/listings";
import { ErrorNote } from "./ErrorNote";
import { Field } from "./Field";

interface TaskListingProps {
  task: Task;
  locationId: string;
  /** True while the operator is reading a customer's account: a listing is read, not given. */
  readOnly: boolean;
  onChanged: () => unknown;
}

/**
 * The business's own page on a task's site, and the link a customer is sent. The page an
 * assistant read is often a list, or somebody else's page, so the owner pastes the address of
 * their own once and it is kept for the location. Nothing looks for it and nothing opens it.
 * Where the site's review form has a known address the link goes straight to it, and everywhere
 * else it is the listing, from which a customer finds the form. On Google what is pasted is the
 * review link Google gives, and the task says where an owner copies it from.
 */
export function TaskListing({ task, locationId, readOnly, onChanged }: TaskListingProps) {
  if (!task.listing || listingView(task, readOnly) === "nothing") return null;
  return (
    <Listing
      listing={task.listing}
      locationId={locationId}
      readOnly={readOnly}
      onChanged={onChanged}
    />
  );
}

interface ListingProps extends Omit<TaskListingProps, "task"> {
  listing: Held;
}

function Listing({ listing, locationId, readOnly, onChanged }: ListingProps) {
  const { site, url } = listing;
  const sent = sentLink(listing);
  const words = askWords(site);
  const { copied, copy } = useCopy();
  // Open while one that is kept is being replaced. With none kept the field is always there.
  const [changing, setChanging] = useState(false);
  const [pasted, setPasted] = useState("");
  const [problem, setProblem] = useState<string>();

  const save = useMutation({
    mutationFn: (address: string) => api.setListing(locationId, site, address),
    onSuccess: async () => {
      await onChanged();
      setChanging(false);
      setPasted("");
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeListing(locationId, site),
    onSuccess: onChanged,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    // The same rule the API holds to, so what is wrong is said before anything is sent.
    const read = readListing(site, pasted);
    setProblem("problem" in read ? read.problem : undefined);
    if ("url" in read) save.mutate(read.url);
  }
  function change() {
    setPasted(url ?? "");
    setProblem(undefined);
    setChanging(true);
  }

  if (url !== null && sent !== null && !changing) {
    return (
      <div className="paste-block">
        <p>{keptWords(listing)}</p>
        <p className="listing-link">
          <a href={sent} target="_blank" rel="noopener noreferrer nofollow">
            {sent}
          </a>
        </p>
        {listing.review_url && (
          <p className="listing-link">
            Made from your listing:{" "}
            <a href={url} target="_blank" rel="noopener noreferrer nofollow">
              {url}
            </a>
          </p>
        )}
        <div className="paste-actions">
          <button type="button" className="secondary" onClick={() => copy(sent)}>
            {copied === "yes" ? "Copied" : "Copy the link"}
          </button>
          {!readOnly && (
            <>
              <button type="button" className="link" onClick={change}>
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
            </>
          )}
          <span role="status">
            {copied === "no" && "It could not be copied for you. Select it above and copy it."}
          </span>
        </div>
        <ErrorNote error={remove.error} />
      </div>
    );
  }

  return (
    <div className="paste-block">
      {words.finding && (
        <>
          <p>{words.finding.about}</p>
          <ol className="find-steps">
            {words.finding.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p>
            <a href={words.finding.help.href} target="_blank" rel="noopener noreferrer">
              {words.finding.help.label}
            </a>
          </p>
        </>
      )}
      <form onSubmit={submit} className="stack-tight" noValidate>
        <Field
          label={words.label}
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder={words.placeholder}
          value={pasted}
          disabled={save.isPending}
          onChange={(event) => setPasted(event.target.value)}
          error={problem}
          hint={words.hint}
        />
        <div className="paste-actions">
          <button
            type="submit"
            className="secondary"
            disabled={save.isPending || pasted.trim() === ""}
          >
            {save.isPending ? "Saving" : words.save}
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
