import { type Allowances, checkAddress, type Location } from "@nearcited/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import { useCopy } from "../lib/copy";
import {
  BUILDERS,
  LINE_WORDS,
  LOOKING_FOR_MS,
  LOOKING_MS,
  lineKey,
  lineStanding,
  visitsOffer,
} from "../lib/visits";
import { ErrorNote } from "./ErrorNote";
import { VisitCounts } from "./VisitCounts";

interface VisitLineProps {
  location: Location;
  /** What the organization's plan includes. Undefined until the organization has loaded. */
  allowances: Allowances | undefined;
  /** Opens the tab where the website is kept. Left out for a reader who cannot edit. */
  onOpenSettings?: () => void;
  readOnly: boolean;
}

/**
 * Visits from assistants, on a location's Website tab: what its site has reported, then the line
 * its owner pastes into their own site, where it goes, and whether it has been seen there. Shown
 * where the plan counts visits. On a plan that does not, it says so, only where some plan does,
 * and still shows what was counted while one did.
 */
export function VisitLine({ location, allowances, onOpenSettings, readOnly }: VisitLineProps) {
  const plans = useQuery({
    queryKey: ["plans"],
    queryFn: api.plans,
    staleTime: 300_000,
    enabled: allowances !== undefined && visitsOffer(allowances, undefined) !== "included",
  });
  // The way to the plans is the owner's, and the account page has already asked who that is.
  const account = useQuery({
    queryKey: ["account", location.organization_id],
    queryFn: () => api.organizationAccount(location.organization_id),
    enabled: !readOnly,
  });
  const offer = visitsOffer(allowances, plans.data);
  if (allowances === undefined || offer === "nowhere") return null;

  return (
    <section className="visits" aria-labelledby="visits-title">
      <div className="section-head">
        <h2 id="visits-title">{LINE_WORDS.title}</h2>
      </div>
      {offer === "included" ? (
        <>
          <VisitCounts locationId={location.id} />
          <TheLine location={location} onOpenSettings={onOpenSettings} readOnly={readOnly} />
        </>
      ) : (
        <>
          <p className="lede">
            {LINE_WORDS.notOnPlan}{" "}
            {account.data?.billing != null && <Link to="/pricing">See plans</Link>}
          </p>
          {/* Nothing more is counted. What was, while a plan counted it, is still there to read. */}
          <VisitCounts locationId={location.id} kept />
        </>
      )}
    </section>
  );
}

/** The line itself, for a location whose visits are counted. */
function TheLine({ location, onOpenSettings, readOnly }: Omit<VisitLineProps, "allowances">) {
  const queryClient = useQueryClient();
  // Set when the owner goes to look at their own site, which is when the line may answer.
  const [looking, setLooking] = useState(false);
  const line = useQuery({
    queryKey: lineKey(location.id),
    queryFn: () => api.getLine(location.id),
    refetchInterval: looking ? LOOKING_MS : false,
    // The owner is on their own site, in another tab, when the answer comes.
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    if (!looking) return;
    const stop = window.setTimeout(() => setLooking(false), LOOKING_FOR_MS);
    return () => window.clearTimeout(stop);
  }, [looking]);
  const answeredToday = line.data?.line.checked_on === new Date().toISOString().slice(0, 10);
  useEffect(() => {
    if (answeredToday) setLooking(false);
  }, [answeredToday]);

  const { copied, copy } = useCopy();
  const replace = useMutation({
    mutationFn: () => api.replaceSiteKey(location.id),
    onSuccess: (replaced) => queryClient.setQueryData(lineKey(location.id), replaced),
  });
  const address = checkAddress(location.website);

  return (
    <div className="paste-block">
      <p>{LINE_WORDS.about}</p>
      {location.paused_by_plan ? (
        <p>{LINE_WORDS.paused}</p>
      ) : !address ? (
        <p>
          {LINE_WORDS.noWebsite}{" "}
          {onOpenSettings && (
            <button type="button" className="link" onClick={onOpenSettings}>
              Add it in Settings
            </button>
          )}
        </p>
      ) : line.isPending ? (
        <p role="status">Loading the line</p>
      ) : line.isError ? (
        <ErrorNote error={line.error} />
      ) : (
        <>
          <div className="paste-actions">
            <button type="button" className="secondary" onClick={() => copy(line.data.html)}>
              {copied === "yes" ? "Copied" : LINE_WORDS.copy}
            </button>
            <span role="status">
              {copied === "no" && "It could not be copied for you. Select it below and copy it."}
            </span>
          </div>
          {/* A browser may refuse the clipboard. The line is opened to be copied by hand. */}
          <details open={copied === "no" || undefined}>
            <summary className="paste-summary">{LINE_WORDS.see}</summary>
            <pre>
              <code>{line.data.html}</code>
            </pre>
          </details>
          <p>{LINE_WORDS.where}</p>
          <details>
            <summary className="paste-summary">{LINE_WORDS.builders}</summary>
            <ul className="builders">
              {BUILDERS.map((builder) => (
                <li key={builder.name}>
                  <strong>{builder.name}.</strong> {builder.where}
                </li>
              ))}
            </ul>
          </details>
          <p>{LINE_WORDS.checking}</p>
          <div className="paste-actions">
            <a
              className="secondary"
              href={address}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setLooking(true)}
            >
              {LINE_WORDS.check}
            </a>
            <span role="status">
              {looking && !answeredToday
                ? "Looking for the line on your site"
                : lineStanding(line.data.line)}
            </span>
          </div>
          {line.data.can_replace && !readOnly && (
            <details>
              <summary className="paste-summary">{LINE_WORDS.replace}</summary>
              <div className="paste-folded">
                <p>{LINE_WORDS.replacing}</p>
                <div className="paste-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={replace.isPending}
                    onClick={() => {
                      if (window.confirm(LINE_WORDS.confirm)) replace.mutate();
                    }}
                  >
                    {LINE_WORDS.replace}
                  </button>
                  <span role="status">
                    {replace.isSuccess &&
                      "The key was replaced. Paste the new line into your site."}
                  </span>
                </div>
                <ErrorNote error={replace.error} />
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
