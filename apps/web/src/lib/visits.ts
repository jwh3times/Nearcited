import { type Allowances, type Plan, VISITS_ALLOWANCE, type VisitLine } from "@nearcited/shared";

/** The cache key of a location's line. */
export const lineKey = (locationId: string) => ["line", locationId] as const;

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
