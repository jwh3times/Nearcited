import { cardWords } from "@nearcited/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { ErrorNote } from "../components/ErrorNote";
import { DownloadCode, ReviewCode } from "../components/ReviewCode";
import { api } from "../lib/api";
import { CODE_WORDS, cardFor } from "../lib/asking";
import { locationKey } from "../lib/locations";
import { useViewing } from "../lib/viewing";

/**
 * The card an owner prints to ask customers for a review: the business's name, one line, the
 * code that opens the link a review task keeps, and how to use it. The page shows the card at
 * the size it prints, and on paper the card is all there is. It is made from what the location
 * page already loads, so there is nothing of its own to fetch, keep or send.
 */
export function ReviewCard() {
  const { id = "", site = "" } = useParams();
  const { base } = useViewing();
  // Already loaded by the location page this is reached from, so this reads the cache.
  const detail = useQuery({ queryKey: locationKey(id), queryFn: () => api.getLocation(id) });

  if (detail.isPending) return <p className="page status">Loading</p>;
  if (detail.isError) {
    return (
      <main className="page">
        <ErrorNote error={detail.error} />
        <Link to={base || "/"}>Back to locations</Link>
      </main>
    );
  }

  const { location, tasks } = detail.data;
  const given = cardFor(tasks, location, site);
  const words = given && cardWords(given);

  return (
    <main className="page card-page">
      <div className="card-controls">
        <p className="breadcrumb">
          <Link to={`${base}/locations/${id}`}>{location.name}</Link> / A card to print
        </p>
        <h1>A card to print</h1>
        <p className="lede">{given ? CODE_WORDS.card : CODE_WORDS.none}</p>
        {given && (
          <div className="card-actions">
            <button type="button" onClick={() => window.print()}>
              Print the card
            </button>
            <DownloadCode given={given} />
          </div>
        )}
      </div>
      {given && words && (
        <section className="review-card" aria-label="The card as it prints">
          <h2>{words.heading}</h2>
          <p className="card-ask">{words.ask}</p>
          <ReviewCode link={given.link} />
          <p className="card-how">{words.how}</p>
        </section>
      )}
    </main>
  );
}
