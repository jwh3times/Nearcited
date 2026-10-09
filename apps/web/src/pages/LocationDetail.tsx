import {
  type LocationDetail as Detail,
  hostOf,
  QUERY_KIND_LABELS,
  type QueryKind,
  type ScanWithResults,
  SURFACE_LABELS,
  TrackedQueryInputSchema,
} from "@nearcited/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ActionPlan } from "../components/ActionPlan";
import { ErrorNote } from "../components/ErrorNote";
import { Field } from "../components/Field";
import { LocationEditor } from "../components/LocationEditor";
import { NamedInstead } from "../components/NamedInstead";
import { PausedByPlan } from "../components/PausedByPlan";
import { PromptGrid } from "../components/PromptGrid";
import { Quote } from "../components/Quote";
import { ScoreCard } from "../components/ScoreCard";
import { SiteChecklist } from "../components/SiteChecklist";
import { SourceTable } from "../components/SourceTable";
import { api } from "../lib/api";
import { useFormErrors } from "../lib/form";
import { cadence, formatDate, listOf } from "../lib/format";
import { locationKey, placeOf, scansKey } from "../lib/locations";
import { tallyCompetitors } from "../lib/matrix";
import { windowRate } from "../lib/summary";
import { neighbour, TAB_LABELS, TABS, type Tab, tabFrom } from "../lib/tabs";
import { buildTrend } from "../lib/trend";
import { useViewing } from "../lib/viewing";

const inFlight = (scan: ScanWithResults | null) =>
  scan?.status === "queued" || scan?.status === "running";

const scans = (count: number) => `${count} ${count === 1 ? "scan" : "scans"}`;

