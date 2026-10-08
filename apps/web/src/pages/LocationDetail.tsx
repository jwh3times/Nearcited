import {
  type LocationDetail as Detail,
  hostOf,
  QUERY_KIND_LABELS,
  type QueryKind,
  type ScanWithResults,
  SURFACE_LABELS,
} from "@nearcited/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ActionPlan } from "../components/ActionPlan";
import { ErrorNote } from "../components/ErrorNote";
import { ScoreTrend } from "../components/ScoreTrend";
import { SiteChecklist } from "../components/SiteChecklist";
import { Sources } from "../components/Sources";
import { SourceTable } from "../components/SourceTable";
import { VisibilityMatrix } from "../components/VisibilityMatrix";
import { api } from "../lib/api";
import { cadence, formatDate, listOf, plainText } from "../lib/format";
import { markName, tallyCompetitors } from "../lib/matrix";

const inFlight = (scan: ScanWithResults | null) =>
  scan?.status === "queued" || scan?.status === "running";

export function LocationDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queryKey = ["location", id];
  const historyKey = ["location-scans", id];
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
  // Already loaded by the page shell, so this reads the cache.
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });

  const startScan = useMutation({ mutationFn: () => api.startScan(id), onSuccess: refresh });
  const setQueryActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.setQueryActive(id, active),
    onSuccess: refresh,
  });
  const removeLocation = useMutation({
    mutationFn: () => api.deleteLocation(id),
    onSuccess: () => navigate("/"),
  });

  if (detail.isPending) return <p className="status">Loading location</p>;
  if (detail.isError) {
    return (
      <>
        <ErrorNote error={detail.error} />
        <Link to="/">Back to locations</Link>
      </>
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
  const organization = me.data?.organizations.find(
    (candidate) => candidate.id === location.organization_id,
  );
  const active = queries.filter((query) => query.is_active);
  const retired = queries.filter((query) => !query.is_active);
  const results = scan?.status === "succeeded" ? scan.results : [];
  const competitors = tallyCompetitors(results);
  const excerpts = results.filter((result) => result.answer_excerpt);
  // The action plan covers what the sources and the website check found, with the evidence
  // attached, so those recommendations are not listed a second time below it.
  const inPlan = (rule: string) =>
    rule.startsWith("source:") || rule.startsWith("site:") || rule === "own_site_uncited";
  const open = recommendations.filter(
    (recommendation) => recommendation.status === "open" && !inPlan(recommendation.rule),
  );
  const scanning = inFlight(scan) || startScan.isPending;

  return (
    <>
      <p className="breadcrumb">
        <Link to="/">Locations</Link>
      </p>
      <div className="title-row">
        <div>
          <h1>{location.name}</h1>
          <p className="muted">
            {[location.city, location.region].filter(Boolean).join(", ")}
            {location.website && (
              <>
                {", "}
                <a href={location.website} rel="noreferrer">
                  {hostOf(location.website) ?? location.website}
                </a>
              </>
            )}
          </p>
        </div>
        <div className="title-actions">
          <button
            type="button"
            onClick={() => startScan.mutate()}
            disabled={scanning || active.length === 0}
          >
            {scanning ? "Scan under way" : "Run scan"}
          </button>
        </div>
      </div>

      <ScanStatus detail={detail.data} />
      {organization && location.scan_frequency !== "off" && surfaces.length > 0 && (
        <p className="window-note">
          Scanned {cadence(organization.scan_every_days, location.scan_frequency)} on{" "}
          {listOf(surfaces.map((surface) => SURFACE_LABELS[surface]))}.
        </p>
      )}
      <ErrorNote error={startScan.error} />
      {history.data && <ScoreTrend scans={history.data} />}

      <section className="section">
        <h2>Where {location.name} is named</h2>
        {active.length === 0 ? (
          <p className="lede">
            Nothing to check yet. Add a prompt someone would ask an assistant, or a keyword they
            would search on Google, then run a scan.
          </p>
        ) : (
          <VisibilityMatrix
            queries={active}
            results={results}
            window={scanWindow}
            surfaces={surfaces}
            onRetire={(id) => setQueryActive.mutate({ id, active: false })}
          />
        )}
        {results.length > 0 && <WindowNote scans={scanWindow.scans} size={scanWindow.size} />}
        <ErrorNote error={setQueryActive.error} />
        <AddQuery
          locationId={location.id}
          onAdded={refresh}
          used={active.length}
          allowed={organization?.max_queries_per_location}
        />
        {retired.length > 0 && (
          <div className="retired">
            <h3>Retired</h3>
            <p className="window-note">
              No longer scanned and not counted in the score. Their results are kept, and count
              again if you restore them.
            </p>
            <ul>
              {retired.map((query) => (
                <li key={query.id}>
                  <span>{query.text}</span>
                  <button
                    type="button"
                    className="link"
                    aria-label={`Restore "${query.text}"`}
                    onClick={() => setQueryActive.mutate({ id: query.id, active: true })}
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {competitors.length > 0 && (
        <section className="section">
          <h2>Named instead</h2>
          <ol className="tally">
            {competitors.map(({ name, count }) => (
              <li key={name}>
                <span>{name}</span>
                <span className="muted">
                  {count} of {results.length} checks
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {scanWindow.sources.length > 0 && (
        <section className="section">
          <h2>Where the answers come from</h2>
          <p className="window-note">
            The sites the assistants read before answering, over the last {scanWindow.scans}{" "}
            {scanWindow.scans === 1 ? "scan" : "scans"}. A site that is read often, in answers that
            never name {location.name}, is the first place to check your listing.
          </p>
          <SourceTable sources={scanWindow.sources} answers={scanWindow.answers} />
        </section>
      )}

      {excerpts.length > 0 && (
        <section className="section">
          <h2>What the answers said</h2>
          <ul className="excerpts">
            {excerpts.map((result) => (
              <li key={result.id}>
                <h3>
                  {SURFACE_LABELS[result.surface]}
                  <span className="muted">
                    {queries.find((query) => query.id === result.tracked_query_id)?.text}
                  </span>
                </h3>
                <p>
                  {markName(plainText(result.answer_excerpt ?? ""), location.name).map(
                    (part, index) =>
                      part.marked ? (
                        // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
                        <mark key={index}>{part.text}</mark>
                      ) : (
                        part.text
                      ),
                  )}
                </p>
                <Sources urls={result.cited_urls} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {actions.length > 0 && (
        <section className="section">
          <h2>What to do next</h2>
          <p className="window-note">
            Worked out from the answers of the last {scanWindow.scans}{" "}
            {scanWindow.scans === 1 ? "scan" : "scans"} and the latest check of your website. Each
            step says what was seen, so later scans show whether it moved.
          </p>
          <ActionPlan actions={actions} />
        </section>
      )}

      {site && (
        <section className="section">
          <h2>Your website</h2>
          <SiteChecklist site={site} />
        </section>
      )}

      {open.length > 0 && (
        <section className="section">
          <h2>Also worth doing</h2>
          <Recommendations items={open} onChanged={refresh} />
        </section>
      )}

      <section className="section">
        <h2>Delete this location</h2>
        <p className="muted">Removes the location, its prompts and keywords, and every scan.</p>
        <button
          type="button"
          className="secondary danger"
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
      </section>
    </>
  );
}

function ScanStatus({ detail }: { detail: Detail }) {
  const scan = detail.latest_scan;
  if (!scan) return <p className="scan-status">No scans yet.</p>;
  if (scan.status === "queued" || scan.status === "running") {
    return (
      <p className="scan-status" role="status">
        Scan under way. This page updates when it finishes.
      </p>
    );
  }
  if (scan.status === "failed") {
    return (
      <p className="scan-status error" role="alert">
        The last scan failed: {scan.error ?? "no reason was recorded."}
      </p>
    );
  }
  const named = scan.results.filter((result) => result.mentioned).length;
  return (
    <p className="scan-status">
      Scanned {formatDate(scan.finished_at ?? scan.created_at)}. Named in {named} of{" "}
      {scan.results.length} checks
      {scan.visibility_score !== null && `, visibility ${scan.visibility_score} of 100`}.
    </p>
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
      return onAdded();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <>
      <form onSubmit={submit} className="inline-form">
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
        <label className="grow">
          {kind === "ai_prompt" ? "Prompt" : "Keyword"}
          <input
            required
            maxLength={300}
            value={text}
            placeholder={
              kind === "ai_prompt" ? "Who makes the best pizza in Raleigh?" : "pizza near me"
            }
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button type="submit" className="secondary" disabled={create.isPending || atLimit}>
          {kind === "ai_prompt" ? "Add prompt" : "Add keyword"}
        </button>
      </form>
      {allowed !== undefined && (
        <p className="window-note">
          {used} of {allowed} active prompts used.
          {atLimit && " Retire one to add another."}
        </p>
      )}
      <ErrorNote error={create.error} />
    </>
  );
}

function Recommendations({
  items,
  onChanged,
}: {
  items: Detail["recommendations"];
  onChanged: () => unknown;
}) {
  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "done" | "dismissed" }) =>
      api.setRecommendationStatus(id, status),
    onSuccess: onChanged,
  });

  return (
    <>
      <ul className="rows recommendations">
        {items.map((item) => (
          <li key={item.id}>
            <div>
              <h3>{item.title}</h3>
              <p>{item.detail}</p>
            </div>
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
          </li>
        ))}
      </ul>
      <ErrorNote error={update.error} />
    </>
  );
}

/** Says what the counts in the grid are counted over, and why a new location has so few. */
function WindowNote({ scans, size }: { scans: number; size: number }) {
  if (scans <= 1) {
    return (
      <p className="window-note">
        One scan so far. An assistant can answer the same prompt differently each time, so these
        become "named in x of y" as more scans come in, up to the last {size}.
      </p>
    );
  }
  return (
    <p className="window-note">
      Counted over the last {scans} scans{scans < size ? `, building up to ${size}` : ""}. The score
      is counted the same way.
    </p>
  );
}
