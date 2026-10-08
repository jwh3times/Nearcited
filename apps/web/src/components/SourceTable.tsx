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
  const columns = "minmax(160px,1fr) minmax(200px,1.4fr) 150px";
  return (
    <div className="gtable-scroll">
      <div className="gtable" style={{ "--cols": columns, "--min": "560px" } as never}>
        <div className="gtable-head">
          <span>Site</span>
          <span>Cited in</span>
          <span>Named you</span>
        </div>
        {sources.map((source) => (
          <div key={source.host} className="gtable-row">
            <span className="stack-tight">
              {source.urls[0] ? (
                <a
                  className="ellipsis"
                  href={source.urls[0]}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  {source.host}
                </a>
              ) : (
                <span className="ellipsis">{source.host}</span>
              )}
              {source.own && <span className="mono muted">your site</span>}
            </span>
            <span className="cited">
              <span className="bar ink">
                <i style={{ width: `${answers === 0 ? 0 : (source.answers / answers) * 100}%` }} />
              </span>
              <span className="mono">
                {source.answers} of {answers}
              </span>
            </span>
            <span>
              {source.named > 0 ? (
                <span className="soft-ok">
                  In {source.named} of {source.answers}
                </span>
              ) : (
                <span className="none bad">
                  <span className="ring" aria-hidden="true" />
                  In none of {source.answers}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