export function LocationDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = tabFrom(params.get("tab"));
  const { base, readOnly } = useViewing();
  const home = base || "/";
  const tabbar = useRef<HTMLDivElement>(null);
  const queryKey = locationKey(id);
  const historyKey = scansKey(id);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: historyKey });
  };

  const detail = useQuery({
    queryKey,
    queryFn: () => api.getLocation(id),
    // Poll only while a scan is under way.
    refetchInterval: (query) => (inFlight(query.state.data?.latest_scan ?? null) ? 2000 : false),
  });

  const history = useQuery({ queryKey: historyKey, queryFn: () => api.listScans(id) });
  // The page above polls while a scan is under way. When it sees the scan end, the list of scans
  // behind the score and its chart is stale too, here and in the sidebar, so it is fetched again.
  const latestScan = detail.data?.latest_scan;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scan changing state is the trigger
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: scansKey(id) });
  }, [id, latestScan?.id, latestScan?.status]);
  // Already loaded by the page shell, so this reads the cache.
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  // Reading through, the organization is a customer's, which the shell has loaded the same way.
  const theirId = detail.data?.location.organization_id;
  const theirs = useQuery({
    queryKey: ["operator-organization", theirId],
    queryFn: () => api.operatorOrganization(theirId ?? ""),
    enabled: readOnly && theirId !== undefined,
  });

  const startScan = useMutation({ mutationFn: () => api.startScan(id), onSuccess: refresh });
  const setQueryActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.setQueryActive(id, active),
    onSuccess: refresh,
  });
  const removeLocation = useMutation({
    mutationFn: () => api.deleteLocation(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["locations"] });
      navigate("/");
    },
  });

  if (detail.isPending) return <p className="page status">Loading location</p>;
  if (detail.isError) {
    return (
      <main className="page">
        <ErrorNote error={detail.error} />
        <Link to={home}>Back to locations</Link>
      </main>
    );
  }

  const {
    location,
    queries,
    latest_scan: scan,
    window: scanWindow,
    surfaces,
    recommendations,
    site,
    actions,
  } = detail.data;
  const organization = readOnly
    ? theirs.data
    : me.data?.organizations.find((candidate) => candidate.id === location.organization_id);
  const active = queries.filter((query) => query.is_active);
  const retired = queries.filter((query) => !query.is_active);
  const results = scan?.status === "succeeded" ? scan.results : [];
  const excerpts = results.filter((result) => result.answer_excerpt);
  const trend = buildTrend(history.data ?? []);
  const failedChecks = site?.checks.filter((check) => !check.passed).length ?? 0;
  // The action plan covers what the sources and the website check found, with the evidence
  // attached, so those recommendations are not listed a second time below it.
  const inPlan = (rule: string) =>
    rule.startsWith("source:") || rule.startsWith("site:") || rule === "own_site_uncited";
  const open = recommendations.filter(
    (recommendation) => recommendation.status === "open" && !inPlan(recommendation.rule),
  );
  const scanning = inFlight(scan) || startScan.isPending;
  const assistants = listOf(surfaces.map((surface) => SURFACE_LABELS[surface]));

  /** Swaps the tab in place. If the bar is stuck to the top, the new tab starts at the top. */
  function openTab(next: Tab) {
    setParams(next === "overview" ? {} : { tab: next }, {
      replace: true,
      preventScrollReset: true,
    });
    const top = tabbar.current?.offsetTop ?? 0;
    if (window.scrollY > top) window.scrollTo({ top });
  }

  function onTabKey(event: KeyboardEvent) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : null;
    if (step === null) return;
    event.preventDefault();
    const next = neighbour(tab, step);
    openTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  }

  return (
    <main>
      <div className="detail-head">
        <p className="breadcrumb">
          <Link to={home}>Locations</Link> / {location.name}
        </p>
        <div className="title-row">
          <div>
            <h1>{location.name}</h1>
            <p className="meta-row">
              <span>{placeOf(location)}</span>
              {location.website && (
                <a href={location.website} rel="noreferrer">
                  {hostOf(location.website) ?? location.website}
                </a>
              )}
              <ScanLine detail={detail.data} />
              {organization &&
                location.scan_frequency !== "off" &&
                !location.paused_by_plan &&
                surfaces.length > 0 && (
                  <span>
                    Scanned {cadence(organization.scan_every_days, location.scan_frequency)} on{" "}
                    {assistants}
                  </span>
                )}
            </p>
          </div>
          {!readOnly && !location.paused_by_plan && (
            <div className="head-actions">
              <button
                type="button"
                className="fill-narrow"
                onClick={() => startScan.mutate()}
                disabled={scanning || active.length === 0}
              >
                {scanning ? "Scanning…" : "Run scan"}
              </button>
            </div>
          )}
        </div>
        {location.paused_by_plan && organization && (
          <PausedByPlan location={location} organization={organization} readOnly={readOnly} />
        )}
        {scanning && (
          <p className="card scan-bar" role="status">
            Asking {assistants || "the assistants"} your {active.length}{" "}
            {active.length === 1 ? "prompt" : "prompts"}. This page updates when the scan finishes.
          </p>
        )}
        {!scanning && scan?.status === "failed" && (
          <p className="card scan-bar failed" role="alert">
            The last scan failed: {scan.error ?? "no reason was recorded."}
          </p>
        )}
        <ErrorNote error={startScan.error} />
      </div>

      <div className="tabbar" ref={tabbar}>
        <div className="tabs" role="tablist" aria-label={location.name} onKeyDown={onTabKey}>
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`tab-${name}`}
              className="tab"
              aria-selected={tab === name}
              aria-controls="tabpanel"
              tabIndex={tab === name ? 0 : -1}
              onClick={() => openTab(name)}
            >
              {TAB_LABELS[name]}
              {name === "prompts" && active.length > 0 && (
                <span className="badge">{active.length}</span>
              )}
              {name === "website" && failedChecks > 0 && (
                <span className="badge bad">{failedChecks}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div
        id="tabpanel"
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        className={`tab-body${tab === "website" || tab === "answers" ? " narrow" : ""}`}
      >
        {tab === "overview" &&
          (trend.length === 0 && results.length === 0 ? (
            <FirstScan hasPrompts={active.length > 0} onOpenTab={openTab} />
          ) : (
            <div className="overview">
              <div>
                {actions.length > 0 ? (
                  <>
                    <ActionPlan
                      locationId={location.id}
                      actions={actions}
                      onOpenTab={openTab}
                      readOnly={readOnly}
                    />
                    <p className="footnote">
                      Worked out by rule from the answers of the last {scans(scanWindow.scans)} and
                      the latest check of your website. Each step says what was seen, so later scans
                      show whether it moved.
                    </p>
                  </>
                ) : (
                  <>
                    <h2>What to do next</h2>
                    <p className="lede">
                      Nothing yet. Steps appear here once the answers and the website check give a
                      reason for one.
                    </p>
                  </>
                )}
                {open.length > 0 && (
                  <Recommendations items={open} onChanged={refresh} readOnly={readOnly} />
                )}
              </div>
              <div>
                <ScoreCard trend={trend} named={windowRate(scanWindow.cells)} />
                {results.length > 0 && (
                  <NamedInstead
                    mentions={results.filter((result) => result.mentioned).length}
                    checks={results.length}
                    competitors={tallyCompetitors(results, 6)}
                  />
                )}
              </div>
            </div>
          ))}

        {tab === "prompts" && (
          <>
            <div className="section-head">
              <h2>Where you're named</h2>
              {results.length > 0 && (
                <span className="small">
                  {scanWindow.scans <= 1
                    ? `One scan so far. These become "named in x of y" as more come in, up to the last ${scanWindow.size}.`
                    : `Counted over the last ${scans(scanWindow.scans)}${scanWindow.scans < scanWindow.size ? `, building up to ${scanWindow.size}` : ""}. The score is counted the same way.`}
                </span>
              )}
            </div>
            {active.length === 0 ? (
              <p className="lede">
                Nothing to check yet. Add a prompt someone would ask an assistant, or a keyword they
                would search on Google, then run a scan.
              </p>
            ) : (
              <PromptGrid
                queries={active}
                results={results}
                window={scanWindow}
                surfaces={surfaces}
                onRetire={
                  readOnly
                    ? undefined
                    : (queryId) => setQueryActive.mutate({ id: queryId, active: false })
                }
              />
            )}
            <ErrorNote error={setQueryActive.error} />
            {!readOnly && (
              <AddQuery
                locationId={location.id}
                onAdded={refresh}
                used={active.length}
                allowed={organization?.max_queries_per_location}
              />
            )}
          </>
        )}

        {tab === "sources" && (
          <>
            <h2>Where the answers come from</h2>
            {scanWindow.sources.length > 0 ? (
              <>
                <p className="intro">
                  The sites the assistants read before answering, over the last{" "}
                  {scans(scanWindow.scans)}. A site read often in answers that never name you is the
                  first place to check your listing.
                </p>
                <SourceTable sources={scanWindow.sources} answers={scanWindow.answers} />
              </>
            ) : (
              <p className="lede">
                No sources yet. They appear once a scan's answers say which sites they read.
              </p>
            )}
          </>
        )}

        {tab === "website" && (
          <>
            <div className="section-head">
              <h2>Your website</h2>
              {site && site.checks.length > 0 && (
                <span className="mono">
                  {site.checks.length - failedChecks} of {site.checks.length} passed
                </span>
              )}
            </div>
            {site ? (
              <SiteChecklist site={site} />
            ) : (
              <p className="lede">
                {location.website
                  ? "The website has not been checked yet. It is read as part of the next scan."
                  : "There is no website on file for this location. Add one under Settings and the next scan will read it."}
              </p>
            )}
          </>
        )}

        {tab === "answers" && (
          <>
            <h2>What the answers said</h2>
            {excerpts.length > 0 ? (
              <div className="quotes">
                {excerpts.map((result) => (
                  <Quote
                    key={result.id}
                    assistant={SURFACE_LABELS[result.surface]}
                    prompt={queries.find((query) => query.id === result.tracked_query_id)?.text}
                    excerpt={result.answer_excerpt ?? ""}
                    name={location.name}
                    citedUrls={result.cited_urls}
                  />
                ))}
              </div>
            ) : (
              <p className="lede">No answers yet. They appear here after the next scan.</p>
            )}
          </>
        )}

        {tab === "settings" && (
          <div className="settings">
            <LocationEditor
              // Another location starts the form from what is on file for it.
              key={location.id}
              location={location}
              readOnly={readOnly}
              planDays={organization?.scan_every_days}
              onSaved={async () => {
                refresh();
                await queryClient.invalidateQueries({ queryKey: ["locations"] });
              }}
            />
            <div className="settings-side">
              <div className="card side-card">
                <h3 className="side-title">Retired prompts</h3>
                <p>
                  Retired prompts keep their history but aren't asked anymore. Their results count
                  again if you restore them.
                </p>
                {retired.length === 0 ? (
                  <p>None retired.</p>
                ) : (
                  <ul>
                    {retired.map((query) => (
                      <li key={query.id}>
                        <span>
                          {query.text}
                          {query.set_aside_by_plan && (
                            <span className="small muted"> · set aside by your plan</span>
                          )}
                        </span>
                        {!readOnly && (
                          <button
                            type="button"
                            className="link"
                            aria-label={`Restore "${query.text}"`}
                            onClick={() => setQueryActive.mutate({ id: query.id, active: true })}
                          >
                            Restore
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <ErrorNote error={setQueryActive.error} />
              </div>
              {!readOnly && (
                <div className="card side-card danger">
                  <h3 className="side-title bad">Delete this location</h3>
                  <p>Removes the location, its prompts and keywords, and every scan.</p>
                  <button
                    type="button"
                    className="danger"
                    disabled={removeLocation.isPending}
                    onClick={() => {
                      if (window.confirm(`Delete ${location.name} and all of its scans?`)) {
                        removeLocation.mutate();
                      }
                    }}
                  >
                    Delete location
                  </button>
                  <ErrorNote error={removeLocation.error} />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

/** When the location was last scanned, for the line under its name. */
function ScanLine({ detail }: { detail: Detail }) {
  const scan = detail.latest_scan;
  if (!scan) return <span>No scans yet</span>;
  if (scan.status !== "succeeded") return null;
  return <span>Scanned {formatDate(scan.finished_at ?? scan.created_at)}</span>;
}

/** The Overview of a location that has never been scanned. */
function FirstScan({
  hasPrompts,
  onOpenTab,
}: {
  hasPrompts: boolean;
  onOpenTab: (tab: Tab) => void;
}) {
  return (
    <>
      <h2>No scans yet</h2>
      <p className="lede">
        {hasPrompts
          ? "Run a scan to see how often this location is named, who is named instead, and what to do about it."
          : "Add a prompt a customer would ask an assistant, then run a scan."}
      </p>
      {!hasPrompts && (
        <button type="button" className="go" onClick={() => onOpenTab("prompts")}>
          Add prompts →
        </button>
      )}
    </>
  );
}

function AddQuery({
  locationId,
  onAdded,
  used,
  allowed,
}: {
  locationId: string;
  onAdded: () => unknown;
  /** Active prompts on this location, and how many its organization allows. */
  used: number;
  allowed: number | undefined;
}) {
  // The database enforces the limit. This only saves a round trip and says why.
  const atLimit = allowed !== undefined && used >= allowed;
  const [kind, setKind] = useState<QueryKind>("ai_prompt");
  const [text, setText] = useState("");
  const create = useMutation({
    mutationFn: () => api.createQuery(locationId, { kind, text }),
    onSuccess: () => {
      setText("");
      form$.reset();
      return onAdded();
    },
  });

  const form$ = useFormErrors(TrackedQueryInputSchema, { kind, text });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (form$.check()) create.mutate();
  }

  return (
    <>
      <form onSubmit={submit} className="add-row" noValidate>
        <label>
          Type
          <select value={kind} onChange={(event) => setKind(event.target.value as QueryKind)}>
            {(Object.keys(QUERY_KIND_LABELS) as QueryKind[]).map((value) => (
              <option key={value} value={value}>
                {QUERY_KIND_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <div className="grow">
          <Field
            label={kind === "ai_prompt" ? "Prompt" : "Keyword"}
            required
            maxLength={300}
            value={text}
            error={form$.error("text")}
            placeholder={
              kind === "ai_prompt"
                ? "What would a customer ask? e.g. Who makes the best pizza in Raleigh?"
                : "pizza near me"
            }
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <button
          type="submit"
          className="outline fill-narrow"
          disabled={create.isPending || atLimit}
        >
          {kind === "ai_prompt" ? "Add prompt" : "Add keyword"}
        </button>
        {allowed !== undefined && (
          <span className="mono">
            {used} of {allowed} used{atLimit && ". Retire one to add another."}
          </span>
        )}
      </form>
      <ErrorNote error={create.error} />
    </>
  );
}

/** Recommendations the plan does not cover: bookkeeping, and assistants that never named it. */
function Recommendations({
  items,
  onChanged,
  readOnly,
}: {
  items: Detail["recommendations"];
  onChanged: () => unknown;
  /** True while the operator is reading a customer's account: the list is shown, not acted on. */
  readOnly: boolean;
}) {
  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "done" | "dismissed" }) =>
      api.setRecommendationStatus(id, status),
    onSuccess: onChanged,
  });

  return (
    <>
      <h3>Also worth doing</h3>
      <ul className="steps">
        {items.map((item) => (
          <li key={item.id} className="card also">
            <div>
              <h3>{item.title}</h3>
              <p>{item.detail}</p>
            </div>
            {!readOnly && (
              <div className="row-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ id: item.id, status: "done" })}
                >
                  Mark done
                </button>
                <button
                  type="button"
                  className="link"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ id: item.id, status: "dismissed" })}
                >
                  Dismiss
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <ErrorNote error={update.error} />
    </>
  );
}
