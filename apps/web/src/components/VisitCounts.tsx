import { type LocationVisits, PAGES_SHOWN } from "@nearcited/shared";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { COUNT_WORDS, formatDay, type VisitsShown, visitsKey, visitsShown } from "../lib/visits";
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

  const shown = visitsShown(visits.data);
  const { total } = shown;
  if (kept && total === 0) return null;

  return (
    <div className="visit-counts">
      <p className="lede">{total === 0 ? COUNT_WORDS.none : COUNT_WORDS.some(total)}</p>
      {total > 0 && (
        <CountTables
          shown={shown}
          pages={visits.data.pages}
          otherPages={visits.data.other_pages}
          noun="Visits"
          otherPagesLabel={COUNT_WORDS.otherPages}
          otherPagesAbout={COUNT_WORDS.otherPagesAbout}
        />
      )}
      <p className="footnote">{COUNT_WORDS.floor}</p>
      <p className="footnote">
        {COUNT_WORDS.padded} {COUNT_WORDS.days}
      </p>
    </div>
  );
}

/** The three tables of a source's counts: by assistant, by day and by page landed on. */
export function CountTables({
  shown,
  pages,
  otherPages,
  noun,
  otherPagesLabel,
  otherPagesAbout,
}: {
  shown: VisitsShown;
  pages: LocationVisits["pages"];
  otherPages: number;
  /** What the source counts, as a column's heading. */
  noun: string;
  otherPagesLabel: string;
  otherPagesAbout: string;
}) {
  return (
    <>
      <Counted caption="By assistant" head={["Assistant", noun]}>
        {shown.assistants.map((row) => (
          <tr key={row.assistant}>
            <td className="counts-cell">{row.name}</td>
            <td className="counts-cell counts-number">{number(row.count)}</td>
          </tr>
        ))}
      </Counted>
      <Counted caption="By day" head={["Day", noun, "From"]}>
        {shown.days.map((row) => (
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
        head={["Page", noun]}
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
              {otherPagesLabel} <span className="muted">{otherPagesAbout}</span>
            </td>
            <td className="counts-cell counts-number">{number(otherPages)}</td>
          </tr>
        )}
      </Counted>
    </>
  );
}

/** One small table of counts, named for what it counts by. */
export function Counted({
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
