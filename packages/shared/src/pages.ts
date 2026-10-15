import { hostOf } from "./analysis";
import { formatPhone } from "./inputs";
import type {
  Draft,
  DraftKind,
  Location,
  PageTask,
  PromptCount,
  PromptPage,
  Recommendation,
  TrackedQuery,
} from "./schemas";
import { SURFACES_BY_KIND, type Surface } from "./schemas";

/**
 * Pages that answer a prompt (issue #140).
 *
 * An assistant names whoever its sources name. Where no answer to one of a location's prompts
 * named the business, a page on its own site that answers that prompt in plain words is something
 * of the business's an assistant could read for it. That is a task, raised and cleared by rule
 * like every other. The copy for the page is a draft (`page`), and is the one part a model writes.
 *
 * Nothing says the page caused anything. The task sets side by side how many answers to the
 * prompt named the business before it was marked done and since, and, once somebody says where
 * the page is, how many of those since cited it.
 */

const PAGE_RULE = "page:";

/** The rule for a page that answers the prompt `queryId`. */
export const pageRule = (queryId: string): string => `${PAGE_RULE}${queryId}`;

/** The prompt a recommendation asks a page for, or null when its rule is not about one. */
export function promptOfRule(rule: string): string | null {
  return rule.startsWith(PAGE_RULE) ? rule.slice(PAGE_RULE.length) || null : null;
}

/** Fewer answers to a prompt than this say too little to call it one the business is left out of. */
export const MIN_ANSWERS_FOR_PAGE = 4;

/** The most a page's address may run to. The database holds to the same number. */
export const PAGE_URL_MAX = 500;

const ASSISTANTS: readonly Surface[] = SURFACES_BY_KIND.ai_prompt;

interface PromptResult {
  tracked_query_id?: string;
  surface: Surface;
  mentioned: boolean;
  cited_urls?: readonly string[];
}

/** The answers assistants gave to one prompt. */
const answersTo = <T extends PromptResult>(results: readonly T[], queryId: string): T[] =>
  results.filter(
    (result) => result.tracked_query_id === queryId && ASSISTANTS.includes(result.surface),
  );

/**
 * The prompts that want a page: each active assistant prompt with at least
 * `MIN_ANSWERS_FOR_PAGE` answers in `results`, none of which named the business, for a location
 * with a website to put the page on. With how many answers each was.
 */
export function promptsLeftOut(
  website: string | null,
  queries: readonly Pick<TrackedQuery, "id" | "kind" | "text" | "is_active">[],
  results: readonly PromptResult[],
): { query: Pick<TrackedQuery, "id" | "text">; answers: number }[] {
  if (!hostOf(website)) return [];
  return queries
    .filter((query) => query.is_active && query.kind === "ai_prompt")
    .map((query) => ({ query, answers: answersTo(results, query.id) }))
    .filter(
      ({ answers }) =>
        answers.length >= MIN_ANSWERS_FOR_PAGE && answers.every((answer) => !answer.mentioned),
    )
    .map(({ query, answers }) => ({ query, answers: answers.length }));
}

/** The title of the task for a page that answers `prompt`. */
export const pageTaskTitle = (prompt: string): string => `Publish a page that answers “${prompt}”`;

/**
 * An address as it is compared: host without `www.` and in lower case, then the path without a
 * slash at its end. What follows `?` or `#` is not part of which page it is.
 */
