import { type AnalyticsSource, type LocationVisits, VISITS_SHOWN_DAYS } from "@nearcited/shared";
import { type VisitsShown, visitsShown } from "./visits";

/** The cache key of a location's sessions from assistants, added up. */
export const analyticsVisitsKey = (locationId: string) => ["analytics-visits", locationId] as const;

/** How many, with the word for them: "1 session", "12 sessions". */
const sessionsOf = (count: number) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? "session" : "sessions"}`;

/**
 * Whether a location's page has a section for Google Analytics. Where nothing is connected and
 * nothing was counted there is nothing to say, and the page looks as it does with only the line.
 */
export function analyticsVisible(source: AnalyticsSource, total: number): boolean {
  if (total > 0) return true;
  return !["not_connected", "not_on_plan", "sample"].includes(source.state);
}

export const ANALYTICS_WORDS = {
  lineHeading: "From the line on your site",
  heading: "From Google Analytics",
  none: `Google Analytics reported no session from an assistant in the last ${VISITS_SHOWN_DAYS} days.`,
  some: (total: number) =>
    `Google Analytics reported ${sessionsOf(total)} from assistants in the last ${VISITS_SHOWN_DAYS} days`,
  notMatched:
    "None of the properties your Google Analytics sign-in reaches measures this location's website. Check the website under Settings, and the web stream in Analytics.",
  noWebsite:
    "There is no website on file for this location. Sessions are counted only for the website on file, so add it first.",
  waiting: "Reading the last days from Google Analytics now. This fills in once that is done.",
  broken:
    "The Google Analytics connection is not working, so nothing new is read. What was read is below.",
  brokenUnread: "The Google Analytics connection is not working, so nothing is read from it.",
  elsewhere: (property: string, name: string) =>
    `${property} is matched to ${name}, so this website's sessions are counted on that location's page.`,
  notConnected: "Google Analytics is no longer connected. What was counted while it was is below.",
  notOnPlan: "Your plan no longer counts visits. What was counted while it did is below.",
  sample: "These are sample counts, made up. Nothing was read from Google Analytics.",
  whyTheyDiffer:
    "These two counts will not agree, and they are not added together. Google Analytics misses visitors who decline its cookies, and the line misses visitors whose browser does not say where they came from.",
  floor:
    "Read the count as at least this many. A session is counted only where it says where it came from. Google's AI Overviews and AI Mode, and Copilot inside Bing, arrive as any search does and cannot be told apart. An assistant's app may say nothing of where a visitor came from.",
  worked:
    "This is what your Google Analytics property reported, for the whole property: one that measures more than one website counts them together. Google revises its recent figures, so the last three days are read again each day, and nothing else here is worked out from the count.",
  otherPages: "Other pages",
  otherPagesAbout:
    "Sessions on pages past the fiftieth of their day, and those Google names no page for, are counted together.",
  days: "A day here is a day in your property's own time zone.",
} as const;

/** What the section says of where its numbers come from, or null where there is nothing to add. */
export function analyticsNote(source: AnalyticsSource): string | null {
  switch (source.state) {
    case "counted":
      return source.broken ? ANALYTICS_WORDS.broken : null;
    case "elsewhere":
      return ANALYTICS_WORDS.elsewhere(source.property, source.location_name);
    case "sample":
      return ANALYTICS_WORDS.sample;
    case "not_on_plan":
      return ANALYTICS_WORDS.notOnPlan;
    case "not_connected":
      return ANALYTICS_WORDS.notConnected;
    case "no_website":
      return ANALYTICS_WORDS.noWebsite;
    case "broken":
      return ANALYTICS_WORDS.brokenUnread;
    case "not_matched":
      return ANALYTICS_WORDS.notMatched;
    case "waiting":
      return ANALYTICS_WORDS.waiting;
  }
}

/** The section's opening line. Names the property where one is matched. */
export function analyticsLede(source: AnalyticsSource, total: number): string {
  if (total === 0) return ANALYTICS_WORDS.none;
  const on = source.state === "counted" ? `, on ${source.property}` : "";
  return `${ANALYTICS_WORDS.some(total)}${on}.`;
}

/**
 * A location's sessions as the section lays them out, the way the line's are. The line stops
 * counting at a ceiling and says so on a day that reached it. Google's figures have no such ceiling.
 */
export function analyticsShown(visits: Pick<LocationVisits, "days">): VisitsShown {
  const shown = visitsShown(visits);
  return { ...shown, days: shown.days.map((day) => ({ ...day, full: false })) };
}

/** Why the two counts differ, where both have any to compare. They are never added together. */
export const sourcesDiffer = (lineTotal: number, analyticsTotal: number): string | null =>
  lineTotal > 0 && analyticsTotal > 0 ? ANALYTICS_WORDS.whyTheyDiffer : null;
