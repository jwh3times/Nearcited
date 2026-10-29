import {
  type ConnectionChoice,
  type FetchCount,
  fetchedHosts,
  fetcherOf,
  LONGEST_FETCHED_PATH,
  type PageFetcher,
} from "@nearcited/shared";

/**
 * Reading a business's own site's fetches from its Cloudflare zone (issue #156,
 * `docs/adr/0028-a-sites-fetches-are-read-from-its-cloudflare-zone.md`).
 *
 * The owner's token reads two things, and can change nothing: the zones it reaches (Zone › Zone ›
 * Read) and their request counts (Zone › Analytics › Read). The counts come from the GraphQL
 * Analytics API's `httpRequestsAdaptiveGroups`, a day (UTC) at a time, since Cloudflare's Free
 * plan answers for no more than a day at once. Its figures are an estimate from a sample on a
 * busy zone, so each is rounded.
 */

const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 15_000;
/** The most pages of zones read: fifty a page. A local business has one or two. */
const MOST_ZONE_PAGES = 20;
/** The most groups asked for in one day's read, where the zone allows that many. */
const MOST_GROUPS = 10_000;

export interface CloudflareDeps {
  /** How Cloudflare is reached. The tests put a made-up one here. */
  fetch?: typeof fetch;
}

/** Cloudflare refused the token: it was rolled or deleted, or lacks a permission. */
export class TokenRefused extends Error {
  constructor(message = "Cloudflare refused the token.") {
    super(message);
    this.name = "TokenRefused";
  }
}

/**
 * How each fetcher's name is written in its user agent, as its maker documents it, for asking
 * Cloudflare for those requests alone. Which fetcher a request was is still decided by `fetcherOf`
 * from the whole user agent, as a hosted page's fetch is. One for every fetcher, so a fetcher
 * added to the list is not missed here.
 */
const SPELLED: Record<PageFetcher, string> = {
  gptbot: "GPTBot",
  "oai-searchbot": "OAI-SearchBot",
  "chatgpt-user": "ChatGPT-User",
  claudebot: "ClaudeBot",
  "claude-searchbot": "Claude-SearchBot",
  "claude-user": "Claude-User",
  perplexitybot: "PerplexityBot",
  "perplexity-user": "Perplexity-User",
  googlebot: "Googlebot",
  bingbot: "bingbot",
};

/** What Cloudflare's REST interface answers. Only the parts read here. */
interface Answered<T> {
  success: boolean;
  errors?: { code: number; message?: string }[];
  result?: T;
  result_info?: { page?: number; total_pages?: number };
}

async function ask(
  url: string,
  token: string,
  deps: CloudflareDeps,
  init: RequestInit = {},
): Promise<Response> {
  const response = await (deps.fetch ?? fetch)(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new TokenRefused(`Cloudflare refused the token (${response.status}).`);
  }
  if (!response.ok) throw new Error(`Cloudflare answered ${response.status}.`);
  return response;
}

/**
 * The zones a token reaches, each as a choice: its ID, and its domain as its label. A token that
 * reaches none is refused, since it can never count anything: it was made for the wrong account
 * or the wrong zones, and only its owner can make another.
 */
export async function listZones(
  token: string,
  deps: CloudflareDeps = {},
): Promise<ConnectionChoice[]> {
  const zones: ConnectionChoice[] = [];
  for (let page = 1; page <= MOST_ZONE_PAGES; page++) {
    const response = await ask(`${API}/zones?per_page=50&page=${page}`, token, deps);
    const answered = (await response.json()) as Answered<{ id: string; name: string }[]>;
    if (!answered.success || !Array.isArray(answered.result)) {
      throw new Error(
        `Cloudflare did not list the zones: ${JSON.stringify(answered.errors ?? [])}`,
      );
    }
    for (const zone of answered.result) {
      if (typeof zone.id === "string" && typeof zone.name === "string") {
        zones.push({ id: zone.id, label: zone.name.toLowerCase() });
      }
    }
    if (page >= (answered.result_info?.total_pages ?? 1)) break;
  }
  if (zones.length === 0) throw new TokenRefused("The token reaches no zone.");
  return zones;
}

/** What Cloudflare's GraphQL interface answers. */
interface Graphed<T> {
  data?: T | null;
  errors?: { message?: string; extensions?: { code?: string } }[] | null;
}

/**
 * Whether an error from the analytics says the token may not read them. Cloudflare answers a
 * token without Zone › Analytics › Read with a 200 and an error of this kind, not a 403, and only
 * a new token mends that.
 */
