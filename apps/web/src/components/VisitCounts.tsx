import { PAGES_SHOWN } from "@nearcited/shared";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { COUNT_WORDS, formatDay, visitsKey, visitsShown } from "../lib/visits";
import { ErrorNote } from "./ErrorNote";

const number = (count: number) => count.toLocaleString("en-US");

interface VisitCountsProps {
  locationId: string;
  /**
   * True where the plan no longer counts visits. What was counted while one did is still shown,
   * and where there is none nothing is said: nobody is told that a site reported no visits when
   * nothing was listening.
   */
  kept?: boolean;
}

/**
 * The visits a location's own site reported from assistants, added up: by assistant, by day and
 * by page. Under them, always, what the count leaves out and that it can be padded, so nobody
 * reads a zero as "no visits" or a number as exact.
 */
export function VisitCounts({ locationId, kept = false }: VisitCountsProps) {
  const visits = useQuery({
    queryKey: visitsKey(locationId),
    queryFn: () => api.getVisits(locationId),
  });
  if (visits.isPending) return kept ? null : <p className="status">Loading the visits</p>;
  if (visits.isError) return <ErrorNote error={visits.error} />;

  const { total, assistants, days } = visitsShown(visits.data);
  const { pages, other_pages: otherPages } = visits.data;
  if (kept && total === 0) return null;

  return (
    <div className="visit-counts">
      <p className="lede">{total === 0 ? COUNT_WORDS.none : COUNT_WORDS.some(total)}</p>
      {total > 0 && (
        <>
          <Counted caption="By assistant" head={["Assistant", "Visits"]}>
            {assistants.map((row) => (
              <tr key={row.assistant}>
                <td className="counts-cell">{row.name}</td>
                <td className="counts-cell counts-number">{number(row.count)}</td>
              </tr>
            ))}
          </Counted>
          <Counted caption="By day" head={["Day", "Visits", "From"]}>
            {days.map((row) => (
              <tr key={row.day}>
                <td className="counts-cell counts-day">{formatDay(row.day)}</td>
                <td className="counts-cell counts-number">{number(row.count)}</td>
                <td className="counts-cell muted">
                  {row.from}
                  {row.full && `. ${COUNT_WORDS.full}`}
                </td>
              </tr>
            ))}
          </Counted>
          <Counted
            caption={
              pages.length === PAGES_SHOWN
                ? `By page landed on: the ${PAGES_SHOWN} with the most`
                : "By page landed on"
            }
            head={["Page", "Visits"]}
          >
            {pages.map((row) => (
              <tr key={row.path}>
                <td className="counts-cell counts-path mono">{row.path}</td>
                <td className="counts-cell counts-number">{number(row.count)}</td>
              </tr>
            ))}
            {otherPages > 0 && (
              <tr>
                <td className="counts-cell">
                  {COUNT_WORDS.otherPages}{" "}
                  <span className="muted">{COUNT_WORDS.otherPagesAbout}</span>
                </td>
                <td className="counts-cell counts-number">{number(otherPages)}</td>
              </tr>
            )}
          </Counted>
        </>
      )}
      <p className="footnote">{COUNT_WORDS.floor}</p>
      <p className="footnote">
        {COUNT_WORDS.padded} {COUNT_WORDS.days}
      </p>
    </div>
  );
}

/** One small table of counts, named for what it counts by. */
function Counted({
  caption,
  head,
  children,
}: {
  caption: string;
  head: string[];
  children: ReactNode;
}) {
  return (
    <table className="counts-table">
      <caption className="counts-caption">{caption}</caption>
      <thead>
        <tr>
          {head.map((heading, at) => (
            <th
              key={heading}
              scope="col"
              className={at === 1 ? "counts-head counts-number" : "counts-head"}
            >
              {heading}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
