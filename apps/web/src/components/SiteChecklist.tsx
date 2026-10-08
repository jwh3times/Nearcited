import { SITE_CHECKS, type SiteCheck } from "@nearcited/shared";
import { sourceLabel } from "../lib/format";

/** What the on-page check found on the business's own home page, one line per check. */
export function SiteChecklist({ site }: { site: SiteCheck }) {
  const host = sourceLabel(site.url);
  // No checks means the page could not be loaded in a way that proves nothing about the site.
  if (site.checks.length === 0) {
    return (
      <p className="card notice">
        We tried to read {host ?? "the website"} and could not:{" "}
        {site.status === null ? "it gave no answer" : `it answered with status ${site.status}`}.
        That was one attempt from our servers. It does not show that the site is down, or that an
        assistant cannot read it, so nothing is claimed here. If the address does not open for you
        either, the address on file may be wrong.
      </p>
    );
  }
  return (
    <>
      <p className="intro">
        We read {host ?? "the website"} the way an assistant's crawler would: the home page, without
        running its scripts, and the site's robots.txt.
      </p>
      <ul className="checks">
        {site.checks.map((check) => (
          <li key={check.id}>
            <span className={check.passed ? "mark-ok" : "mark-bad"} aria-hidden="true">
              {check.passed ? "✓" : "✕"}
            </span>
            <div>
              {check.passed ? SITE_CHECKS[check.id].label : SITE_CHECKS[check.id].title}
              {!check.passed && (
                <p>
                  {SITE_CHECKS[check.id].fix}
                  {check.id === "crawlers_allowed" && site.blocked_crawlers.length > 0 && (
                    <> Blocked: {site.blocked_crawlers.join(", ")}.</>
                  )}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
