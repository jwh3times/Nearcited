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
import { ErrorNote } from "../components/ErrorNote";
import { ScoreTrend } from "../components/ScoreTrend";
import { VisibilityMatrix } from "../components/VisibilityMatrix";
import { api } from "../lib/api";
import { formatDate, sourceLabel } from "../lib/format";
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
  } = detail.data;
  const active = queries.filter((query) => query.is_active);
  const retired = queries.filter((query) => !query.is_active);
  const results = scan?.status === "succeeded" ? scan.results : [];
  const competitors = tallyCompetitors(results);
  const excerpts = results.filter((result) => result.answer_excerpt);
  const open = recommendations.filter((recommendation) => recommendation.status === "open");
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
        <AddQuery locationId={location.id} onAdded={refresh} />
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
                  {markName(result.answer_excerpt ?? "", location.name).map((part, index) =>
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

      {open.length > 0 && (
        <section className="section">
          <h2>Next steps</h2>
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

function AddQuery({ locationId, onAdded }: { locationId: string; onAdded: () => unknown }) {
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
        <button type="submit" className="secondary" disabled={create.isPending}>
          {kind === "ai_prompt" ? "Add prompt" : "Add keyword"}
        </button>
      </form>
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

/**
 * The pages an answer cited. Providers' terms require these to be shown, visible and clickable,
 * wherever the answer is, so do not drop this list when changing how excerpts are displayed.
 */
function Sources({ urls }: { urls: string[] }) {
  const links = urls.flatMap((url) => {
    const label = sourceLabel(url);
    return label ? [{ url, label }] : [];
  });
  if (links.length === 0) return null;
  return (
    <p className="sources">
      Sources:{" "}
      {links.map((link, index) => (
        <span key={link.url}>
          {index > 0 && ", "}
          <a href={link.url} target="_blank" rel="noopener noreferrer nofollow">
            {link.label}
          </a>
        </span>
      ))}
    </p>
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
