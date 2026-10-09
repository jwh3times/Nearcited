import {
  type AttentionItem,
  type AttentionKind,
  type OperatorOrganization,
  SURFACE_LABELS,
  type Surface,
} from "@nearcited/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { ErrorNote } from "../components/ErrorNote";
import { Labelled } from "../components/Labelled";
import { api } from "../lib/api";
import { formatDate, listOf } from "../lib/format";
import { readThroughBase } from "../lib/viewing";

/** What each kind of item is called, in the reader's words. */
const KIND_LABELS: Record<AttentionKind, string> = {
  organization_failing: "Scans keep failing",
  scan_failed: "Scan failed",
  scan_stuck: "Scan stuck",
  scan_missed: "Scan missed",
  site_unloaded: "Website not loaded",
  site_blocked: "Website shuts assistants out",
  audit_failed: "Audit failed",
  no_prompts: "Nothing to scan",
  at_limit: "Prompt limit reached",
};

const SCAN_WORDS = {
  succeeded: "Succeeded",
  failed: "Failed",
  queued: "Queued",
  running: "Running",
} as const;

/**
 * The operator's first screen: what is wrong now, how much is going on, and every organization.
 * Everything on it is read; nothing here changes a customer's account.
 */
export function Operator() {
  const overview = useQuery({
    queryKey: ["operator-overview"],
    queryFn: api.operatorOverview,
    // Things break while the page is open. A minute is often enough to notice.
    refetchInterval: 60_000,
  });

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <p className="small muted">Every organization, read-only</p>
          <h1>Operator</h1>
        </div>
      </div>

      {overview.isPending && <p className="status">Loading</p>}
      <ErrorNote error={overview.error} />

      {overview.data && (
        <>
          <section className="stack">
            <div className="section-head">
              <h2>Needs attention</h2>
              <span className="small">What is wrong now. An item leaves when it is fixed.</span>
            </div>
            {overview.data.attention.length === 0 ? (
              <p className="card notice">Nothing needs looking at.</p>
            ) : (
              <ul className="attention">
                {overview.data.attention.map((item, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the list is rebuilt whole each time
                  <Attention key={index} item={item} />
                ))}
              </ul>
            )}
          </section>

          <ul className="totals">
            <Total label="Organizations" value={overview.data.totals.organizations} />
            <Total label="Locations" value={overview.data.totals.locations} />
            <Total
              label="Scans, last 24 hours"
              value={overview.data.totals.scans_24h.total}
              failed={overview.data.totals.scans_24h.failed}
            />
            <Total
              label="Scans, last 7 days"
              value={overview.data.totals.scans_7d.total}
              failed={overview.data.totals.scans_7d.failed}
            />
          </ul>

          <section className="stack">
            <h2>Organizations</h2>
            <Organizations rows={overview.data.organizations} empty="No organizations yet." />
          </section>

          <section className="stack">
            <div className="section-head">
              <h2>Test organizations</h2>
              <span className="small">
                Made by test accounts. Their scans are generated, and they are never counted above.
              </span>
            </div>
            <Organizations rows={overview.data.test_organizations} empty="None." />
          </section>

          <section className="stack">
            <h2>This deployment</h2>
            <ul className="card facts deployment">
              <li className="fact-row">
                <span>Scans</span>
                <span>
                  {overview.data.deployment.sample_data
                    ? "Generated sample data, for everyone"
                    : "Live"}
                </span>
              </li>
              {Object.entries(overview.data.deployment.models).map(([surface, model]) => (
                <li key={surface} className="fact-row">
                  <span>{SURFACE_LABELS[surface as Surface] ?? surface} model</span>
                  <span className="mono">{model}</span>
                </li>
              ))}
              <li className="fact-row">
                <span>Deployed commit</span>
                <span className="mono">{overview.data.deployment.commit ?? "Not recorded"}</span>
              </li>
            </ul>
          </section>
        </>
      )}
    </main>
  );
}

function Attention({ item }: { item: AttentionItem }) {
  const account = item.organization_id ? readThroughBase(item.organization_id) : null;
  const to = account && item.location_id ? `${account}/locations/${item.location_id}` : account;
  const who = [item.organization_name, item.location_name].filter(Boolean).join(" · ");
  return (
    <li className="card attention-item">
      <span className="badge bad">{KIND_LABELS[item.kind]}</span>
      <div className="stack-tight">
        {to ? (
          <Link to={to} className="attention-who">
            {who}
          </Link>
        ) : (
          who && <span className="attention-who">{who}</span>
        )}
        <span className="small muted">{item.detail}</span>
      </div>
      <span className="mono muted">{item.at ? formatDate(item.at) : ""}</span>
    </li>
  );
}

function Total({ label, value, failed }: { label: string; value: number; failed?: number }) {
  return (
    <li className="card total">
      <span className="small muted">{label}</span>
      <span className="display">{value}</span>
      {failed !== undefined && (
        <span className={failed > 0 ? "small change down" : "small muted"}>
          {failed === 0 ? "None failed" : `${failed} failed`}
        </span>
      )}
    </li>
  );
}

function Organizations({ rows, empty }: { rows: OperatorOrganization[]; empty: string }) {
  if (rows.length === 0) return <p className="lede">{empty}</p>;
  const columns = "minmax(11rem,1.6fr) 6rem minmax(9rem,1fr) 5.5rem minmax(9rem,1.2fr)";
  return (
    <div className="gtable-scroll">
      <div className="gtable stacks" style={{ "--cols": columns, "--min": "46rem" } as never}>
        <div className="gtable-head">
          <span>Organization</span>
          <span>Locations</span>
          <span>Last scan</span>
          <span>Failed, 7 days</span>
          <span>Scanned</span>
        </div>
        {rows.map((row) => (
          <Link key={row.id} to={readThroughBase(row.id)} className="gtable-row">
            <span className="stack-tight">
              <span className="loc-name ellipsis">{row.name}</span>
              <span className="small muted">
                {row.is_yours ? "Yours · " : ""}
                since {formatDate(row.created_at)}
              </span>
            </span>
            <Labelled label="Locations">
              <span className="mono">
                {row.locations} of {row.max_locations}
              </span>
            </Labelled>
            <Labelled label="Last scan">
              {row.last_scan ? (
                <span className="stack-tight">
                  <span className={row.last_scan.status === "failed" ? "change down" : undefined}>
                    {SCAN_WORDS[row.last_scan.status]}
                  </span>
                  <span className="small muted">{formatDate(row.last_scan.at)}</span>
                </span>
              ) : (
                <span className="muted">Never</span>
              )}
            </Labelled>
            <Labelled label="Failed, 7 days">
              <span className={row.failed_7d > 0 ? "mono change down" : "mono muted"}>
                {row.failed_7d}
              </span>
            </Labelled>
            <Labelled label="Scanned" wide>
              <span className="small">
                {row.scan_every_days === 1 ? "Daily" : `Every ${row.scan_every_days} days`}
                {" on "}
                {row.surfaces
                  ? listOf(row.surfaces.map((surface) => SURFACE_LABELS[surface]))
                  : "everything set up"}
              </span>
            </Labelled>
          </Link>
        ))}
      </div>
    </div>
  );
}
