import { competitorKey, hostOf, namesMatch, othersThan } from "./analysis";
import type { ActionPlanStep, NameCount, SiteCheck, SiteCheckId, SourceSummary } from "./schemas";
import { SITE_CHECKS } from "./site";
import { belongsTo, unnamedSources } from "./sources";

/**
 * The action plan: what the evidence says to do next, in order.
 *
 * Every action is composed from counts and checks the product already holds, and says which. No
 * action is written by a model and none claims that doing it will make an assistant name the
 * business; each one states what was observed, so the next scan or audit can show whether it
 * changed.
 */

export interface ActionPlanInput {
  /** The business the plan is for. */
  name: string;
  website: string | null;
  /** How many answers the sources are counted out of. */
  answers: number;
  /** How many checks the competitors are counted out of: every one that showed something. */
  checks: number;
  /** Every site those answers cited. The business's own site must be among them if it was cited. */
  sources: readonly SourceSummary[];
  /** The on-page check of the business's home page, or null when it was not made. */
  site: SiteCheck | null;
  /** Who else the checks named, with how many checks named each. */
  competitors: readonly NameCount[];
}

/** Fewer answers than this say too little to call the business's own site unread. */
const MIN_ANSWERS_FOR_OWN_SITE = 4;
const MAX_ITEMS = 5;
/** The failed checks that mean a crawler gets nothing from the page. */
const BLOCKS_READING: ReadonlySet<SiteCheckId> = new Set([
  "reachable",
  "crawlers_allowed",
  "text_content",
]);
const MAX_COMPETITORS = 3;

/**
 * Adds up names that are the same competitor spelled differently ("Tony's" and "Tony's, LLC",
 * "North Star Realty" and "Northstar Realty Co"; see `competitorKey`), keeping the shortest
 * spelling. Most named first.
 */
