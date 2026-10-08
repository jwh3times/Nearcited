import type { Action } from "@nearcited/shared";

export const TABS = ["overview", "prompts", "sources", "website", "answers", "settings"] as const;
export type Tab = (typeof TABS)[number];

export const TAB_LABELS: Record<Tab, string> = {
  overview: "Overview",
  prompts: "Prompts",
  sources: "Sources",
  website: "Website",
  answers: "Answers",
  settings: "Settings",
};

/** The tab named in the address, or the first one when it names none. */
export function tabFrom(value: string | null): Tab {
  return TABS.find((tab) => tab === value) ?? "overview";
}

/** The tab reached with the arrow keys, wrapping at either end. */
export function neighbour(tab: Tab, step: 1 | -1): Tab {
  const index = (TABS.indexOf(tab) + step + TABS.length) % TABS.length;
  return TABS[index] ?? tab;
}

/** What kind of step each action is, and the tab where its evidence is set out. */
export const ACTION_PLACE: Record<Action["id"], { kind: string; tab: Tab; link: string }> = {
  fix_website: { kind: "Website", tab: "website", link: "Open website checks" },
  get_listed: { kind: "Listings", tab: "sources", link: "See sources" },
  keep_listings: { kind: "Listings", tab: "sources", link: "See sources" },
  competitors: { kind: "Competitors", tab: "answers", link: "Read the answers" },
};
