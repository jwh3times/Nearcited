import {
  type QueryKind,
  type ScanResult,
  type ScanWindow,
  SURFACE_LABELS,
  type TrackedQuery,
} from "@nearcited/shared";
import { buildMatrix, type MatrixCell, ordinal } from "../lib/matrix";

const GROUP_HEADINGS: Record<QueryKind, string> = {
  ai_prompt: "Asked of assistants",
  search_keyword: "Searched on Google",
};

interface Props {
  queries: TrackedQuery[];
  results: ScanResult[];
  window: ScanWindow;
  onRemove: (queryId: string) => void;
}

/** One table per query kind: queries down the side, surfaces across the top. */
export function VisibilityMatrix({ queries, results, window, onRemove }: Props) {
  return (
    <>
      {buildMatrix(queries, results, window).map((group) => (
        <div key={group.kind} className="matrix-scroll">
          <table className="matrix">
            <caption>{GROUP_HEADINGS[group.kind]}</caption>
            <thead>
              <tr>
                <th scope="col">{group.kind === "ai_prompt" ? "Prompt" : "Keyword"}</th>
                {group.surfaces.map((surface) => (
                  <th key={surface} scope="col" className="matrix-surface">
                    {SURFACE_LABELS[surface]}
                  </th>
                ))}
                <td />
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => (
                <tr key={row.query.id}>
                  <th scope="row">{row.query.text}</th>
                  {row.cells.map((cell) => (
                    <td key={cell.surface} className="matrix-cell">
                      <Cell cell={cell} />
                    </td>
                  ))}
                  <td className="matrix-remove">
                    <button
                      type="button"
                      className="link"
                      aria-label={`Remove "${row.query.text}"`}
                      onClick={() => onRemove(row.query.id)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}

/**
 * One answer is a sample, so once a cell has more than one check it leads with how often the
 * business was named and puts the latest answer underneath. Named cells carry the highlighter
 * mark and everything is said in words, so colour is never the only signal.
 */
function Cell({ cell }: { cell: MatrixCell }) {
  const { result, rate } = cell;
  if (!result) return <span className="unchecked">Not checked</span>;

  const latest = !result.mentioned
    ? "not named"
    : result.position === null
      ? "named"
      : ordinal(result.position);

  if (rate && rate.checks > 1) {
    return (
      <span className="rate">
        {rate.mentions > 0 ? (
          <span className="named">
            {rate.mentions} of {rate.checks}
          </span>
        ) : (
          <span className="absent">
            <span className="absent-ring" aria-hidden="true" />0 of {rate.checks}
          </span>
        )}
        <span className="rate-latest">Latest: {latest}</span>
      </span>
    );
  }

  if (!result.mentioned) {
    return (
      <span className="absent">
        <span className="absent-ring" aria-hidden="true" />
        Not named
      </span>
    );
  }
  return (
    <span className="named">{result.position === null ? "Named" : ordinal(result.position)}</span>
  );
}
