import { type Location, requestToSend, type Task } from "@nearcited/shared";
import { Link } from "react-router";
import { asking, CODE_WORDS, cardPath, REQUEST_WORDS } from "../lib/asking";
import { useCopy } from "../lib/copy";
import { useViewing } from "../lib/viewing";
import { DownloadCode, ReviewCode } from "./ReviewCode";

interface TaskAskingProps {
  task: Task;
  location: Location;
}

/**
 * What an owner asks their customers for a review with, once a task holds the link to send: a
 * short request to copy into a text or an email, and the same link as a code to print or save.
 * The request is composed by rule from the business's name and the link, and no model writes it;
 * the code is drawn in the browser. Nothing is sent from here and nothing is kept: the owner
 * sends and prints themselves, and doing either does not mark the task done.
 */
export function TaskAsking({ task, location }: TaskAskingProps) {
  const { copied, copy } = useCopy();
  const { base } = useViewing();
  const given = asking(task, location);
  if (!given) return null;
  const request = requestToSend(given);

  return (
    <>
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
      <div className="paste-block">
        <p>{CODE_WORDS.about}</p>
        <ReviewCode link={given.link} />
        <div className="paste-actions">
          <Link className="button secondary" to={cardPath(base, location.id, given.site)}>
            {CODE_WORDS.print}
          </Link>
          <DownloadCode given={given} />
        </div>
      </div>
    </>
  );
}