const notAllowed = (error: { message?: string; extensions?: { code?: string } }) =>
  error.extensions?.code === "authz" ||
  /not authori[sz]ed|does not have access|permission/i.test(error.message ?? "");

async function graph<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  deps: CloudflareDeps,
): Promise<T> {
  const response = await ask(`${API}/graphql`, token, deps, {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
  const answered = (await response.json()) as Graphed<T>;
  if (answered.errors && answered.errors.length > 0) {
    if (answered.errors.some(notAllowed)) {
      throw new TokenRefused("The token may not read this zone's analytics.");
    }
    throw new Error(
      `Cloudflare's analytics answered: ${answered.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!answered.data) throw new Error("Cloudflare's analytics answered nothing.");
  return answered.data;
}

const LIMITS = `query Limits($zone: string!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      settings {
        httpRequestsAdaptiveGroups { notOlderThan maxPageSize }
      }
    }
  }
}`;

/** How far back, in seconds, a zone's request counts are kept, and how many groups one read takes. */
export interface ZoneLimits {
  keptForSeconds: number | null;
  mostGroups: number;
}

/** What a zone's plan lets its request counts be read for. */
export async function zoneLimits(
  token: string,
  zoneId: string,
  deps: CloudflareDeps = {},
): Promise<ZoneLimits> {
  const data = await graph<{
    viewer?: {
      zones?: {
        settings?: {
          httpRequestsAdaptiveGroups?: { notOlderThan?: number; maxPageSize?: number } | null;
        };
      }[];
    };
  }>(token, LIMITS, { zone: zoneId }, deps);
  const limits = data.viewer?.zones?.[0]?.settings?.httpRequestsAdaptiveGroups;
  return {
    keptForSeconds: typeof limits?.notOlderThan === "number" ? limits.notOlderThan : null,
    mostGroups:
      typeof limits?.maxPageSize === "number" && limits.maxPageSize > 0
        ? Math.min(limits.maxPageSize, MOST_GROUPS)
        : MOST_GROUPS,
  };
}

const FETCHES = `query Fetches($zone: string!, $limit: uint64!, $filter: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      httpRequestsAdaptiveGroups(limit: $limit, filter: $filter, orderBy: [count_DESC]) {
        count
        dimensions { userAgent clientRequestPath }
      }
    }
  }
}`;

/**
 * How many requests each known fetcher made for each page of a website's host, with or without
 * `www.`, on each of the days given, at any status. Other hosts in the zone, an answer subdomain
 * among them, and every other user agent are left out. Nothing is kept of a request but the
 * count: not its time, its address, its query or its user agent.
 */
export async function readFetches(
  token: string,
  zone: { zone_id: string; website: string | null },
  days: readonly string[],
  limits: ZoneLimits,
  deps: CloudflareDeps = {},
): Promise<FetchCount[]> {
  const hosts = fetchedHosts(zone.website);
  if (!hosts) return [];
  const counts = new Map<string, FetchCount>();
  for (const day of days) {
    const until = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString();
    const data = await graph<{
      viewer?: {
        zones?: {
          httpRequestsAdaptiveGroups?: {
            count?: number;
            dimensions?: { userAgent?: string; clientRequestPath?: string };
          }[];
        }[];
      };
    }>(
      token,
      FETCHES,
      {
        zone: zone.zone_id,
        limit: limits.mostGroups,
        filter: {
          datetime_geq: `${day}T00:00:00Z`,
          datetime_lt: until,
          clientRequestHTTPHost_in: hosts,
          OR: Object.values(SPELLED).map((name) => ({ userAgent_like: `%${name}%` })),
        },
      },
      deps,
    );
    for (const group of data.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? []) {
      const fetcher = fetcherOf(group.dimensions?.userAgent ?? null);
      const path = group.dimensions?.clientRequestPath
        ?.split("?")[0]
        ?.slice(0, LONGEST_FETCHED_PATH);
      if (!fetcher || !path?.startsWith("/") || !(typeof group.count === "number")) continue;
      const key = `${day}|${fetcher}|${path}`;
      const soFar = counts.get(key);
      counts.set(key, { day, fetcher, path, count: (soFar?.count ?? 0) + group.count });
    }
  }
  return [...counts.values()]
    .map((counted) => ({ ...counted, count: Math.round(counted.count) }))
    .filter((counted) => counted.count > 0);
}
