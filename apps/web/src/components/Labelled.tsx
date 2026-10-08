import type { ReactNode } from "react";

interface LabelledProps {
  /** The column this figure sits under on a wide screen. */
  label: string;
  /** Takes a row to itself when the table is stacked. */
  wide?: boolean;
  children: ReactNode;
}

/**
 * One cell of a table that becomes a card per row on a phone. The label is the column heading,
 * which only shows once the headings themselves are gone.
 */
export function Labelled({ label, wide = false, children }: LabelledProps) {
  return (
    <span className={wide ? "cell wide" : "cell"}>
      <span className="cell-label">{label}</span>
      {children}
    </span>
  );
}
