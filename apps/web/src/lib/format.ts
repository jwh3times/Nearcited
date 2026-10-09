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

/** An assistant's answer with its Markdown emphasis marks removed, for showing as plain text. */
export function plainText(text: string): string {
  return text.replace(/\*\*|__/g, "");
}

/**
 * What two spellings of one business share: the name without a trailing "LLC", "Inc." and the
 * like, in lower case. Assistants add and drop those from one answer to the next.
 */
export function businessKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s,]+(?:l\.?l\.?c|inc|corp|co|ltd|pllc|p\.?a)\.?$/, "")
    .trim();
}

/** "A", "A and B", "A, B and C". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** US dollars to the cent. An amount too small to show as a cent still shows as something. */
export function formatDollars(amount: number): string {
  return amount > 0 && amount < 0.005 ? "under $0.01" : dollars.format(amount);
}

const monthName = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** "October 2026" for "2026-10". */
export function formatMonth(month: string): string {
  return monthName.format(new Date(`${month}-01T00:00:00Z`));
}