export function tallyNames(counts: readonly NameCount[], limit?: number): NameCount[] {
  const tally = new Map<string, NameCount>();
  for (const { name, count } of counts) {
    const key = competitorKey(name) || name;
    const entry = tally.get(key);
    if (!entry) tally.set(key, { name, count });
    else {
      entry.count += count;
      if (name.length < entry.name.length) entry.name = name;
    }
  }
  return [...tally.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Who the checks named instead, spellings added up: a check counts once for each competitor, even
 * when it wrote one two ways, so a count is never more than the checks. A spelling of the
 * business itself, `name`, is left out: a check kept before it was known as the business's own
 * may list it.
 */
export function tallyNamedInstead(
  checks: readonly { competitors: readonly string[] }[],
  name: string,
): NameCount[] {
  const once = (names: readonly string[]) =>
    tallyNames(othersThan(name, names).map((other) => ({ name: other, count: 1 }))).map(
      (other) => ({ name: other.name, count: 1 }),
    );
  return tallyNames(checks.flatMap((check) => once(check.competitors)));
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

function websiteStep(input: ActionPlanInput): ActionPlanStep | null {
  const host = hostOf(input.website);
  if (!host) return null;

  const own = input.sources.find((source) => source.own);
  // A check that could not load the page has no checks in it, and counts as no check at all.
  const site = input.site?.checks.length ? input.site : null;
  const failed = (site?.checks ?? []).filter((check) => !check.passed);
  const items = failed.map((check) => ({
    label: SITE_CHECKS[check.id].title,
    detail:
      check.id === "crawlers_allowed" && site?.blocked_crawlers.length
        ? `${SITE_CHECKS[check.id].fix} Blocked: ${site.blocked_crawlers.join(", ")}.`
        : SITE_CHECKS[check.id].fix,
    url: null,
  }));
  const problems = `${failed.length} ${plural(failed.length, "thing", "things")} to fix`;
  // Only some failures stop a crawler from reading the page. The rest are worth fixing, but the
  // plan must not offer them as the reason the site is not cited.
  const blocking = failed.filter((check) => BLOCKS_READING.has(check.id)).length;
  const weight =
    blocking === 0
      ? `${failed.length === 1 ? "It does" : "None of them does"} not stop an assistant from reading the page, so ${failed.length === 1 ? "it is" : "they are"} unlikely to be the whole reason.`
      : blocking === failed.length
        ? `${failed.length === 1 ? "It keeps" : "They keep"} an assistant from reading the page.`
        : `${blocking} of them ${plural(blocking, "keeps", "keep")} an assistant from reading the page.`;

  if (own) {
    if (failed.length === 0) return null;
    return {
      id: "fix_website",
      title: "Fix what the website check found",
      summary: `${host} was cited in ${own.answers} of ${input.answers} answers, and the check of its home page found ${problems}.`,
      items,
    };
  }

  const uncited = `None of the ${input.answers} answers cited ${host}`;
  if (failed.length > 0) {
    const found = `the check of its home page found ${problems}. ${weight}`;
    return {
      id: "fix_website",
      title:
        blocking > 0
          ? "Make your website readable to assistants"
          : "Your website is not being cited",
      summary:
        input.answers > 0
          ? `${uncited}, and ${found}`
          : `No answers have come in yet, but ${found}`,
      items,
    };
  }
  if (input.answers < MIN_ANSWERS_FOR_OWN_SITE) return null;
  return {
    id: "fix_website",
    title: site
      ? "Your website is readable, but is not being used"
      : "Your website is not being cited",
    summary: site
      ? `${uncited}. Its home page passed every check, so assistants can read it; they are choosing other sources. The listings below are where to work first.`
      : `${uncited}. The home page was not checked, so there is no reason to give yet.`,
    items: [],
  };
}

/** The plan, most direct action first. Empty when there is nothing to go on. */
export function buildActionPlan(input: ActionPlanInput): ActionPlanStep[] {
  const steps: ActionPlanStep[] = [];
  const competitors = tallyNames(
    input.competitors.filter(({ name }) => !namesMatch(name, input.name)),
  );
  // Every name, the business's own spellings too: a site that looks like one is no directory.
  const names = input.competitors.map(({ name }) => name);
  const others = input.sources.filter(
    (source) => !source.own && !names.some((name) => belongsTo(source.host, name)),
  );

  const website = websiteStep(input);
  if (website) steps.push(website);

  const missing = unnamedSources(input.sources, names);
  if (missing.length > 0) {
    steps.push({
      id: "get_listed",
      title: "Get listed where the assistants look",
      summary: `These sites were read for answers that never named ${input.name}. Where one is a directory or a review site, check that the business is on it under the same name and city.`,
      items: missing.map((source) => ({
        label: source.host,
        detail: `Cited in ${source.answers} of ${input.answers} answers`,
        url: source.urls[0] ?? null,
      })),
    });
  }

  const working = others
    .filter((source) => source.named > 0)
    .sort((a, b) => b.named - a.named || a.host.localeCompare(b.host))
    .slice(0, MAX_ITEMS);
  if (working.length > 0) {
    steps.push({
      id: "keep_listings",
      title: "Keep these listings accurate",
      summary: `Answers that read these sites named ${input.name}. They are where the assistants are getting the business from, so keep the name, address and hours on them current.`,
      items: working.map((source) => ({
        label: source.host,
        detail: `Named you in ${source.named} of the ${source.answers} ${plural(source.answers, "answer", "answers")} that cited it`,
        url: source.urls[0] ?? null,
      })),
    });
  }

  const ownPage = (name: string) =>
    input.sources.find((source) => belongsTo(source.host, name))?.urls[0] ?? null;
  // Among businesses named equally often, one whose own site was read comes first: its link is
  // the only thing here a reader can follow.
  const named = competitors
    .map((competitor) => ({ ...competitor, url: ownPage(competitor.name) }))
    .sort((a, b) => b.count - a.count || Number(b.url !== null) - Number(a.url !== null))
    .slice(0, MAX_COMPETITORS);
  if (named.length > 0 && input.checks > 0) {
    steps.push({
      id: "competitors",
      title: "See who is recommended instead",
      summary:
        "The businesses the checks named most, Google's results included. Where their own site was one of the pages read, it is linked: it shows what an assistant found worth quoting.",
      items: named.map(({ name, count, url }) => ({
        label: name,
        detail: `Named in ${count} of ${input.checks} ${plural(input.checks, "check", "checks")}`,
        url,
      })),
    });
  }

  return steps;
}
