const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatDate(iso: string): string {
  return dateTime.format(new Date(iso));
}

/** The site name to show for a cited page, or null when the URL is not a web link. */
export function sourceLabel(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * How often a location is scanned, in words. The organization's plan sets the pace; a location
 * set to weekly asks for less than that, never more.
 */
export function cadence(planDays: number, frequency: "off" | "weekly" | "daily"): string {
  const days = Math.max(planDays, frequency === "weekly" ? 7 : 1);
  if (days === 1) return "daily";
  if (days === 7) return "weekly";
  return `every ${days} days`;
}

/** "A", "A and B", "A, B and C". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
