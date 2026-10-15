import { type CitedCount, type DetailsFix, MIN_ANSWERS_SINCE } from "@nearcited/shared";

const answers = (count: number) => (count === 1 ? "1 answer" : `${count} answers`);
const cited = ({ cited, answers: of }: CitedCount) =>
  `${cited} of ${answers(of)} cited your website`;

/**
 * What the scans saw before the structured details were marked as on the page, and since. Null
 * until they are marked. The two are set side by side and nothing more: neither line says the
 * block caused anything.
 */
export function detailsProof(fix: Pick<DetailsFix, "before" | "since">): {
  before: string;
  since: string;
} | null {
  if (!fix.before || !fix.since) return null;
  return {
    before:
      fix.before.answers === 0
        ? "Before: no answer had come in yet."
        : `Before: ${cited(fix.before)}.`,
    since:
      fix.since.answers < MIN_ANSWERS_SINCE
        ? `Since: too early to say. ${fix.since.answers === 0 ? "No answer has" : "Only 1 answer has"} come in yet.`
        : `Since: ${cited(fix.since)}.`,
  };
}

/**
 * Where the fix stands, in a line: when it was marked done, and what the scan since found on the
 * page. Null until it is marked. `missing` is whether the latest check found no structured
 * details there. `day` writes a date the way the page does.
 */
export function detailsStatus(
  fix: Pick<DetailsFix, "acted_at" | "acted_by_action" | "checked_since">,
  missing: boolean,
  day: (iso: string) => string,
): string | null {
  if (!fix.acted_at) return null;
  const marked = fix.acted_by_action
    ? `Added to your home page by Nearcited on ${day(fix.acted_at)}.`
    : `Marked done ${day(fix.acted_at)}.`;
  if (!fix.checked_since) return missing ? `${marked} The next scan will look for it.` : marked;
  if (!missing) return `${marked} The scan since found it on the page.`;
  // Nearcited saved it in the page, so what keeps it from being seen is how the page is shown.
  return fix.acted_by_action
    ? `${marked} The scan since did not find it on the page. A page builder such as Elementor, or a caching plugin, may be keeping it from showing. You can take it back on the Actions tab.`
    : `${marked} The scan since did not find it on the page.`;
}
