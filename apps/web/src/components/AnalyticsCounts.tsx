import type { LocationAnalyticsVisits } from "@nearcited/shared";
import { useQuery } from "@tanstack/react-query";
import {
  ANALYTICS_WORDS,
  analyticsLede,
  analyticsNote,
  analyticsShown,
  analyticsVisible,
  analyticsVisitsKey,
  sourcesDiffer,
} from "../lib/analytics-visits";
import { api } from "../lib/api";
import { visitsKey, visitsShown } from "../lib/visits";
import { ErrorNote } from "./ErrorNote";
import { CountTables, VisitCounts } from "./VisitCounts";

interface VisitSourcesProps {
  locationId: string;
  /** True where the plan no longer counts visits. What was counted while one did is still shown. */
  kept?: boolean;
}

/**
 * A location's visits from assistants by where the numbers come from: the line on its site, and
 * its Google Analytics property, each in its own section with its own total and its own statement
 * of what it leaves out. The two are never added. A location with only the line has only what it
 * always had.
 */
export function VisitSources({ locationId, kept = false }: VisitSourcesProps) {
  const analytics = useQuery({
    queryKey: analyticsVisitsKey(locationId),
    queryFn: () => api.getAnalyticsVisits(locationId),
  });
  const line = useQuery({
    queryKey: visitsKey(locationId),
    queryFn: () => api.getVisits(locationId),
  });

  const total = analytics.data ? analyticsShown(analytics.data).total : 0;
  if (!analytics.data || !analyticsVisible(analytics.data.source, total)) {
    return (
      <>
        <VisitCounts locationId={locationId} kept={kept} />
        <ErrorNote error={analytics.error} />
      </>
    );
  }
  const differ = sourcesDiffer(line.data ? visitsShown(line.data).total : 0, total);

  return (
    <>
      <h3 className="side-title">{ANALYTICS_WORDS.lineHeading}</h3>
      <VisitCounts locationId={locationId} kept={kept} />
      <h3 className="side-title">{ANALYTICS_WORDS.heading}</h3>
      <AnalyticsCounts visits={analytics.data} />
      {differ && <p className="footnote">{differ}</p>}
    </>
  );
}

/** What the property reported, added up, with what the count leaves out under it. */
function AnalyticsCounts({ visits }: { visits: LocationAnalyticsVisits }) {
  const shown = analyticsShown(visits);
  const note = analyticsNote(visits.source);
  // Where the sessions are counted on another location's page there is nothing here to read.
  const countedHere = visits.source.state !== "elsewhere";

  return (
    <div className="visit-counts">
      {note && <p className="small muted">{note}</p>}
      {countedHere && <p className="lede">{analyticsLede(visits.source, shown.total)}</p>}
      {shown.total > 0 && (
        <CountTables
          shown={shown}
          pages={visits.pages}
          otherPages={visits.other_pages}
          noun="Sessions"
          otherPagesLabel={ANALYTICS_WORDS.otherPages}
          otherPagesAbout={ANALYTICS_WORDS.otherPagesAbout}
        />
      )}
      {countedHere && (
        <>
          <p className="footnote">{ANALYTICS_WORDS.floor}</p>
          <p className="footnote">
            {ANALYTICS_WORDS.worked} {ANALYTICS_WORDS.days}
          </p>
        </>
      )}
    </div>
  );
}
