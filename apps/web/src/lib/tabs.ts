import type { ActionPlanStep } from "@nearcited/shared";

export const TABS = [
  "overview",
  "actions",
  "prompts",
  "sources",
  "website",
  "answers",
  "settings",
] as const;
export type Tab = (typeof TABS)[number];

export const TAB_LABELS: Record<Tab, string> = {
  overview: "Overview",
  actions: "Actions",
  prompts: "Prompts",
  sources: "Sources",
  website: "Website",
  answers: "Answers",
  settings: "Settings",
};

/**
 * The tabs a location shows. Actions is there only once the location has one: until something
 * is connected there is nothing it could hold.
 */
export function tabsFor(hasActions: boolean): Tab[] {
  return TABS.filter((tab) => tab !== "actions" || hasActions);
}

/** The tab named in the address, or the first one when it names none that is shown. */
export function tabFrom(value: string | null, tabs: readonly Tab[] = TABS): Tab {
  return tabs.find((tab) => tab === value) ?? "overview";
}

/** The tab reached with the arrow keys, wrapping at either end. */
export function neighbour(tab: Tab, step: 1 | -1, tabs: readonly Tab[] = TABS): Tab {
  const index = (tabs.indexOf(tab) + step + tabs.length) % tabs.length;
  return tabs[index] ?? tab;
}

/** What kind of step each action is, and the tab where its evidence is set out. */
export const STEP_PLACE: Record<ActionPlanStep["id"], { kind: string; tab: Tab; link: string }> = {
  fix_website: { kind: "Website", tab: "website", link: "Open website checks" },
  get_listed: { kind: "Listings", tab: "sources", link: "See sources" },
  keep_listings: { kind: "Listings", tab: "sources", link: "See sources" },
  competitors: { kind: "Competitors", tab: "answers", link: "Read the answers" },
};
