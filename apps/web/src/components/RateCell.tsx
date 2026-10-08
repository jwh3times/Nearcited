import { rateTone } from "../lib/summary";

interface RateCellProps {
  /** Mentions over checks, 0 to 1. Null when nothing was asked. */
  rate: number | null;
  /** What to print in the cell. Defaults to the rounded percentage. */
  children?: string;
  chip?: boolean;
  title?: string;
}

/**
 * How often an assistant named the business, shaded darker as it rises. The figure is always
 * printed, so the shade is never the only signal.
 */
export function RateCell({ rate, children, chip = false, title }: RateCellProps) {
  if (rate === null) {
    return (
      <span className="rate-none" title={title}>
        —
      </span>
    );
  }
  const { mix, strong } = rateTone(rate);
  return (
    <span
      className={`rate-cell${chip ? " chip" : ""}${strong ? " strong" : ""}`}
      style={{ background: `color-mix(in oklch, var(--ok) ${mix}%, transparent)` }}
      title={title}
    >
      {children ?? `${Math.round(rate * 100)}%`}
    </span>
  );
}
