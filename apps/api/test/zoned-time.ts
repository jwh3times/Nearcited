import { addDays } from "@nearcited/shared";

/**
 * Times of day on a location's clock, for the in-memory store to mirror what the database works
 * out with `at time zone`: when a review request is due, and when it lapses.
 */

/** What the clock in `zone` shows at `instant`, as a UTC timestamp of the same figures. */
function wallClock(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
}

/** The instant at which the clock in `zone` shows `time` (`HH:MM`) on `day` (`YYYY-MM-DD`). */
export function atLocalTime(day: string, time: string, zone: string): string {
  const wall = Date.parse(`${day}T${time}:00.000Z`);
  // The zone's offset at the first guess, then again at the answer, in case a change of clocks
  // falls between them.
  const guess = wall - (wallClock(wall, zone) - wall);
  return new Date(wall - (wallClock(guess, zone) - guess)).toISOString();
}

/** The day and the time of day the clock in `zone` shows at `instant`. */
function localParts(instant: string, zone: string): { day: string; time: string } {
  const shown = new Date(wallClock(Date.parse(instant), zone)).toISOString();
  return { day: shown.slice(0, 10), time: shown.slice(11, 16) };
}

/**
 * Mirrors next_same_time(): `notBefore` itself, or, from later than it, the first moment from then
 * at which the clock in `zone` shows the time of day `notBefore` does.
 */
export function nextSameTime(notBefore: string, from: string, zone: string): string {
  if (Date.parse(from) <= Date.parse(notBefore)) return new Date(notBefore).toISOString();
  const { time } = localParts(notBefore, zone);
  const { day } = localParts(from, zone);
  const candidate = atLocalTime(day, time, zone);
  return Date.parse(candidate) < Date.parse(from)
    ? atLocalTime(addDays(day, 1), time, zone)
    : candidate;
}
