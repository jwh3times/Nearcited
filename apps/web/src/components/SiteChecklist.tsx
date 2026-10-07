import { SITE_CHECKS, type SiteCheck } from "@nearcited/shared";
import { sourceLabel } from "../lib/format";

/** What the on-page check found on the business's own home page, one line per check. */
export function SiteChecklist({ site }: { site: SiteCheck }) {
  const host = sourceLabel(site.url);
  return (
    <>
      <p className="muted audit-note">
        We read {host ?? "the website"} the way an assistant's crawler would: the home page, without
        running its scripts, and the site's robots.txt.
      </p>
      <ul className="site-checks">
        {site.checks.map((check) => (
          <li key={check.id} className={check.passed ? "site-pass" : "site-fail"}>
            <span className="site-mark" aria-hidden="true">
              {check.passed ? "✓" : "✕"}
            </span>
            <div>
              <strong>
                {check.passed ? SITE_CHECKS[check.id].label : SITE_CHECKS[check.id].title}
              </strong>
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
