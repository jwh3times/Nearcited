import type { NamedInsteadCard } from "../lib/summary";

/** Who the window's checks named, beside how often they named the business itself. */
export function NamedInstead({ card }: { card: NamedInsteadCard }) {
  const { mentions, checks, competitors } = card;
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
      <p className="small muted">{card.note}</p>
    </div>
  );
}
