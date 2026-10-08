import type { CompetitorTally } from "../lib/matrix";

interface NamedInsteadProps {
  /** How many of the latest scan's checks named the business. */
  mentions: number;
  checks: number;
  competitors: CompetitorTally[];
}

/** Who the latest scan's answers named, beside how often they named the business itself. */
export function NamedInstead({ mentions, checks, competitors }: NamedInsteadProps) {
  const width = (count: number) => ({ width: `${checks === 0 ? 0 : (count / checks) * 100}%` });
  return (
    <div className="card bars-card">
      <h3 className="card-title">Named instead</h3>
      <ul className="bars">
        <li className="you">
          <span>You</span>
          <span className="bar ok">
            <i style={width(mentions)} />
          </span>
          <span className="mono">{mentions}</span>
        </li>
        {competitors.map(({ name, count }) => (
          <li key={name}>
            <span className="ellipsis">{name}</span>
            <span className="bar">
              <i style={width(count)} />
            </span>
            <span className="mono">{count}</span>
          </li>
        ))}
      </ul>
      <p className="small muted">
        Out of {checks} {checks === 1 ? "check" : "checks"} in the latest scan.
      </p>
    </div>
  );
}
