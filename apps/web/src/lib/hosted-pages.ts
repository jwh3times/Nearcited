import {
  type AnswerSubdomain,
  FETCHES_SHOWN_DAYS,
  type FetcherGroup,
  PAGE_FETCHERS,
  type PageFetches,
  REDIRECTED_FOR_DAYS,
  SERVED_AFTER_PAUSE_DAYS,
} from "@nearcited/shared";

/**
 * The days a paused answer subdomain stops serving its pages as they are, and is removed, from
 * the day it was paused.
 */
export function windingDown(pausedAt: string): { served: string; removed: string } {
  const served = Date.parse(pausedAt) + SERVED_AFTER_PAUSE_DAYS * 86_400_000;
  return {
    served: new Date(served).toISOString(),
    removed: new Date(served + REDIRECTED_FOR_DAYS * 86_400_000).toISOString(),
  };
}

/** How often the card asks again while the worker is waiting for the record or the certificate. */
export const WAITING_MS = 15_000;

/** Where a location's hosted pages are kept in the page's cache, for the card and the tasks. */
export const hostedPagesKey = (locationId: string) => ["hosted-pages", locationId];

/** Whether pages are offered for publishing on a subdomain now: live, working, still matching. */
export const offersPages = (subdomain: AnswerSubdomain | null | undefined): boolean =>
  !!subdomain?.live_at && subdomain.status === "working" && subdomain.website_matches;

/** True while the worker is still to find the record or see the certificate issued. */
export const settingUp = (subdomain: AnswerSubdomain): boolean =>
  subdomain.status === "working" && subdomain.live_at === null;

/** What the card says, kept together so the tests and the page agree. */
export const HOSTED_WORDS = {
  title: "Pages on your own domain",
  about:
    "Your site's builder offers no way for Nearcited to publish to it. Nearcited can host the pages written for your prompts instead, on a subdomain of your own domain: a name in front of it, such as answers.yourbusiness.com. You add one record where your domain is managed, once, and each page goes up only after somebody here approves it.",
  label: "Subdomain",
  hint: "One word: letters, digits and hyphens.",
  makeIt: "Set up the subdomain",
  making: "Setting it up",
  onlyManagers: "Only your organization's owner or an admin can set this up.",
  noWebsite: "Pages go on a subdomain of your website, and there is no website on file.",
  noOwnDomain:
    "Your website is at your site builder's own address, so there is no domain of yours to add a record to. Pages on your own domain need one: once your site is on a domain of your own, change the website under Settings.",
  removed: (hostname: string, why: string, day: string) =>
    `${hostname} was removed${day ? ` on ${day}` : ""}${why}. If its record is still in place, delete it, or point it at the new target once you set one up again.`,
  unavailable: "Pages on your own domain cannot be set up here yet.",
  record: "Add this record where your domain's DNS is managed:",
  wholeName: (hostname: string) =>
    `Some providers want the whole name instead: ${hostname}. Leave anything else they ask for as it is.`,
  cloudflare:
    "If your domain is on Cloudflare, set the record's proxy status to DNS only (the grey cloud).",
  where: "Where to add a record, at the common providers",
  waiting: (until: string) =>
    `Waiting for the record. Nearcited looks for it every few minutes until ${until}; a new record can take up to an hour to be seen.`,
  proxied:
    "The record was found, but it is proxied by Cloudflare, which hides where it points. Set its proxy status to DNS only (the grey cloud).",
  elsewhere:
    "The name points somewhere else. Check that the record's target is exactly the one above.",
  registering:
    "The record is in place. The certificate that keeps the pages secure is being set up; this usually takes a few minutes.",
  live: (hostname: string) => `Working. Pages approved here go up at ${hostname}.`,
  linked: "Your home page links to it, so assistants reading your site can find the pages.",
  link: "Add a link to it on your home page, so assistants reading your site find the pages. Nearcited ticks this off by itself once the link is there:",
  copyLink: "Copy the link",
  moved:
    "Your website is now on another domain, so no new pages are offered here. Pages already published stay up. Remove the subdomain on the Connections page, or put the website back under Settings.",
  manage: "The subdomain is removed on the",
  paused: (served: string, removed: string) =>
    `Your plan no longer includes pages on your own domain, so nothing new is published here. The pages already up stay until ${served}. From then, visitors are sent on to your website until ${removed}, when the subdomain is removed.`,
  removing: "Being removed.",
} as const;

/** The link an owner pastes on their home page. */
export const homeLink = (hostname: string): string =>
  `<a href="https://${hostname}/">Answers to common questions</a>`;

/** Why an answer subdomain was removed, as a clause after "was removed". */
export function removedBecause(reason: string | null): string {
  switch (reason) {
    case "plan":
      return ", because your plan no longer includes it";
    case "unclaimed":
      return ", because it had not started working after thirty days";
    case "location":
      return " with its location";
    default:
      return "";
  }
}

/** One fetcher's reads, as a page task writes them: "ClaudeBot (Anthropic) 5 times". */
const fetchedBy = ({ fetcher, count }: PageFetches) =>
  `${PAGE_FETCHERS[fetcher].name} (${PAGE_FETCHERS[fetcher].maker}) ${count === 1 ? "once" : `${count} times`}`;

/**
 * What a page task says of who fetched its hosted page lately: the assistants' fetchers and the
 * search engines' crawlers apart, and that the count can be padded. Null where none fetched it.
 */
export function fetchesLine(fetches: readonly PageFetches[]): string | null {
  const of = (group: FetcherGroup, by: string) => {
    const these = fetches.filter((counted) => PAGE_FETCHERS[counted.fetcher].group === group);
    return these.length > 0 ? `by ${by}: ${these.map(fetchedBy).join(", ")}.` : null;
  };
  const groups = [of("assistant", "assistants"), of("search", "search engines")].filter(
    (said): said is string => said !== null,
  );
  if (groups.length === 0) return null;
  const [first, ...rest] = groups;
  return [
    `Fetched in the last ${FETCHES_SHOWN_DAYS} days ${first}`,
    ...rest.map((said) => ` ${said.charAt(0).toUpperCase()}${said.slice(1)}`),
    " Anyone can claim to be one of these, so this shows the page is being read, not who read it.",
  ].join("");
}
