import {
  type Allowances,
  answerHostname,
  HOSTED_PAGES_ALLOWANCE,
  type Location,
  REGISTRAR_HELP,
  SUGGESTED_LABEL,
} from "@nearcited/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { formatDay } from "../lib/billing";
import { useCopy } from "../lib/copy";
import {
  HOSTED_WORDS,
  homeLink,
  hostedPagesKey,
  removedBecause,
  settingUp,
  WAITING_MS,
} from "../lib/hosted-pages";
import { ErrorNote } from "./ErrorNote";
import { Field } from "./Field";

interface HostedPagesProps {
  location: Location;
  /** What the organization's plan includes. Undefined until the organization has loaded. */
  allowances: Allowances | undefined;
  /** Where the account's pages are: "" for one's own, the operator's address when reading through. */
  base: string;
  /** Opens the tab where the website is kept. Left out for a reader who cannot edit. */
  onOpenSettings?: () => void;
  readOnly: boolean;
  /** Reads the location again, once its answer subdomain is made. */
  onChanged: () => unknown;
}

/**
 * Pages on the business's own domain, on its location's Website tab: the answer subdomain and the
 * one record its owner adds, or how to set one up. Shown where the plan includes it, and not where
 * the location's WordPress site is connected, since its pages go there.
 */
