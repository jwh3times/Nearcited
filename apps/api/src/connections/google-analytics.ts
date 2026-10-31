import {
  ANALYTICS_REPORT_SOURCES,
  type AnalyticsVisitCount,
  assistantOfSource,
  LONGEST_PATH,
  websiteDomain,
} from "@nearcited/shared";
import { type GoogleDeps, GoogleRefused } from "./google";

/**
 * Reading a business's sessions from assistants from its Google Analytics property (issue #144,
 * `docs/adr/0029-analytics-counts-are-kept-apart-from-the-lines.md`).
 *
 * The sign-in reads and can change nothing. The Admin API says which properties it reaches and which
 * websites each measures, and the Data API how many sessions each assistant sent to each page. Only
 * sessions from assistants are asked for, and nothing is kept of one but the count. The tests answer
 * with responses written from Google's documentation: nobody has run this against a real property
 * yet.
 */

/** The one scope a Google Analytics connection asks for. */
export const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const DATA = "https://analyticsdata.googleapis.com/v1beta";
const TIMEOUT_MS = 15_000;
/** The most pages of account summaries read: two hundred accounts a page. */
const MOST_ACCOUNT_PAGES = 5;
/**
 * The most properties whose streams one sync looks at, since each is a request of its own. A local
 * business has one or two. A sign-in that reaches more, an agency's, has the rest left out.
 */
const MOST_PROPERTIES = 100;
/** The most rows a page of a report asks for. */
const REPORT_PAGE = 10_000;
/** The most pages of a report read, which is far past what a bound of pages a day keeps. */
const MOST_REPORT_PAGES = 10;

/** A property a sign-in reaches, with the hosts its web streams measure, without `www.`. */
export interface AnalyticsProperty {
  id: string;
  label: string;
  hosts: string[];
}

/** The run of days a report covers, both as `YYYY-MM-DD`. */
export interface ReportDays {
  from: string;
  to: string;
}

/**
 * Whether what Google answered says the sign-in is at fault, which only its owner can mend. Any other
 * refusal is this product's project or a passing fault, and is tried again.
 */
async function refused(response: Response): Promise<boolean> {
  if (response.status === 401) return true;
  if (response.status !== 403) return false;
  try {
    const { error } = (await response.json()) as {
      error?: { details?: { reason?: unknown }[] };
    };
    return error?.details?.some((d) => d.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT") ?? false;
  } catch {
    return false;
  }
}

async function ask<T>(
  url: string,
  token: string,
  deps: GoogleDeps,
  init: RequestInit = {},
): Promise<T> {
  const response = await (deps.fetch ?? fetch)(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const { status } = response;
    if (await refused(response)) throw new GoogleRefused(`Google refused the sign-in (${status}).`);
    throw new Error(`Google Analytics answered ${status}.`);
  }
  return (await response.json()) as T;
}

/** The hosts a property's web streams measure. */
async function hostsOf(property: string, token: string, deps: GoogleDeps): Promise<string[]> {
  const { dataStreams = [] } = await ask<{
    dataStreams?: { type?: string; webStreamData?: { defaultUri?: string } }[];
  }>(`${ADMIN}/${property}/dataStreams?pageSize=200`, token, deps);
  const hosts = dataStreams
    .filter((stream) => stream.type === "WEB_DATA_STREAM")
    .map((stream) => websiteDomain(stream.webStreamData?.defaultUri ?? null))
    .filter((host) => host !== null);
  return [...new Set(hosts)];
}

/** The properties an access token reaches, each with the hosts it measures. */
export async function listProperties(
  token: string,
  deps: GoogleDeps = {},
): Promise<AnalyticsProperty[]> {
  const found: { id: string; label: string }[] = [];
  let pageToken = "";
  for (let page = 0; page < MOST_ACCOUNT_PAGES; page++) {
    const query = new URLSearchParams({ pageSize: "200", ...(pageToken ? { pageToken } : {}) });
    const answered = await ask<{
      accountSummaries?: { propertySummaries?: { property?: string; displayName?: string }[] }[];
      nextPageToken?: string;
    }>(`${ADMIN}/accountSummaries?${query}`, token, deps);
    for (const account of answered.accountSummaries ?? []) {
      for (const summary of account.propertySummaries ?? []) {
        if (typeof summary.property === "string") {
          found.push({ id: summary.property, label: summary.displayName ?? summary.property });
        }
      }
    }
    if (!answered.nextPageToken) break;
    pageToken = answered.nextPageToken;
  }
  const properties: AnalyticsProperty[] = [];
  for (const { id, label } of found.slice(0, MOST_PROPERTIES)) {
    properties.push({ id, label, hosts: await hostsOf(id, token, deps) });
  }
  return properties;
}

/** `20261027`, as a report writes a day, as `2026-10-27`. */
const dayFrom = (date: string) => `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

/**
 * The page a session landed on, as it is kept: from its first slash, without a query and cut to the
 * line's length. Empty where Google names none, such as `(not set)`, so it is counted under no page.
 */
function pathFrom(page: string | undefined): string {
  if (!page?.startsWith("/")) return "";
  return (page.split("?")[0] ?? "").slice(0, LONGEST_PATH);
}

/**
 * How many sessions each assistant sent to each page of a property on each of the days given, by the
 * property's own days. The report is asked for assistants' sources alone, and `assistantOfSource`
 * still decides each row, since the filter can only say a source contains a name.
 */
export async function readSessions(
  token: string,
  property: string,
  days: ReportDays,
  deps: GoogleDeps = {},
): Promise<AnalyticsVisitCount[]> {
  const counts = new Map<string, AnalyticsVisitCount>();
  for (let page = 0; page < MOST_REPORT_PAGES; page++) {
    const offset = page * REPORT_PAGE;
    const answered = await ask<{
      rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
      rowCount?: number;
    }>(`${DATA}/${property}:runReport`, token, deps, {
      method: "POST",
      body: JSON.stringify({
        dateRanges: [{ startDate: days.from, endDate: days.to }],
        dimensions: [{ name: "date" }, { name: "sessionSource" }, { name: "landingPage" }],
        metrics: [{ name: "sessions" }],
        dimensionFilter: {
          orGroup: {
            expressions: ANALYTICS_REPORT_SOURCES.map((value) => ({
              filter: {
                fieldName: "sessionSource",
                stringFilter: { matchType: "CONTAINS", value },
              },
            })),
          },
        },
        limit: String(REPORT_PAGE),
        offset: String(offset),
      }),
    });
    for (const row of answered.rows ?? []) {
      const [date, source, landed] = row.dimensionValues ?? [];
      const assistant = assistantOfSource(source?.value ?? "");
      const sessions = Number(row.metricValues?.[0]?.value);
      if (!assistant || !date?.value || !(sessions > 0)) continue;
      const day = dayFrom(date.value);
      const path = pathFrom(landed?.value);
      const key = `${day}|${assistant}|${path}`;
      const soFar = counts.get(key);
      counts.set(key, { day, assistant, path, count: (soFar?.count ?? 0) + sessions });
    }
    if (offset + REPORT_PAGE >= (answered.rowCount ?? 0)) break;
  }
  return [...counts.values()];
}
