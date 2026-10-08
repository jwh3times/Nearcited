import { hostOf, normalizeName } from "./analysis";
import type { Action, SiteCheck, SiteCheckId, SourceSummary } from "./schemas";
import { SITE_CHECKS } from "./site";

/**
 * The action plan: what the evidence says to do next, in order.
 *
 * Every action is composed from counts and checks the product already holds, and says which. No
 * action is written by a model and none claims that doing it will make an assistant name the
 * business; each one states what was observed, so the next scan or audit can show whether it
 * changed.
 */

export interface NameCount {
  name: string;
  count: number;
}

export interface ActionPlanInput {
  /** The business the plan is for. */
  name: string;
  website: string | null;
  /** How many answers the counts below are out of. */
  answers: number;
  /** Every site those answers cited. The business's own site must be among them if it was cited. */
  sources: readonly SourceSummary[];
  /** The on-page check of the business's home page, or null when it was not made. */
  site: SiteCheck | null;
  /** Who else the answers named, with how many answers named each. */
  competitors: readonly NameCount[];
}

/** Fewer answers than this say too little to call the business's own site unread. */
const MIN_ANSWERS_FOR_OWN_SITE = 4;
/** A site has to be cited this often before the plan sends anyone to it. */
const MIN_SOURCE_ANSWERS = 2;
const MAX_ITEMS = 5;
/** The failed checks that mean a crawler gets nothing from the page. */
const BLOCKS_READING: ReadonlySet<SiteCheckId> = new Set([
  "reachable",
  "crawlers_allowed",
  "text_content",
]);
const MAX_COMPETITORS = 3;

/**
 * Adds up names that are the same business spelled differently ("Tony's" and "Tony's, LLC"),
 * keeping the shortest spelling. Most named first.
 */
export function tallyNames(counts: readonly NameCount[], limit?: number): NameCount[] {
  const tally = new Map<string, NameCount>();
  for (const { name, count } of counts) {
    const key = normalizeName(name) || name;
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

const compact = (value: string) => normalizeName(value).replaceAll(" ", "");

/**
 * Whether a site looks like a named business's own: its address contains the name run together,
 * as "theedigital.com" does for "TheeDigital". A guess, used only to avoid telling someone to get
 * listed on a competitor's website. Short names are never matched.
 */
function belongsTo(host: string, name: string): boolean {
  const needle = compact(name);
  if (needle.length < 6) return false;
  return compact(host.split(".").slice(0, -1).join(" ")).includes(needle);
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

function websiteAction(input: ActionPlanInput): Action | null {
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
export function buildActionPlan(input: ActionPlanInput): Action[] {
  const actions: Action[] = [];
  const competitors = tallyNames(input.competitors);
  const others = input.sources.filter(
    (source) => !source.own && !competitors.some(({ name }) => belongsTo(source.host, name)),
  );

  const website = websiteAction(input);
  if (website) actions.push(website);

  const missing = others
    .filter((source) => source.named === 0 && source.answers >= MIN_SOURCE_ANSWERS)
    .slice(0, MAX_ITEMS);
  if (missing.length > 0) {
    actions.push({
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
    actions.push({
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
  if (named.length > 0 && input.answers > 0) {
    actions.push({
      id: "competitors",
      title: "See who is recommended instead",
      summary:
        "The businesses the answers named most. Where their own site was one of the pages read, it is linked: it shows what an assistant found worth quoting.",
      items: named.map(({ name, count, url }) => ({
        label: name,
        detail: `Named in ${count} of ${input.answers} answers`,
        url,
      })),
    });
  }

  return actions;
}
