import {
  type Allowances,
  type Location,
  REVIEW_REQUESTS_ALLOWANCE,
  type ReviewRequestSettings,
  type ReviewSite,
  siteName,
} from "@nearcited/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { formatDay } from "../lib/billing";
import { useCopy } from "../lib/copy";
import { barNote, REVIEW_WORDS, reviewRequestsKey, wordingFor } from "../lib/review-requests";
import { ErrorNote } from "./ErrorNote";
import { Field } from "./Field";

interface ReviewRequestsProps {
  location: Location;
  /** What the organization's plan includes. Undefined until the organization has loaded. */
  allowances: Allowances | undefined;
  readOnly: boolean;
}

/**
 * A location's review requests, on its Settings tab: turning them on, with the site to ask for,
 * where replies go and the wording to approve, and once they are on, the receipt address to copy
 * receipts to. Shown where the plan includes them. Any member reads them; only an owner or admin
 * turns them on or off, or replaces the address.
 */
export function ReviewRequests({ location, allowances, readOnly }: ReviewRequestsProps) {
  const included = allowances?.[REVIEW_REQUESTS_ALLOWANCE] !== undefined;
  const found = useQuery({
    queryKey: reviewRequestsKey(location.id),
    queryFn: () => api.reviewRequests(location.id),
    enabled: included,
  });

  if (!included || !found.data) return null;
  const { barred, can_manage: canManage, settings, sites, reply_to: replyTo } = found.data;

  return (
    <section className="card settings-main" aria-labelledby="review-requests-title">
      <div>
        <h2 id="review-requests-title">{REVIEW_WORDS.title}</h2>
        <p className="small muted">{REVIEW_WORDS.about}</p>
      </div>
      {settings ? (
        <TurnedOn
          location={location}
          settings={settings}
          sites={sites}
          canManage={canManage && !readOnly}
        />
      ) : barred ? (
        <p>{barNote(barred)}</p>
      ) : readOnly ? null : !canManage ? (
        <p>{REVIEW_WORDS.onlyManagers}</p>
      ) : (
        <TurnOn location={location} sites={sites} replyTo={replyTo ?? ""} />
      )}
      <ErrorNote error={found.error} />
    </section>
  );
}

/** The form an owner or admin turns review requests on with. */
function TurnOn({
  location,
  sites,
  replyTo,
}: {
  location: Location;
  sites: ReviewSite[];
  replyTo: string;
}) {
  const queryClient = useQueryClient();
  const [site, setSite] = useState(sites[0]?.site ?? "");
  const [reply, setReply] = useState(replyTo);
  const [confirmed, setConfirmed] = useState(false);
  const chosen = sites.find((candidate) => candidate.site === site) ?? sites[0];
  const turnOn = useMutation({
    mutationFn: () =>
      api.turnOnReviewRequests(location.id, {
        site: chosen?.site ?? "",
        reply_to: reply,
        confirmed: true,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reviewRequestsKey(location.id) }),
  });
  if (!chosen) return null;

  return (
    <form
      className="paste-block"
      onSubmit={(event) => {
        event.preventDefault();
        if (confirmed) turnOn.mutate();
      }}
    >
      <div className="field">
        <label>
          {REVIEW_WORDS.site}
          <select value={chosen.site} onChange={(event) => setSite(event.target.value)}>
            {sites.map((candidate) => (
              <option key={candidate.site} value={candidate.site}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        <span className="field-note">{REVIEW_WORDS.siteHint}</span>
      </div>
      <Field
        label={REVIEW_WORDS.replyTo}
        type="email"
        autoComplete="email"
        maxLength={254}
        value={reply}
        onChange={(event) => setReply(event.target.value)}
        hint={REVIEW_WORDS.replyHint}
      />
      <Wording location={location} site={chosen} />
      <label className="check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        <span>{REVIEW_WORDS.confirm}</span>
      </label>
      <div className="paste-actions">
        <button type="submit" disabled={!confirmed || turnOn.isPending}>
          {turnOn.isPending ? REVIEW_WORDS.turningOn : REVIEW_WORDS.turnOn}
        </button>
      </div>
      <ErrorNote error={turnOn.error} />
    </form>
  );
}

/** The email a customer is sent, as it stands: read, approved, and never edited. */
function Wording({ location, site }: { location: Location; site: ReviewSite }) {
  const email = wordingFor(location, site);
  return (
    <div>
      <h3 className="side-title">{REVIEW_WORDS.wording}</h3>
      <pre className="wording">
        {`From: ${email.sender}\nSubject: ${email.subject}\n\n${email.body}`}
      </pre>
      <p className="small muted">{REVIEW_WORDS.wordingNote}</p>
    </div>
  );
}

/** Review requests that are on: the receipt address, what they ask for, and turning them off. */
function TurnedOn({
  location,
  settings,
  sites,
  canManage,
}: {
  location: Location;
  settings: ReviewRequestSettings;
  sites: ReviewSite[];
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: reviewRequestsKey(location.id) });
  const { copied, copy } = useCopy();
  const replace = useMutation({
    mutationFn: () => api.replaceReceiptAddress(location.id),
    onSuccess: refresh,
  });
  const turnOff = useMutation({
    mutationFn: () => api.removeConnection(settings.connection_id),
    onSuccess: refresh,
  });
  const site = sites.find((candidate) => candidate.site === settings.site);
  const stopping = settings.status === "removing" || settings.status === "removed";

  return (
    <div className="paste-block">
      {stopping ? (
        <p role="status">{REVIEW_WORDS.turningOff}</p>
      ) : (
        <>
          <p>{REVIEW_WORDS.receipt}</p>
          <pre>
            <code>{settings.receipt_address}</code>
          </pre>
          <div className="paste-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => copy(settings.receipt_address)}
            >
              {copied === "yes" ? "Copied" : REVIEW_WORDS.copyAddress}
            </button>
            {canManage && (
              <button
                type="button"
                className="link"
                disabled={replace.isPending}
                onClick={() => replace.mutate()}
              >
                {REVIEW_WORDS.newAddress}
              </button>
            )}
            <span role="status">
              {copied === "no" && "It could not be copied for you. Select it above."}
            </span>
          </div>
          {canManage && <p className="small muted">{REVIEW_WORDS.newAddressNote}</p>}
        </>
      )}
      {settings.status === "paused" && <p role="status">{REVIEW_WORDS.paused}</p>}
      <ul className="facts">
        <li>
          <span>{REVIEW_WORDS.site}</span>
          <span>{siteName(settings.site)}</span>
        </li>
        <li>
          <span>{REVIEW_WORDS.replyTo}</span>
          <span>{settings.reply_to}</span>
        </li>
      </ul>
      {site && <Wording location={location} site={site} />}
      <p className="small muted">
        {REVIEW_WORDS.turnedOn(settings.turned_on_by_email, formatDay(settings.turned_on_at))}
      </p>
      {canManage && !stopping && (
        <div className="paste-actions">
          <button
            type="button"
            className="secondary"
            disabled={turnOff.isPending}
            onClick={() => {
              if (window.confirm(REVIEW_WORDS.turnOffAsk)) turnOff.mutate();
            }}
          >
            {REVIEW_WORDS.turnOff}
          </button>
        </div>
      )}
      <ErrorNote error={replace.error ?? turnOff.error} />
    </div>
  );
}
