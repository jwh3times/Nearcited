import { hostOf } from "./analysis";
import { CITING_SURFACES, type SiteCheck, SURFACE_LABELS, type Surface } from "./schemas";
import { summarizeBySurface } from "./scoring";
import { SITE_CHECKS } from "./site";
import { summarizeSources } from "./sources";

export interface DerivedRecommendation {
  /** Stable key. One open recommendation per rule per location. */
  rule: string;
  title: string;
  detail: string;
}

interface LocationFacts {
  name: string;
  website: string | null;
  google_place_id: string | null;
}

interface ResultFacts {
  surface: Surface;
  mentioned: boolean;
  competitors: string[];
  cited_urls?: readonly string[];
}

/** A site has to be cited this often before it is worth a recommendation. */
const MIN_SOURCE_ANSWERS = 2;
/** At most this many sites are recommended at once, most cited first. */
const MAX_SOURCE_RECOMMENDATIONS = 3;
/** Fewer answers than this say too little to call the business's own site unread. */
const MIN_ANSWERS_FOR_OWN_SITE = 4;

function mostNamed(results: readonly ResultFacts[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const result of results) {
    for (const competitor of result.competitors) {
      counts.set(competitor, (counts.get(competitor) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => name);
}

/**
 * Rule-based next steps from the checks in the scan window.
 *
 * The rule for adding a rule (issue #14): none ships without a stated way to tell, from a later
 * scan, that acting on it worked. A rule that no longer fires is resolved by the database, so
 * "worked" and "stops firing" must be the same condition. Nothing here claims that an action
 * causes an assistant to name a business; each rule only says what was observed and what would
 * be observed if it changed.
 *
 * - `add_website`, `link_google_profile`: bookkeeping. They clear when the field is filled in.
 * - `absent:<surface>`: clears when any check on that surface names the business.
 * - `source:<host>`: a site the answers keep citing, where no answer that cited it named the
 *   business. Clears when an answer that cites the site names the business.
 * - `own_site_uncited`: no answer cited the business's own website. Clears when one does.
 * - `site:<check>`: the on-page check of the business's home page found something an assistant
 *   cannot read past. Clears when the next scan's fetch of the page passes that check. `site` is
 *   null when the page was not checked, which makes no claim either way.
 */
export function deriveRecommendations(
  location: LocationFacts,
  results: readonly ResultFacts[],
  site: SiteCheck | null = null,
): DerivedRecommendation[] {
  const recommendations: DerivedRecommendation[] = [];

  if (!location.website) {
    recommendations.push({
      rule: "add_website",
      title: "Add the website for this location",
      detail:
        "Assistants cite pages. Without a website on file, a citation of your own site cannot be detected, and matching falls back to the business name alone.",
    });
  }

  if (!location.google_place_id) {
    recommendations.push({
      rule: "link_google_profile",
      title: "Link the Google Business Profile",
      detail:
        "Map pack results are matched by place ID first. Without one, a listing under a slightly different name can be missed.",
    });
  }

  for (const summary of summarizeBySurface(results)) {
    if (summary.mentions > 0) continue;
    const named = mostNamed(
      results.filter((result) => result.surface === summary.surface),
      3,
    );
    const label = SURFACE_LABELS[summary.surface];
    recommendations.push({
      rule: `absent:${summary.surface}`,
      title: `Not named on ${label}`,
      detail:
        named.length > 0
          ? `${location.name} did not appear in any of ${summary.checks} checks on ${label}. Named instead: ${named.join(", ")}.`
          : `${location.name} did not appear in any of ${summary.checks} checks on ${label}.`,
    });
  }

  const answers = results
    .filter((result) => CITING_SURFACES.includes(result.surface))
    .map((result) => ({ mentioned: result.mentioned, cited_urls: result.cited_urls ?? [] }));
  const sources = summarizeSources(answers, location.website, Number.POSITIVE_INFINITY);

  for (const source of sources
    .filter((site) => !site.own && site.named === 0 && site.answers >= MIN_SOURCE_ANSWERS)
    .slice(0, MAX_SOURCE_RECOMMENDATIONS)) {
    recommendations.push({
      rule: `source:${source.host}`,
      title: `Check your listing on ${source.host}`,
      detail: `${source.host} was cited in ${source.answers} of ${answers.length} assistant answers, and none of those answers named ${location.name}. Assistants repeat what the pages they read say, so make sure the business is listed there under the same name and city. This clears when an answer that cites ${source.host} names the business.`,
    });
  }

  const ownHost = hostOf(location.website);
  if (ownHost && answers.length >= MIN_ANSWERS_FOR_OWN_SITE && !sources.some((site) => site.own)) {
    recommendations.push({
      rule: "own_site_uncited",
      title: "Assistants are not reading your website",
      detail: `None of the ${answers.length} assistant answers cited ${ownHost}. Make sure its home page says in plain text what the business does and where, so there is something to quote. This clears when an answer cites the site.`,
    });
  }

  for (const check of site?.checks ?? []) {
    if (check.passed) continue;
    const { title, fix } = SITE_CHECKS[check.id];
    const blocked =
      check.id === "crawlers_allowed" && site?.blocked_crawlers.length
        ? ` Blocked: ${site.blocked_crawlers.join(", ")}.`
        : "";
    recommendations.push({
      rule: `site:${check.id}`,
      title,
      detail: `${fix}${blocked} This clears when the next scan reads the page and finds it fixed.`,
    });
  }

  return recommendations;
}
