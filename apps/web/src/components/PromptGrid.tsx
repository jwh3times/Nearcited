import {
  type QueryKind,
  type ScanResult,
  type ScanWindow,
  SURFACE_LABELS,
  type Surface,
  type TrackedQuery,
} from "@nearcited/shared";
import { buildMatrix, type MatrixCell, ordinal } from "../lib/matrix";
import { RateCell } from "./RateCell";

const GROUP_HEADINGS: Record<QueryKind, string> = {
  ai_prompt: "Asked of assistants",
  search_keyword: "Searched on Google",
};

interface Props {
  queries: TrackedQuery[];
  results: ScanResult[];
  window: ScanWindow;
  /** The surfaces a scan checks right now. */
  surfaces: readonly Surface[];
  onRetire: (queryId: string) => void;
}

/** One group per query kind: queries down the side, surfaces across the top. */
export function PromptGrid({ queries, results, window, surfaces, onRetire }: Props) {
  return (
    <div className="card pcard">
      <div className="pgrid">
        {buildMatrix(queries, results, window, surfaces).map((group) => {
          const columns = `minmax(220px,1fr) ${
            group.surfaces.length > 0
              ? group.surfaces.map(() => "minmax(150px,190px)").join(" ")
              : "380px"
          } 64px`;
          return (
            <div key={group.kind} style={{ "--cols": columns } as never}>
              <div className="pgrid-head">
                <span>{GROUP_HEADINGS[group.kind]}</span>
                {group.surfaces.map((surface) => (
                  <span key={surface}>{SURFACE_LABELS[surface]}</span>
                ))}
                {group.surfaces.length === 0 && <span />}
                <span />
              </div>
              {group.rows.map((row) => (
                <div key={row.query.id} className="pgrid-row">
                  <span>“{row.query.text}”</span>
                  {row.cells.map((cell) => (
                    <Cell key={cell.surface} cell={cell} />
                  ))}
                  {row.cells.length === 0 && (
                    <span className="small muted">
                      {group.kind === "ai_prompt"
                        ? "No assistant is set up to check this"
                        : "Google results aren't checked yet"}
                    </span>
                  )}
                  <button
                    type="button"
                    className="link"
                    aria-label={`Retire "${row.query.text}"`}
                    onClick={() => onRetire(row.query.id)}
                  >
                    Retire
                  </button>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One answer is a sample, so a cell leads with how often the business was named over the recent
 * scans and puts the latest answer beside it. Everything is said in words and figures, so the
 * shade is never the only signal.
 */
function Cell({ cell }: { cell: MatrixCell }) {
  const { result, rate } = cell;
  if (!result) return <span className="small muted">Not checked</span>;

  const checks = rate?.checks ?? 1;
  const mentions = rate?.mentions ?? (result.mentioned ? 1 : 0);
  const latest = !result.mentioned
    ? "Not named latest"
    : result.position === null
      ? "Named"
      : `Latest ${ordinal(result.position)}`;

  return (
    <span className="acell">
      {mentions > 0 ? (
        <span className="top">
          <RateCell rate={mentions / checks} chip>{`${mentions} of ${checks}`}</RateCell>
          {latest}
        </span>
      ) : (
        <span className="none">
          <span className="ring" aria-hidden="true" />0 of {checks}
        </span>
      )}
      {rate && rate.history.length > 1 && <History checks={rate.history} />}
    </span>
  );
}

/** How this prompt has moved on this surface: one dot per recent scan, oldest on the left. */
function History({ checks }: { checks: boolean[] }) {
  const words = checks.map((named) => (named ? "named" : "not named")).join(", ");
  return (
    <span className="history" role="img" aria-label={`Oldest to latest: ${words}`}>
      {checks.map((named, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: dots are positional and never reorder
        <span key={index} className={named ? "history-hit" : "history-miss"} />
      ))}
    </span>
  );
}
