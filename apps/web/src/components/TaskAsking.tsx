import { type Location, requestToSend, type Task } from "@nearcited/shared";
import { asking, REQUEST_WORDS } from "../lib/asking";
import { useCopy } from "../lib/copy";

interface TaskAskingProps {
  task: Task;
  location: Location;
}

/**
 * What an owner asks their customers for a review with, once a task holds the link to send: a
 * short request to copy into a text or an email. It is composed by rule from the business's name
 * and the link, and no model writes it. Nothing is sent from here and nothing is kept: the owner
 * sends it themselves, and copying it does not mark the task done.
 */
export function TaskAsking({ task, location }: TaskAskingProps) {
  const { copied, copy } = useCopy();
  const given = asking(task, location);
  if (!given) return null;
  const request = requestToSend(given);

  return (
    <div className="paste-block">
      <p>{REQUEST_WORDS.about}</p>
      <p className="request-text">{request}</p>
      <p>{REQUEST_WORDS.terms}</p>
      <div className="paste-actions">
        <button type="button" className="secondary" onClick={() => copy(request)}>
          {copied === "yes" ? "Copied" : REQUEST_WORDS.copy}
        </button>
        <span role="status">
          {copied === "no" && "It could not be copied for you. Select it above and copy it."}
        </span>
      </div>
    </div>
  );
}
