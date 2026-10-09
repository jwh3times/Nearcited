import type { OperatorSpendMonth } from "@nearcited/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../lib/api";
import { formatDollars, formatMonth } from "../lib/format";
import { readThroughBase } from "../lib/viewing";
import { ErrorNote } from "./ErrorNote";
import { Labelled } from "./Labelled";

interface Line {
  key: string;
  name: string;
  /** Where the line leads: an organization's account. Audits and deleted ones lead nowhere. */
  to?: string;
  note?: string;
  costs: number[];
}

/** One line per organization that spent anything in the months shown, then audits and the rest. */
function lines(months: OperatorSpendMonth[]): Line[] {
  const organizations = new Map<string, Line>();
  months.forEach((month, at) => {
    for (const row of month.organizations) {
      const line = organizations.get(row.organization_id) ?? {
        key: row.organization_id,
        name: row.name,
        to: readThroughBase(row.organization_id),
        note: row.is_yours ? "Yours" : undefined,
        costs: months.map(() => 0),
      };
      line.costs[at] = row.cost;
      organizations.set(row.organization_id, line);
    }
  });
  const extra = (key: "audits" | "deleted", name: string, note: string): Line[] =>
    months.some((month) => month[key] > 0)
      ? [{ key, name, note, costs: months.map((month) => month[key]) }]
      : [];
  return [
    // Most spent this month first.
    ...[...organizations.values()].sort(
      (a, b) => (b.costs[0] ?? 0) - (a.costs[0] ?? 0) || a.name.localeCompare(b.name),
    ),
    ...extra("audits", "Audits", "Reports for businesses that have not signed up"),
    ...extra("deleted", "Deleted organizations", "Spent before they were deleted"),
  ];
}

/**
 * What the assistants' vendors were paid, by calendar month in UTC: the whole product, then each
 * organization. Worked out on the server from what each scan used and what each model costs.
 */
export function Spend() {
  const spend = useQuery({ queryKey: ["operator-spend"], queryFn: api.operatorSpend });
  const months = spend.data?.months ?? [];
  const rows = lines(months);
  const unpriced = months.flatMap((month) =>
    month.unpriced.map((model) => ({ ...model, month: month.month })),
  );
  const columns = `minmax(11rem,1.6fr) repeat(${months.length}, minmax(7rem,1fr))`;

  return (
    <section className="stack">
      <div className="section-head">
        <h2>Spend</h2>
        <span className="small">
          What the assistants cost to ask, by calendar month in UTC. Test organizations use nothing.
        </span>
      </div>
      {spend.isPending && <p className="status">Loading</p>}
      <ErrorNote error={spend.error} />
      {spend.data && (
        <>
          <ul className="totals">
            {months.map((month, at) => (
              <li key={month.month} className="card total">
                <span className="small muted">
                  {formatMonth(month.month)}
                  {at === 0 ? ", so far" : ""}
                </span>
                <span className="display">{formatDollars(month.total)}</span>
              </li>
            ))}
          </ul>
          {unpriced.length > 0 && (
            <p className="card notice" role="status">
              Not counted, because the model has no rate yet:{" "}
              {unpriced
                .map(
                  ({ model, calls, month }) =>
                    `${calls} ${calls === 1 ? "call" : "calls"} to ${model} in ${formatMonth(month)}`,
                )
                .join("; ")}
              .
            </p>
          )}
          {rows.length === 0 ? (
            <p className="lede">Nothing has been spent in these months.</p>
          ) : (
            <div className="gtable-scroll">
              <div
                className="gtable stacks"
                style={{ "--cols": columns, "--min": "38rem" } as never}
              >
                <div className="gtable-head">
                  <span>Spent by</span>
                  {months.map((month) => (
                    <span key={month.month}>{formatMonth(month.month)}</span>
                  ))}
                </div>
                {rows.map((row) => {
                  const cells = (
                    <>
                      <span className="stack-tight">
                        <span className="ellipsis">{row.name}</span>
                        {row.note && <span className="small muted">{row.note}</span>}
                      </span>
                      {months.map((month, at) => (
                        <Labelled key={month.month} label={formatMonth(month.month)}>
                          <span className="mono">{formatDollars(row.costs[at] ?? 0)}</span>
                        </Labelled>
                      ))}
                    </>
                  );
                  return row.to ? (
                    <Link key={row.key} to={row.to} className="gtable-row">
                      {cells}
                    </Link>
                  ) : (
                    <div key={row.key} className="gtable-row">
                      {cells}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
