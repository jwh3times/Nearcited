import { hostOf, hostsMatch } from "./analysis";
import type { SourceSummary } from "./schemas";

/**
 * Which sites the answers were built from.
 *
 * An assistant with web search reads a handful of pages and then answers, and it lists those
 * pages. Counted over many answers, that list is the most direct thing a business can act on:
 * the sites that are read, and whether the answers that read them named the business.
 *
 * What this cannot say is whether a site mentions the business. "Named" here means the answer
 * that cited the site named the business, which is the thing a later scan can check again.
 */

/** One answer, as far as its sources are concerned. */
export interface SourcedAnswer {
  mentioned: boolean;
  cited_urls: readonly string[];
}

export const MAX_SOURCES = 12;
/** How many of a site's pages are kept, most cited first. */
export const MAX_SOURCE_URLS = 3;

const isWebLink = (url: string) => /^https?:\/\//i.test(url);

function ranked(sources: Iterable<SourceSummary>, limit: number): SourceSummary[] {
  return [...sources]
    .sort((a, b) => b.answers - a.answers || a.host.localeCompare(b.host))
    .slice(0, limit);
}

/**
 * One row per site, most cited first. A site counts once per answer however many of its pages
 * that answer cited. `website` is the business's own site, which is marked rather than left out.
 */
export function summarizeSources(
  answers: readonly SourcedAnswer[],
  website: string | null | undefined,
  limit = MAX_SOURCES,
): SourceSummary[] {
  const ownHost = hostOf(website);
  const sites = new Map<string, { answers: number; named: number; pages: Map<string, number> }>();

  for (const answer of answers) {
    const pagesByHost = new Map<string, Set<string>>();
    for (const url of answer.cited_urls) {
      const host = isWebLink(url) ? hostOf(url) : null;
      if (!host) continue;
      pagesByHost.set(host, (pagesByHost.get(host) ?? new Set()).add(url));
    }
    for (const [host, pages] of pagesByHost) {
      const site = sites.get(host) ?? { answers: 0, named: 0, pages: new Map() };
      site.answers += 1;
      if (answer.mentioned) site.named += 1;
      for (const page of pages) site.pages.set(page, (site.pages.get(page) ?? 0) + 1);
      sites.set(host, site);
    }
  }

  return ranked(
    [...sites].map(([host, site]) => ({
      host,
      answers: site.answers,
      named: site.named,
      own: hostsMatch(host, ownHost),
      urls: [...site.pages]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_SOURCE_URLS)
        .map(([url]) => url),
    })),
    limit,
  );
}

/** Adds up summaries made from separate sets of answers, such as the cells of an audit. */
export function mergeSources(
  lists: readonly (readonly SourceSummary[])[],
  limit = MAX_SOURCES,
): SourceSummary[] {
  const sites = new Map<string, SourceSummary>();
  for (const source of lists.flat()) {
    const site = sites.get(source.host);
    if (!site) {
      sites.set(source.host, { ...source, urls: [...source.urls] });
      continue;
    }
    site.answers += source.answers;
    site.named += source.named;
    site.own ||= source.own;
    site.urls = [...new Set([...site.urls, ...source.urls])].slice(0, MAX_SOURCE_URLS);
  }
  return ranked(sites.values(), limit);
}
