import { formatDate } from "../lib/format";
import { type Rate, scoreChange, signed } from "../lib/summary";
import { plotTrend, type TrendPoint } from "../lib/trend";

const WIDTH = 320;
const HEIGHT = 96;
const TICKS = [0, 50, 100];

const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

interface ScoreCardProps {
  /** The score after each scan, oldest first. Not empty. */
  trend: TrendPoint[];
  /** How often the business was named across the answers the score is counted over. */
  named: Rate;
}

/**
 * The visibility score and how it has moved. Each point is the score over the window of scans
 * that scan closed, so the line is already a rolling figure, on a fixed 0 to 100 axis.
 */
export function ScoreCard({ trend, named }: ScoreCardProps) {
  const latest = trend[trend.length - 1];
  const first = trend[0];
  if (!latest || !first) return null;

  const change = scoreChange(trend);
  const points = plotTrend(trend, WIDTH, HEIGHT);
  const last = points[points.length - 1];
  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
    .join(" ");

  return (
    <div className="card score-card">
      <div className="top">
        <span>Visibility</span>
        {change && (
          <span className={`change${change.by > 0 ? " up" : ""}${change.by < 0 ? " down" : ""}`}>
            {signed(change.by)} in {change.scans} {change.scans === 1 ? "scan" : "scans"}
          </span>
        )}
      </div>
      <p className="score-big">
        {latest.score}
        <span>/ 100</span>
      </p>

      {points.length > 1 && last ? (
        <>
          <svg
            className="chart"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="img"
            aria-label={`Visibility score over ${trend.length} scans, from ${first.score} to ${latest.score} of 100.`}
          >
            {TICKS.map((tick) => {
              const y = HEIGHT - (tick / 100) * HEIGHT;
              return <line key={tick} className="chart-grid" x1={0} x2={WIDTH} y1={y} y2={y} />;
            })}
            <path className="chart-area" d={`${line} L${last.x},${HEIGHT} L0,${HEIGHT} Z`} />
            <path className="chart-line" d={line} />
            <circle className="chart-dot" cx={last.x} cy={last.y} r={4} />
          </svg>
          <div className="chart-dates">
            <span>{day.format(new Date(first.at))}</span>
            <span>{day.format(new Date(latest.at))}</span>
          </div>
          <details className="as-table">
            <summary>Show as a table</summary>
            <table>
              <thead>
                <tr>
                  <th scope="col">Scan finished</th>
                  <th scope="col">Visibility, of 100</th>
                </tr>
              </thead>
              <tbody>
                {[...trend].reverse().map((point) => (
                  <tr key={point.at}>
                    <td>{formatDate(point.at)}</td>
                    <td>{point.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      ) : (
        <p className="small muted">
          The chart of visibility over time starts with the second scan.
        </p>
      )}

      {named.rate !== null && (
        <>
          <hr className="divider" />
          <div className="split">
            <span>
              Named in{" "}
              <span className="soft-ok">
                {named.mentions} of {named.checks}
              </span>{" "}
              answers
            </span>
            <span className="mono muted">{Math.round(named.rate * 100)}%</span>
          </div>
        </>
      )}
    </div>
  );
}
