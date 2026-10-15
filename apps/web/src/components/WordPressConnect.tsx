import {
  type Allowances,
  authorizeAddress,
  type Location,
  type LocationConnection,
  WORDPRESS_ALLOWANCE,
  type WordPressCheck,
} from "@nearcited/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { connectionsQuery } from "../lib/connections";
import { useCopy } from "../lib/copy";
import {
  CHECK_WORDS,
  CONNECT_STEPS,
  noteStarted,
  PASSWORDS_HELP,
  passwordsNote,
} from "../lib/wordpress";
import { ErrorNote } from "./ErrorNote";

interface WordPressConnectProps {
  location: Location;
  /** What the location is matched to. */
  connections: LocationConnection[];
  /** What the organization's plan includes. Undefined until the organization has loaded. */
  allowances: Allowances | undefined;
  /** Where the account's pages are: "" for one's own, the operator's address when reading through. */
  base: string;
  /** Opens the tab where the website is kept. Left out for a reader who cannot edit. */
  onOpenSettings?: () => void;
  readOnly: boolean;
  /** Reads the location again, once a site just connected has been read and matched to it. */
  onChanged: () => unknown;
}

/**
 * Publishing to the location's WordPress site, on its Website tab: connected, or how to connect
 * it. Shown where the plan includes it. Only an owner or admin connects, and does so by approving
 * on the site itself, so the card says first what they will see there.
 */
export function WordPressConnect({
  location,
  connections,
  allowances,
  base,
  onOpenSettings,
  readOnly,
  onChanged,
}: WordPressConnectProps) {
  const found = useQuery({
    ...connectionsQuery(location.organization_id),
    enabled: allowances?.[WORDPRESS_ALLOWANCE] !== undefined,
  });
  // Set where this browser keeps nothing for the tab, so coming back could not be told apart.
  const [unkept, setUnkept] = useState(false);
  const check = useMutation({
    mutationFn: () => api.checkWordPress(location.id),
    onSuccess: (checked: WordPressCheck) => {
      if (checked.verdict !== "ready" || !checked.authorize_url) return;
      const state = noteStarted(location.id);
      if (state) {
        window.location.assign(
          authorizeAddress(checked.authorize_url, window.location.origin, state),
        );
      } else {
        setUnkept(true);
      }
    },
  });
  const { copied, copy } = useCopy();
  // A site just connected is read by the worker in a moment, and matched to this location then.
  // The list of connections asks again until it has been; the location is read again after.
  const reading =
    found.data?.connections.some(
      (connection) =>
        connection.kind === "wordpress" &&
        connection.status === "working" &&
        connection.last_synced_at === null,
    ) ?? false;
  const wasReading = useRef(false);
  useEffect(() => {
    if (wasReading.current && !reading) onChanged();
    wasReading.current = reading;
  }, [reading, onChanged]);

  if (allowances?.[WORDPRESS_ALLOWANCE] === undefined) return null;
  const connected = connections.find((connection) => connection.kind === "wordpress");
  const offered = found.data?.available.includes("wordpress") ?? false;
  if (!connected && found.data && !offered) return null;
  const verdict = check.data?.verdict;

  return (
    <section className="visits" aria-labelledby="wordpress-title">
      <div className="section-head">
        <h2 id="wordpress-title">Publish to your WordPress site</h2>
      </div>
      {connected ? (
        <p className="lede">
          Connected to {connected.external_label}. Nothing on it changes until somebody here
          approves it. The account is managed on the{" "}
          <Link to={`${base}/connections`}>Connections</Link> page.
        </p>
      ) : reading ? (
        <p className="lede" role="status">
          Your site is connected. Reading it now; this takes a moment.
        </p>
      ) : readOnly ? (
        <p className="lede">Not connected.</p>
      ) : (
        <>
          <p className="lede">
            Once your WordPress site is connected, Nearcited can publish the pages written for your
            prompts and add your business details to your home page, each only after somebody here
            approves it.
          </p>
          {found.data && !found.data.can_manage ? (
            <p>Only your organization's owner or an admin can connect the site.</p>
          ) : !location.website ? (
            <p>
              {CHECK_WORDS.no_website}{" "}
              {onOpenSettings && (
                <button type="button" className="link" onClick={onOpenSettings}>
                  Add it in Settings
                </button>
              )}
            </p>
          ) : (
            <div className="paste-block">
              <p>What happens when you connect it:</p>
              <ol className="find-steps">
                {CONNECT_STEPS.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <div className="paste-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={check.isPending || (verdict === "ready" && !unkept)}
                  onClick={() => check.mutate()}
                >
                  {check.isPending || (verdict === "ready" && !unkept)
                    ? "Checking your site"
                    : "Connect your WordPress site"}
                </button>
              </div>
              {unkept && (
                <p className="task-proof" role="status">
                  This browser is not keeping anything for this page, so it could not tell your
                  return from WordPress apart from anyone else's. Allow this site to store data, or
                  try another browser.
                </p>
              )}
              {verdict && verdict !== "ready" && (
                <p className="task-proof" role="status">
                  {CHECK_WORDS[verdict]}
                </p>
              )}
              {verdict === "passwords_off" && (
                <>
                  <p className="draft-text">{passwordsNote(location.website)}</p>
                  <div className="paste-actions">
                    <button
                      type="button"
                      className="link"
                      onClick={() => copy(passwordsNote(location.website ?? ""))}
                    >
                      {copied === "yes" ? "Copied" : "Copy the note"}
                    </button>
                    <a href={PASSWORDS_HELP} target="_blank" rel="noopener noreferrer">
                      WordPress's page on application passwords
                    </a>
                  </div>
                </>
              )}
              <ErrorNote error={check.error ?? found.error} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
