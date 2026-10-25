/**
 * What a site's robots.txt allows, read as RFC 9309 says a crawler reads it. Pure, so it is tested
 * without a network: the Worker fetches robots.txt, and this decides what it allows.
 *
 * NearcitedBot obeys the group that names it everywhere. On a site that is not the business's own
 * it follows the `*` group when none names it, as any crawler does. On the business's own site,
 * which its owner asked to have checked, a `*` group does not stop it: the on-page check is what
 * reports that the assistants' crawlers are shut out (docs/adr/0027).
 */

/** The product token NearcitedBot's rules are addressed to. */
export const NEARCITED_BOT = "NearcitedBot";

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsGroup {
  /** The user agents the group is for, lowercased. */
  agents: string[];
  rules: RobotsRule[];
}

/**
 * The groups of a robots.txt, in order. Agent lines in a row share one group, and an agent line
 * after a rule starts the next. A rule before any agent line belongs to nobody.
 */
export function robotsGroups(robotsTxt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const hash = raw.indexOf("#");
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      // The product token alone: "NearcitedBot/1.0" is addressed to NearcitedBot.
      current.agents.push(value.split(/[/\s]/)[0]?.toLowerCase() ?? "");
    } else if ((field === "allow" || field === "disallow") && current) {
      current.rules.push({ allow: field === "allow", path: value });
    }
  }
  return groups;
}

/** Every rule addressed to an agent, from every group that names it. */
export function rulesFor(groups: readonly RobotsGroup[], agent: string): RobotsRule[] | null {
  const named = groups.filter((group) => group.agents.includes(agent.toLowerCase()));
  return named.length > 0 ? named.flatMap((group) => group.rules) : null;
}

/**
 * Whether a path matches a rule's pattern: `*` is any run of characters, a final `$` is the end of
 * the path, and otherwise the pattern need only match the start. Matched by position with one
 * step back to the last `*`, never by a regular expression, so a pattern from a site nobody here
 * controls costs at most its length times the path's.
 */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  let p = 0;
  let s = 0;
  let star = -1;
  let resume = 0;
  while (s < path.length) {
    if (p < body.length && body[p] === "*") {
      star = p++;
      resume = s;
    } else if (p < body.length && body[p] === path[s]) {
      p++;
      s++;
    } else if (p === body.length && !anchored) {
      return true;
    } else if (star !== -1) {
      p = star + 1;
      s = ++resume;
    } else {
      return false;
    }
  }
  while (p < body.length && body[p] === "*") p++;
  return p === body.length;
}

/**
 * Whether NearcitedBot may read a path (with its query) under a robots.txt. The longest matching
 * rule wins and an Allow wins a tie; an empty rule matches nothing; robots.txt itself is always
 * allowed.
 */
export function robotsAllows(
  robotsTxt: string,
  path: string,
  { ownSite }: { ownSite: boolean },
): boolean {
  if (path === "/robots.txt") return true;
  const groups = robotsGroups(robotsTxt);
  const rules = rulesFor(groups, NEARCITED_BOT) ?? (ownSite ? null : rulesFor(groups, "*"));
  let best: RobotsRule | null = null;
  for (const rule of rules ?? []) {
    if (!rule.path || !matches(rule.path, path)) continue;
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best?.allow ?? true;
}