function pageKey(url: string): string | null {
  try {
    const address = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    const host = address.hostname.toLowerCase().replace(/^www\./, "");
    return `${host}${address.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Whether an answer that cited `urls` cited the page at `page`. */
export function citesPage(urls: readonly string[], page: string): boolean {
  const key = pageKey(page);
  return key !== null && urls.some((url) => pageKey(url) === key);
}

/** Of the answers to a prompt, how many named the business and how many cited its page. */
export function promptCount(
  results: readonly PromptResult[],
  queryId: string,
  page: string | null,
): PromptCount {
  const answers = answersTo(results, queryId);
  return {
    answers: answers.length,
    named: answers.filter((answer) => answer.mentioned).length,
    cited:
      page === null
        ? null
        : answers.filter((answer) => citesPage(answer.cited_urls ?? [], page)).length,
  };
}

/** The answers to a page's prompt before its task was marked done, and since. */
export interface PageEvidence {
  before: readonly PromptResult[];
  since: readonly PromptResult[];
}

export interface PageTaskInput {
  name: string;
  recommendations: readonly Recommendation[];
  queries: readonly Pick<TrackedQuery, "id" | "text">[];
  /** The results of the scan window. */
  results: readonly PromptResult[];
  /** By recommendation ID, for each one marked done. */
  evidence: ReadonlyMap<string, PageEvidence>;
  drafts: readonly Draft[];
  pages: readonly PromptPage[];
  /** Whether a page's copy can be written where this is asked. Left out, it can. */
  writes?: (kind: DraftKind) => boolean;
}

/** Done tasks whose prompt has since been named are kept in view while they are few. */
const MAX_CLOSED_PAGES = 3;

/**
 * The page tasks to show: one for each prompt that wants a page now, in the order the prompts
 * were added, then the few most recently done whose prompt has since been named. A dismissed
 * recommendation, and one whose prompt is gone, has none.
 */
export function buildPageTasks(input: PageTaskInput): PageTask[] {
  const writes = input.writes ?? (() => true);
  const tasks: PageTask[] = [];
  for (const recommendation of input.recommendations) {
    const queryId = promptOfRule(recommendation.rule);
    const query = queryId && input.queries.find((candidate) => candidate.id === queryId);
    if (!queryId || !query || recommendation.status === "dismissed") continue;
    const open = recommendation.status === "open";
    if (!open && !recommendation.acted_at) continue;

    const page = input.pages.find((kept) => kept.recommendation_id === recommendation.id) ?? null;
    const now = answersTo(input.results, queryId);
    const named = now.filter((answer) => answer.mentioned).length;
    const evidence = recommendation.acted_at ? input.evidence.get(recommendation.id) : undefined;
    tasks.push({
      id: recommendation.id,
      tracked_query_id: queryId,
      prompt: query.text,
      title: pageTaskTitle(query.text),
      summary: open
        ? `None of the ${now.length} assistant answers to this prompt in the latest scans named ${input.name}.`
        : named > 0
          ? `${named} of the ${now.length} assistant answers to this prompt in the latest scans named ${input.name}.`
          : `This prompt is no longer one the latest scans left ${input.name} out of.`,
      open,
      acted_at: recommendation.acted_at,
      acted_by_action: recommendation.acted_by_action,
      before: evidence ? promptCount(evidence.before, queryId, page?.url ?? null) : null,
      since: evidence ? promptCount(evidence.since, queryId, page?.url ?? null) : null,
      // A page's copy is asked for while the work is still to do. One written stays to be read.
      draft_kind: open && writes("page") ? "page" : null,
      draft: input.drafts.find((draft) => draft.recommendation_id === recommendation.id) ?? null,
      page,
    });
  }
  const order = (task: PageTask) =>
    input.queries.findIndex((query) => query.id === task.tracked_query_id);
  const current = tasks.filter((task) => task.open).sort((a, b) => order(a) - order(b));
  const closed = tasks
    .filter((task) => !task.open)
    .sort((a, b) => Date.parse(b.acted_at ?? "") - Date.parse(a.acted_at ?? ""))
    .slice(0, MAX_CLOSED_PAGES);
  return [...current, ...closed];
}

/** What a page task gives a draft to be written for: the prompt, on the business's own site. */
export function pageDraftSubject(
  task: Pick<PageTask, "id" | "draft_kind" | "prompt">,
  website: string | null,
): { id: string; draft_kind: DraftKind | null; host: string; url: null; prompt: string } {
  return {
    id: task.id,
    draft_kind: task.draft_kind,
    host: hostOf(website) ?? "",
    url: null,
    prompt: task.prompt,
  };
}

/** A page's copy in its parts: the title on its first line, and the page under it. */
export interface PageParts {
  title: string;
  /** The page, in blocks: a heading, or a paragraph. */
  blocks: { heading: boolean; text: string }[];
}

/**
 * Reads a page's copy. Its first line that is not blank is the title, with any `#` it was given
 * taken off. Under it, a blank line ends a block, and a block whose first line starts `## ` is a
 * heading. Lines inside a paragraph are joined with a space.
 */
export function pageParts(text: string): PageParts {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  const title = first === -1 ? "" : (lines[first] ?? "").replace(/^#+\s*/, "").trim();
  const blocks: PageParts["blocks"] = [];
  for (const block of lines
    .slice(first + 1)
    .join("\n")
    .split(/\n\s*\n/)) {
    const joined = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join(" ");
    if (joined === "") continue;
    const heading = /^#{1,6}\s+/.test(joined);
    blocks.push({ heading, text: heading ? joined.replace(/^#{1,6}\s+/, "") : joined });
  }
  return { title, blocks };
}

/** The most an address made from a title runs to. */
const LONGEST_SLUG = 60;

/**
 * The path a page is published at, made from its title: small letters and digits, a hyphen for
 * anything else, and cut at a hyphen to at most sixty characters. "page" where nothing is left.
 */
export function pageSlug(title: string): string {
  const words = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "");
  let slug = "";
  for (const word of words) {
    const next = slug === "" ? word : `${slug}-${word}`;
    if (next.length > LONGEST_SLUG) break;
    slug = next;
  }
  return slug === "" ? (words[0]?.slice(0, LONGEST_SLUG) ?? "page") : slug;
}

/**
 * The line that ends every page, composed by rule from what the location holds: its name, its
 * address and its phone number, each only where it is on file. No model writes it.
 */
export function pageClosing(
  location: Pick<
    Location,
    "name" | "address_line" | "city" | "region" | "postal_code" | "phone" | "country_code"
  >,
): string {
  const place = [
    location.address_line,
    location.city,
    [location.region, location.postal_code].filter(Boolean).join(" "),
  ]
    .map((part) => part?.trim())
    .filter((part) => part)
    .join(", ");
  // As it is written where the business is, "(919) 555-0100", not as it is stored.
  const phone = location.phone?.trim()
    ? formatPhone(location.phone.trim(), location.country_code)
    : "";
  const call = phone ? ` Call ${phone}.` : "";
  return `${location.name.trim()}${place ? `, ${place}` : ""}.${call}`;
}

/** The whole page as an owner copies it: the title, the page, and the closing line. */
export function pageToCopy(text: string, closing: string): string {
  const { title, blocks } = pageParts(text);
  return [title, ...blocks.map((block) => block.text), closing].join("\n\n");
}

/** An address as it is kept, or the sentence that says why it was not taken. */
export type ReadPageAddress = { url: string } | { problem: string };

/**
 * Reads what a member pasted as where a page is. It has to be a page of the business's own
 * website, the site or a subdomain of it, and not its front page. It is kept as the address a
 * browser would follow, without the part after `#`.
 */
export function readPageAddress(website: string | null, pasted: string): ReadPageAddress {
  const own = hostOf(website);
  const whole = { problem: "Paste the whole address of the page, starting with https://." };
  if (!own) return { problem: "Add the website for this location first, under Settings." };
  const text = pasted.trim();
  let address: URL;
  try {
    address = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return whole;
  }
  if (address.protocol === "http:") address.protocol = "https:";
  if (address.protocol !== "https:" || address.username !== "" || address.password !== "") {
    return whole;
  }
  const host = address.hostname.replace(/^www\./, "");
  if (host !== own && !host.endsWith(`.${own}`)) {
    return {
      problem: `That address is not on ${own}. Paste the address of the page on your site.`,
    };
  }
  if (address.pathname.replace(/\/+$/, "") === "" && address.search === "") {
    return { problem: "That is your home page. Paste the address of the page you published." };
  }
  address.hash = "";
  if (address.href.length > PAGE_URL_MAX) {
    return { problem: `Paste an address of ${PAGE_URL_MAX} characters or fewer.` };
  }
  return { url: address.href };
}

/** Text made safe to stand in a page's HTML. */
const asText = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * A page's copy as WordPress blocks: each heading and paragraph a block of its own, and the
 * closing line last, where there is one. Everything is written as text, so nothing in the copy,
 * whoever wrote or changed it, becomes markup on the business's site. The title is the page's own
 * and is not here.
 */
export function pageBlocks(text: string, closing: string | null): string {
  const { blocks } = pageParts(text);
  const paragraph = (words: string) =>
    `<!-- wp:paragraph -->\n<p>${asText(words)}</p>\n<!-- /wp:paragraph -->`;
  return [
    ...blocks.map((block) =>
      block.heading
        ? `<!-- wp:heading -->\n<h2 class="wp-block-heading">${asText(block.text)}</h2>\n<!-- /wp:heading -->`
        : paragraph(block.text),
    ),
    ...(closing === null ? [] : [paragraph(closing)]),
  ].join("\n\n");
}

/**
 * What a page says, as it is compared: its words without the markup around them, with the
 * entities read and the spaces between them made one. Two pages that say the same thing compare
 * equal whatever WordPress did to how the HTML was written.
 */
export function pageWords(raw: string): string {
  // Comments first, by hand: a pattern for "anything up to the end of the comment" is tried again
  // from every opening of one that never ends, which takes the square of the length.
  let text = "";
  let at = 0;
  while (at < raw.length) {
    const open = raw.indexOf("<!--", at);
    if (open === -1) break;
    text += `${raw.slice(at, open)} `;
    const close = raw.indexOf("-->", open + 4);
    at = close === -1 ? raw.length : close + 3;
  }
  text += raw.slice(at);
  return text
    .replace(/<[^>]*>/g, " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&#8217;", "\u2019")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();
}
