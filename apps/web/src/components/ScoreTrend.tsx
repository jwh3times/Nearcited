import type { Scan } from "@nearcited/shared";
import { type PointerEvent, useState } from "react";
import { formatDate } from "../lib/format";
import { buildTrend, nearestPoint, plotTrend } from "../lib/trend";

const WIDTH = 640;
const HEIGHT = 150;
/** Room for the axis labels on the left, the end label on the right, and the dates below. */
const PAD = { top: 12, right: 44, bottom: 22, left: 30 };
const TICKS = [0, 50, 100];

const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/**
 * The visibility score over time: one line, on a fixed 0 to 100 axis.
 *
 * Each point is the score over the window of scans that scan closed, so the line is already a
 * rolling figure. The line is ink: yellow is kept for "the business was named".
 */
export function ScoreTrend({ scans }: { scans: Scan[] }) {
  const trend = buildTrend(scans);
  const [active, setActive] = useState<number | null>(null);

  if (trend.length === 0) return null;
  if (trend.length === 1) {
    return (
      <p className="window-note">
        The chart of visibility over time starts with the second scan. So far: {trend[0]?.score} of
        100.
      </p>
    );
  }

  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const points = plotTrend(trend, plotWidth, plotHeight);
  const first = points[0];
  const last = points[points.length - 1];
  const shown = active === null ? null : (points[active] ?? null);
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
    .join(" ");

  const track = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * WIDTH - PAD.left;
    setActive(nearestPoint(points, x));
  };
  return (
    <figure className="trend">
      <figcaption>
        Visibility over time
        <span className="muted">
          {shown
            ? `${formatDate(shown.at)}: ${shown.score} of 100`
            : `${trend.length} scans, latest ${last?.score} of 100`}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Visibility score over ${trend.length} scans, from ${first?.score} to ${last?.score} of 100.`}
        onPointerMove={track}
        onPointerLeave={() => setActive(null)}
      >
        <g transform={`translate(${PAD.left},${PAD.top})`}>
          {TICKS.map((tick) => {
            const y = plotHeight - (tick / 100) * plotHeight;
            return (
              <g key={tick}>
                <line className="trend-grid" x1={0} x2={plotWidth} y1={y} y2={y} />
                <text
                  className="trend-axis"
                  x={-8}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="middle"
                >
                  {tick}
                </text>
              </g>
            );
          })}

          {shown && (
            <line className="trend-crosshair" x1={shown.x} x2={shown.x} y1={0} y2={plotHeight} />
          )}
          <path className="trend-line" d={path} />
          {shown && <circle className="trend-dot" cx={shown.x} cy={shown.y} r={5} />}
          {last && <circle className="trend-dot" cx={last.x} cy={last.y} r={4} />}
          {last && (
            <text className="trend-end" x={last.x + 10} y={last.y} dominantBaseline="middle">
              {last.score}
            </text>
          )}

          {first && (
            <text className="trend-axis" x={0} y={plotHeight + 16}>
              {day.format(new Date(first.at))}
            </text>
          )}
          {last && (
            <text className="trend-axis" x={plotWidth} y={plotHeight + 16} textAnchor="end">
              {day.format(new Date(last.at))}
            </text>
          )}
        </g>
      </svg>
      {/* The keyboard's way in: a slider over the scans, which moves the same crosshair. */}
      <input
        className="trend-scrub"
        type="range"
        min={0}
        max={points.length - 1}
        step={1}
        value={active ?? points.length - 1}
        aria-label="Step through the scans"
        aria-valuetext={
          shown
            ? `${formatDate(shown.at)}: ${shown.score} of 100`
            : `${last ? formatDate(last.at) : ""}: ${last?.score} of 100`
        }
        onChange={(event) => setActive(Number(event.target.value))}
        onBlur={() => setActive(null)}
      />
      <details className="trend-table">
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
    </figure>
  );
}
