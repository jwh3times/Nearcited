import { type Location, websiteDomain } from "@nearcited/shared";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { api } from "../lib/api";
import {
  about,
  FETCH_WORDS,
  type FetcherShown,
  fetchesKey,
  fetchesLede,
  fetchesShown,
} from "../lib/fetches";
import { formatDay } from "../lib/visits";
import { ErrorNote } from "./ErrorNote";
import { Counted } from "./VisitCounts";

interface SiteFetchesProps {
  location: Location;
  /** Where the organization's pages are, for the links to Connections and another location. */
  base: string;
}

/**
 * How often assistants' fetchers and search engines' crawlers read a location's own website, on
 * its Website tab: read from its Cloudflare zone, the two kinds apart, each fetcher with its total,
 * its days and its pages fetched most. Under them, always, what is not counted and that a
 * fetcher's name can be claimed. Without a connection, what connecting adds; where another
 * location holds the zone, which one.
 */
export function SiteFetches({ location, base }: SiteFetchesProps) {
  const fetches = useQuery({
    queryKey: fetchesKey(location.id),
    queryFn: () => api.getFetches(location.id),
  });
  if (fetches.isPending) return null;
  if (fetches.isError) return <ErrorNote error={fetches.error} />;

  const { source } = fetches.data;
  const shown = fetchesShown(fetches.data);
  const counted = shown.assistant.total + shown.search.total > 0;
  // A plan that never counted them says nothing of them.
  if (source.state === "not_on_plan" && !counted) return null;
  const host = websiteDomain(location.website) ?? "the website";

  let note: ReactNode = null;
  switch (source.state) {
    case "not_connected":
      note = (
        <>
          <p>{FETCH_WORDS.notConnected}</p>
          <p>
            <Link to={`${base}/connections`}>{FETCH_WORDS.connect}</Link>.{" "}
            {FETCH_WORDS.notBehindCloudflare}
          </p>
        </>
      );
      break;
    case "no_website":
      note = <p>{FETCH_WORDS.noWebsite}</p>;
      break;
    case "broken":
      note = (
        <p>
          {FETCH_WORDS.brokenUnread} <Link to={`${base}/connections`}>See Connections</Link>
        </p>
      );
      break;
    case "not_in_zone":
      note = <p>{FETCH_WORDS.notInZone(host)}</p>;
      break;
    case "waiting":
      note = <p>{FETCH_WORDS.waiting}</p>;
      break;
    case "elsewhere":
      note = (
        <p>
          {source.same_website
            ? FETCH_WORDS.elsewhere(source.zone, source.location_name)
            : FETCH_WORDS.elsewhereOtherSite(source.zone, source.location_name, host)}{" "}
          <Link to={`${base}/locations/${source.location_id}?tab=website`}>
            See {source.location_name}
          </Link>
        </p>
      );
      break;
    case "not_on_plan":
      note = <p>{FETCH_WORDS.notOnPlan}</p>;
      break;
    case "sample":
      note = <p>{FETCH_WORDS.sample}</p>;
      break;
    case "counted":
      if (source.broken) {
        note = (
          <p>
            {FETCH_WORDS.broken} <Link to={`${base}/connections`}>See Connections</Link>
          </p>
        );
      } else if (fetches.data.read_through === null) {
        note = <p>{FETCH_WORDS.reading}</p>;
      }
      break;
  }
  const showCounts =
    counted ||
    source.state === "sample" ||
    (source.state === "counted" && fetches.data.read_through !== null);

  return (
    <section className="visits" aria-labelledby="fetches-title">
      <div className="section-head">
        <h2 id="fetches-title">{FETCH_WORDS.title}</h2>
        {source.state === "counted" && <span className="mono">{source.zone}</span>}
      </div>
      <div className="visit-counts">
        <p className="muted">{FETCH_WORDS.about}</p>
        {note}
        {showCounts && (
          <>
            <p className="lede">{fetchesLede(shown)}</p>
            <FetcherGroup title={FETCH_WORDS.assistants} fetchers={shown.assistant.fetchers} />
            <FetcherGroup title={FETCH_WORDS.search} fetchers={shown.search.fetchers} />
          </>
        )}
        <p className="footnote">{FETCH_WORDS.notCounted}</p>
      </div>
    </section>
  );
}

/** One kind of fetcher: a line for each, opening onto its days and its pages. */
function FetcherGroup({ title, fetchers }: { title: string; fetchers: FetcherShown[] }) {
  if (fetchers.length === 0) return null;
  return (
    <div className="stack-tight">
      <h3 className="counts-caption">{title}</h3>
      {fetchers.map((shown) => (
        <details key={shown.fetcher}>
          <summary>
            {shown.name} <span className="muted">({shown.maker})</span>: {about(shown.total)}
          </summary>
          <Counted caption={FETCH_WORDS.byDay} head={["Day", "Fetches"]}>
            {shown.days.map((row) => (
              <tr key={row.day}>
                <td className="counts-cell counts-day">{formatDay(row.day)}</td>
                <td className="counts-cell counts-number">{about(row.count)}</td>
              </tr>
            ))}
          </Counted>
          <Counted caption={FETCH_WORDS.pages} head={["Page", "Fetches"]}>
            {shown.pages.map((row) => (
              <tr key={row.path}>
                <td className="counts-cell counts-path mono">{row.path}</td>
                <td className="counts-cell counts-number">{about(row.count)}</td>
              </tr>
            ))}
            {shown.other > 0 && (
              <tr>
                <td className="counts-cell">
                  {FETCH_WORDS.otherPages}{" "}
                  <span className="muted">{FETCH_WORDS.otherPagesAbout}</span>
                </td>
                <td className="counts-cell counts-number">{about(shown.other)}</td>
              </tr>
            )}
          </Counted>
        </details>
      ))}
    </div>
  );
}
