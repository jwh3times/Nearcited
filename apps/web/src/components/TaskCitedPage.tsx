import { type CitedPage, citedPageLines, type Location } from "@nearcited/shared";

interface TaskCitedPageProps {
  page: CitedPage;
  location: Location;
}

/**
 * What the latest scan found on the page an assistant cited for a directory task, compared with
 * the location's details. The sentences are composed by rule in the shared package.
 */
export function TaskCitedPage({ page, location }: TaskCitedPageProps) {
  return (
    <section className="cited-page" aria-label="What the cited page shows">
      <h4 className="side-title">What the cited page shows</h4>
      <ul>
        {citedPageLines(page, location).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="small muted">
        {page.not_read ? "Asked for by NearcitedBot" : "Read by NearcitedBot"} in the latest scan:{" "}
        <a href={page.url} target="_blank" rel="noopener noreferrer nofollow">
          {page.url}
        </a>
      </p>
    </section>
  );
}
