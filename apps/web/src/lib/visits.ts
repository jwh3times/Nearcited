import {
  type Allowances,
  type LocationVisits,
  MOST_VISITS_A_DAY,
  type Plan,
  VISIT_ASSISTANT_LABELS,
  VISITS_ALLOWANCE,
  VISITS_SHOWN_DAYS,
  type VisitLine,
} from "@nearcited/shared";

/** The cache key of a location's line. */
export const lineKey = (locationId: string) => ["line", locationId] as const;

/** The cache key of a location's visits, added up. */
export const visitsKey = (locationId: string) => ["visits", locationId] as const;

/** How often the page asks whether the line has answered, once its owner has gone to look. */
export const LOOKING_MS = 3000;
/** How long it goes on asking. The site answers within a second or two of being opened. */
export const LOOKING_FOR_MS = 120_000;

/**
 * Where an organization stands with having its visits counted: its plan includes it, another
 * plan does, or nothing on sale does, in which case nothing is said of it.
 */
export function visitsOffer(
  allowances: Allowances | undefined,
  plans: readonly Pick<Plan, "allowances">[] | undefined,
): "included" | "on_another_plan" | "nowhere" {
  if (allowances?.[VISITS_ALLOWANCE] !== undefined) return "included";
  return plans?.some((plan) => plan.allowances[VISITS_ALLOWANCE] !== undefined)
    ? "on_another_plan"
    : "nowhere";
}

const dayName = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

/** A day as the database keeps one, which is a day in UTC, in words. */
export const formatDay = (day: string) => dayName.format(new Date(`${day}T00:00:00Z`));

/** What the page says of whether the line has been seen on the location's own site. */
export function lineStanding(line: Pick<VisitLine, "checked_on">): string {
  return line.checked_on
    ? `The line answered from your site on ${formatDay(line.checked_on)}.`
    : "The line has not answered from your site yet.";
}

export const LINE_WORDS = {
  title: "Visits from assistants",
  about:
    "Paste one line into your website and it counts the visitors who arrive from an AI assistant such as ChatGPT. It reports nothing about any other visitor, sets no cookie, and keeps nothing about anyone: only how many came, on which day, from which assistant, to which page.",
  copy: "Copy the line",
  see: "See the line",
  where:
    "It goes in your site's header code, so that every page carries it. If someone else looks after your site, send them the line: they will know where it goes.",
  builders: "Where that is in WordPress, Wix, Squarespace and Shopify",
  check: "Check the line",
  checking:
    "Once the line is on your site, open your site with this link. It tells us the line is there, and counts as no visit.",
  noWebsite:
    "There is no website on file for this location. A visit is counted only on the website on file, so add it first.",
  paused: "This location is not covered by your plan, so its visits are not counted.",
  notOnPlan: "Your plan does not count visits from assistants.",
  replace: "Replace the key",
  replacing:
    "The line carries a key that says the visits are yours. Anyone who reads your site's source can read it and send made-up visits. If the count looks wrong, replace the key: the line on your site then counts nothing until you paste the new one.",
  confirm:
    "Replace the key? The line on your site stops counting until you paste the new one in its place.",
} as const;

/**
 * Where header code goes in the four site builders most small businesses use, in each one's own
 * words for its menus. Read on 2026-10-13 from each builder's help pages: WordPress.com's "Add
 * code to headers", Wix's "Embedding custom code on your site", Squarespace's "Using code
 * injection" and Shopify's "Edit theme code". A builder that renames a menu makes its line here
 * wrong, and nothing notices until somebody reads its help again.
 */
export const BUILDERS: readonly { name: string; where: string }[] = [
  {
    name: "WordPress",
    where:
      "Add the free plugin Insert Headers and Footers by WPCode. Open Code Snippets, then Header & Footer, paste the line into the Header box and save.",
  },
  {
    name: "Wix",
    where:
      "Open Settings, then Custom Code, and choose Add Custom Code. Paste the line, choose All pages and place it in Head. Wix asks that the site is published on its own domain.",
  },
  {
    name: "Squarespace",
    where:
      "Open the Code Injection panel, paste the line into the Header field and save. Not every Squarespace plan has code injection.",
  },
  {
    name: "Shopify",
    where:
      "Open Online Store, then the three-dot menu beside your theme, and choose Edit code. In theme.liquid, paste the line just above </head> and save.",
  },
];

/** An assistant's name, or its key as it came where this build does not know the assistant. */
export const assistantName = (assistant: string): string =>
  (VISIT_ASSISTANT_LABELS as Record<string, string>)[assistant] ?? assistant;

/** How many, with the word for them: "1 visit", "12 visits". */
export const visitsOf = (count: number) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? "visit" : "visits"}`;

/** A location's visits as its page lays them out. */
export interface VisitsShown {
  total: number;
  /** By assistant, the one with the most first. */
  assistants: { assistant: string; name: string; count: number }[];
  /**
   * By day, the newest first, with which assistants a day's visits came from. `full` is true for
   * a day that reached the most counted in a day, which may therefore have had more.
   */
  days: { day: string; count: number; from: string; full: boolean }[];
}

/** Adds a location's visits up the two ways its page shows them. */
export function visitsShown(visits: Pick<LocationVisits, "days">): VisitsShown {
  const byAssistant = new Map<string, number>();
  const byDay = new Map<string, { assistant: string; count: number }[]>();
  for (const { day, assistant, count } of visits.days) {
    byAssistant.set(assistant, (byAssistant.get(assistant) ?? 0) + count);
    byDay.set(day, [...(byDay.get(day) ?? []), { assistant, count }]);
  }
  const most = (a: { assistant: string; count: number }, b: { assistant: string; count: number }) =>
    b.count - a.count || assistantName(a.assistant).localeCompare(assistantName(b.assistant));
  const assistants = [...byAssistant]
    .map(([assistant, count]) => ({ assistant, count }))
    .sort(most)
    .map((row) => ({ ...row, name: assistantName(row.assistant) }));
  const days = [...byDay]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, from]) => {
      const count = from.reduce((sum, row) => sum + row.count, 0);
      return {
        day,
        count,
        from: from
          .sort(most)
          .map((row) => `${assistantName(row.assistant)} ${row.count.toLocaleString("en-US")}`)
          .join(", "),
        full: count >= MOST_VISITS_A_DAY,
      };
    });
  return { total: assistants.reduce((sum, row) => sum + row.count, 0), assistants, days };
}

export const COUNT_WORDS = {
  none: `Your site has reported no visit from an assistant in the last ${VISITS_SHOWN_DAYS} days.`,
  some: (total: number) =>
    `Your site reported ${visitsOf(total)} from assistants in the last ${VISITS_SHOWN_DAYS} days.`,
  floor:
    "Read the count as at least this many. A visit is counted only where it says where it came from. Google's AI Overviews and AI Mode, and Copilot inside Bing, arrive as any search does and cannot be told apart. An assistant's app may say nothing of where a visitor came from, and a browser may block the line.",
  padded:
    "The count is what visitors' browsers reported from your site. Anyone who reads the key in your site's source could send made-up visits, so nothing else here is worked out from it.",
  full: `${MOST_VISITS_A_DAY.toLocaleString("en-US")} is the most counted in a day, so this day may have had more.`,
  otherPages: "Other pages",
  otherPagesAbout: "Visits to pages past the fiftieth of their day are counted together.",
  days: "A day here is a day in UTC.",
} as const;
