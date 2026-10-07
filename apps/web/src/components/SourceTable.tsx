import type { SourceSummary } from "@nearcited/shared";

interface SourceTableProps {
  sources: SourceSummary[];
  /** How many answers the counts are out of. */
  answers: number;
}

/**
 * The sites the answers were built from. The links are the pages the assistants cited, which the
 * providers' terms require to be shown wherever their answers are used.
 */
export function SourceTable({ sources, answers }: SourceTableProps) {
  return (
    <div className="matrix-scroll">
      <table className="matrix source-table">
        <thead>
          <tr>
            <th scope="col">Site</th>
            <th scope="col">Cited in</th>
            <th scope="col">Named you</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <tr key={source.host}>
              <th scope="row">
                {source.urls[0] ? (
                  <a href={source.urls[0]} target="_blank" rel="noopener noreferrer nofollow">
                    {source.host}
                  </a>
                ) : (
                  source.host
                )}
                {source.own && <span className="muted"> · your site</span>}
              </th>
              <td>
                {source.answers} of {answers} answers
              </td>
              <td>
                {source.named > 0 ? (
                  <span className="named">
                    In {source.named} of {source.answers}
                  </span>
                ) : (
                  <span className="absent">
                    <span className="absent-ring" aria-hidden="true" />
                    In none of {source.answers}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
