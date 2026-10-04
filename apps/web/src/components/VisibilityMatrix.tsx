import {
  type QueryKind,
  type ScanResult,
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
  onRemove: (queryId: string) => void;
}

/** One table per query kind: queries down the side, surfaces across the top. */
export function VisibilityMatrix({ queries, results, onRemove }: Props) {
  return (
    <>
      {buildMatrix(queries, results).map((group) => (
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

/** Named cells carry the highlighter mark and say the rank in words, so colour is never the only signal. */
function Cell({ cell }: { cell: MatrixCell }) {
  const { result } = cell;
  if (!result) return <span className="unchecked">Not checked</span>;
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
