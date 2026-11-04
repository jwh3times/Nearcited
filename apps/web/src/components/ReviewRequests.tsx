import {
  type Allowances,
  type Location,
  RECEIPT_DROPS,
  RECEIPT_DROPS_DAYS,
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
import {
  barNote,
  droppedNote,
  REVIEW_WORDS,
  receiptsKey,
  reviewRequestsKey,
  senderNote,
  wordingFor,
} from "../lib/review-requests";
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
        <>
          <TurnedOn
            location={location}
            settings={settings}
            sites={sites}
            canManage={canManage && !readOnly}
          />
          <Receipts location={location} readOnly={readOnly} />
        </>
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

/**
 * What came to the receipt address: the senders, which an owner or admin confirms or declines,
 * the customers kept, masked, and how many receipts were dropped and why. Nobody is shown more of
 * a customer's address than its first letter and its domain.
 */
function Receipts({ location, readOnly }: { location: Location; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const found = useQuery({
    queryKey: receiptsKey(location.id),
    queryFn: () => api.receipts(location.id),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: receiptsKey(location.id) });
  const confirm = useMutation({ mutationFn: api.confirmReceiptSender, onSuccess: refresh });
  const decline = useMutation({ mutationFn: api.declineReceiptSender, onSuccess: refresh });
  if (!found.data) return <ErrorNote error={found.error} />;
  const { senders, contacts, dropped, can_manage: canManage } = found.data;
  const deciding = confirm.isPending || decline.isPending;
  const drops = RECEIPT_DROPS.flatMap((reason) => {
    const count = dropped[reason];
    return count ? [droppedNote(reason, count)] : [];
  });

  return (
    <div className="paste-block">
      <h3 className="side-title">{REVIEW_WORDS.receipts}</h3>
      {senders.length > 0 && (
        <div>
          <h4>{REVIEW_WORDS.sendersTitle}</h4>
          <p className="small muted">{REVIEW_WORDS.sendersAbout}</p>
          <ul className="facts">
            {senders.map((sender) => (
              <li key={sender.id}>
                <span>{sender.address}</span>
                <span>
                  {senderNote(sender.status)}
                  {sender.status === "waiting" && canManage && !readOnly && (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="link"
                        disabled={deciding}
                        onClick={() => confirm.mutate(sender.id)}
                      >
                        {REVIEW_WORDS.confirmSender}
                      </button>{" "}
                      <button
                        type="button"
                        className="link"
                        disabled={deciding}
                        onClick={() => decline.mutate(sender.id)}
                      >
                        {REVIEW_WORDS.declineSender}
                      </button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {!canManage && senders.some((sender) => sender.status === "waiting") && (
            <p className="small muted">{REVIEW_WORDS.onlyManagersDecide}</p>
          )}
        </div>
      )}
      <div>
        <h4>{REVIEW_WORDS.contactsTitle}</h4>
        {contacts.length === 0 ? (
          <p className="small muted">{REVIEW_WORDS.noContacts}</p>
        ) : (
          <>
            <p className="small muted">{REVIEW_WORDS.contactsAbout}</p>
            <ul className="facts">
              {contacts.map((contact) => (
                <li key={contact.id}>
                  <span>
                    {contact.masked}
                    {contact.sample_data && ` (${REVIEW_WORDS.sample})`}
                  </span>
                  <span>
                    {formatDay(`${contact.job_day}T12:00:00Z`)}:{" "}
                    {contact.status === "held" ? REVIEW_WORDS.held : REVIEW_WORDS.ready}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {drops.length > 0 && (
        <div>
          <p className="small muted">In the last {RECEIPT_DROPS_DAYS} days:</p>
          <ul className="small muted">
            {drops.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      <ErrorNote error={confirm.error ?? decline.error} />
    </div>
  );
}