export function HostedPages({
  location,
  allowances,
  base,
  onOpenSettings,
  readOnly,
  onChanged,
}: HostedPagesProps) {
  const queryClient = useQueryClient();
  const included = allowances?.[HOSTED_PAGES_ALLOWANCE] !== undefined;
  const found = useQuery({
    queryKey: hostedPagesKey(location.id),
    queryFn: () => api.hostedPages(location.id),
    enabled: included,
    // The worker looks for the record on its own time, so the card asks again while it waits.
    refetchInterval: (query) => {
      const subdomain = query.state.data?.subdomain;
      return subdomain && settingUp(subdomain) ? WAITING_MS : false;
    },
  });
  const [label, setLabel] = useState(SUGGESTED_LABEL);
  const make = useMutation({
    mutationFn: () => api.makeAnswerSubdomain(location.id, label),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: hostedPagesKey(location.id) });
      onChanged();
    },
  });
  const { copied, copy } = useCopy();

  if (!included || !found.data) return null;
  const { barred, can_manage: canManage, subdomain, removed } = found.data;
  if (!subdomain && (barred === "not_included" || barred === "wordpress")) return null;
  const preview = answerHostname(label, location.website);

  return (
    <section className="visits" aria-labelledby="hosted-title">
      <div className="section-head">
        <h2 id="hosted-title">{HOSTED_WORDS.title}</h2>
      </div>
      {subdomain ? (
        <div className="paste-block">
          {subdomain.status === "removing" ? (
            <p role="status">{HOSTED_WORDS.removing}</p>
          ) : subdomain.live_at ? (
            <>
              <p role="status">
                {HOSTED_WORDS.live(subdomain.hostname)}{" "}
                <a
                  href={`https://${subdomain.hostname}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {subdomain.hostname}
                </a>
              </p>
              {subdomain.home_links ? (
                <p className="task-proof">{HOSTED_WORDS.linked}</p>
              ) : (
                <>
                  <p>{HOSTED_WORDS.link}</p>
                  <pre>
                    <code>{homeLink(subdomain.hostname)}</code>
                  </pre>
                  <div className="paste-actions">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => copy(homeLink(subdomain.hostname))}
                    >
                      {copied === "yes" ? "Copied" : HOSTED_WORDS.copyLink}
                    </button>
                    <span role="status">
                      {copied === "no" && "It could not be copied for you. Select it above."}
                    </span>
                  </div>
                </>
              )}
            </>
          ) : (
            <TheRecord subdomain={subdomain} />
          )}
          {!subdomain.website_matches && (
            <p className="error" role="alert">
              {HOSTED_WORDS.moved}
            </p>
          )}
          {subdomain.status === "paused" && <p role="status">{HOSTED_WORDS.paused}</p>}
          <p className="small muted">
            {HOSTED_WORDS.manage} <Link to={`${base}/connections`}>Connections</Link> page.
          </p>
        </div>
      ) : (
        <>
          <p className="lede">{HOSTED_WORDS.about}</p>
          {removed && (
            <p className="task-proof" role="status">
              {HOSTED_WORDS.removed(
                removed.hostname,
                removedBecause(removed.removal_reason),
                removed.removed_at ? formatDay(removed.removed_at) : "",
              )}
            </p>
          )}
          {barred === "unavailable" ? (
            <p>{HOSTED_WORDS.unavailable}</p>
          ) : barred === "no_own_domain" ? (
            <p>{HOSTED_WORDS.noOwnDomain}</p>
          ) : barred === "no_website" ? (
            <p>
              {HOSTED_WORDS.noWebsite}{" "}
              {onOpenSettings && (
                <button type="button" className="link" onClick={onOpenSettings}>
                  Add it in Settings
                </button>
              )}
            </p>
          ) : readOnly ? null : !canManage ? (
            <p>{HOSTED_WORDS.onlyManagers}</p>
          ) : (
            <form
              className="paste-block"
              onSubmit={(event) => {
                event.preventDefault();
                make.mutate();
              }}
            >
              <Field
                label={HOSTED_WORDS.label}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                hint={preview ? `Your pages would be at ${preview}` : HOSTED_WORDS.hint}
                autoComplete="off"
                spellCheck={false}
              />
              <div className="paste-actions">
                <button type="submit" className="secondary" disabled={make.isPending || !preview}>
                  {make.isPending ? HOSTED_WORDS.making : HOSTED_WORDS.makeIt}
                </button>
              </div>
              <ErrorNote error={make.error} />
            </form>
          )}
        </>
      )}
      <ErrorNote error={found.error} />
    </section>
  );
}

/** The one record to add, with where to add it and how far the worker has got. */
function TheRecord({
  subdomain,
}: {
  subdomain: NonNullable<Awaited<ReturnType<typeof api.hostedPages>>["subdomain"]>;
}) {
  const label = subdomain.hostname.split(".")[0] ?? "";
  const { copied, copy } = useCopy();
  const [which, setWhich] = useState<string | null>(null);
  const copyPart = (part: string, text: string) => {
    setWhich(part);
    void copy(text);
  };
  const parts = [
    { part: "Type", text: "CNAME" },
    { part: "Name", text: label },
    { part: "Target", text: subdomain.target },
  ];

  return (
    <>
      <p>{HOSTED_WORDS.record}</p>
      <ul className="record-parts" aria-label="The record to add">
        {parts.map(({ part, text }) => (
          <li key={part}>
            <span className="record-part">{part}</span>
            <span className="record-value">
              <code>{text}</code>{" "}
              <button type="button" className="link" onClick={() => copyPart(part, text)}>
                {which === part && copied === "yes" ? "Copied" : `Copy the ${part.toLowerCase()}`}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <p className="small muted">{HOSTED_WORDS.wholeName(subdomain.hostname)}</p>
      <p className="small muted">{HOSTED_WORDS.cloudflare}</p>
      <details>
        <summary className="paste-summary">{HOSTED_WORDS.where}</summary>
        <ul className="builders">
          {REGISTRAR_HELP.map((registrar) => (
            <li key={registrar.name}>
              <a href={registrar.url} target="_blank" rel="noopener noreferrer">
                {registrar.name}
              </a>
            </li>
          ))}
        </ul>
      </details>
      <p className="task-proof" role="status">
        {subdomain.registered_at
          ? HOSTED_WORDS.registering
          : subdomain.record === "proxied"
            ? HOSTED_WORDS.proxied
            : subdomain.record === "elsewhere"
              ? HOSTED_WORDS.elsewhere
              : HOSTED_WORDS.waiting(
                  formatDay(subdomain.waits_until ?? subdomain.checked_at ?? ""),
                )}
      </p>
    </>
  );
}
