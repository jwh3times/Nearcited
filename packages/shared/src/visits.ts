import { VISIT_ASSISTANTS, type VisitAssistant } from "./schemas";

/**
 * Visits from assistants (`docs/adr/0017-a-visit-is-counted-for-whoever-holds-the-site-key.md`).
 *
 * A business's owner pastes one line into their site. It reports a visit that arrived from an
 * assistant, and nothing about any other visit. What is kept is a count for a day, a location,
 * an assistant and a page.
 */

/** The allowance a plan has when visits are counted for it. It is included or it is not. */
export const VISITS_ALLOWANCE = "visits";

export const VISIT_ASSISTANT_LABELS: Record<VisitAssistant, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  perplexity: "Perplexity",
  copilot: "Copilot",
  claude: "Claude",
};

/** How a visit says which assistant it came from. */
export interface AssistantReferrers {
  /** The sites a visitor's browser names as where it came from. A subdomain counts as its site. */
  hosts: readonly string[];
  /** What the assistant itself adds to the address it sends a visitor to, as `utm_source`. */
  tags: readonly string[];
}

/**
 * What a visit from each assistant carries. An assistant is here only when its visits can be told
 * from a search: Google's AI Overviews and AI Mode arrive from google.com as any search does, and
 * Copilot's answers inside Bing from bing.com, so neither is listed and neither is counted.
 *
 * Read on 2026-10-13 from published accounts of what each assistant sends. Nobody here followed a
 * link out of each one to see, so a host that is wrong counts nothing and says nothing.
 *
 * The line a site carries has its own copy (`apps/web/public/line.js`), kept the same by a test.
 * The database names the assistants too (`visits.assistant`, `record_visit()`,
 * `analytics_visits.assistant` and `record_analytics_visits()`): add one in all six.
 */
export const ASSISTANT_REFERRERS: Record<VisitAssistant, AssistantReferrers> = {
  // ChatGPT tags the links in its answers, and its apps often name no site they came from.
  chatgpt: { hosts: ["chatgpt.com", "chat.openai.com"], tags: ["chatgpt.com"] },
  gemini: { hosts: ["gemini.google.com"], tags: [] },
  perplexity: { hosts: ["perplexity.ai"], tags: [] },
  copilot: { hosts: ["copilot.microsoft.com"], tags: [] },
  claude: { hosts: ["claude.ai"], tags: [] },
};

/** The most visits counted for a location in a day. `record_visit()` holds the same number. */
export const MOST_VISITS_A_DAY = 1000;
/**
 * The most pages a location's visits are counted under in a day. The visits to any page past
 * these are counted together. `record_visit()` and `record_analytics_visits()` hold the same number.
 */
export const MOST_PAGES_A_DAY = 50;
/** How much of a page's path is kept. `record_visit()` and `record_analytics_visits()` hold the same number. */
export const LONGEST_PATH = 200;

/** How many days of visits a location's page adds up, today included. */
export const VISITS_SHOWN_DAYS = 30;
/** How many pages a location's page lists. `location_visits()` holds the same number. */
export const PAGES_SHOWN = 10;

/**
 * What an owner's own visit carries after the `#` of the address when it is a check that the line
 * is there. Such a visit is noted as a check and never counted.
 */
export const LINE_CHECK = "nearcited-check";

/**
 * The line an owner pastes into their site, for a location's key. `app` is where the product is
 * served, which is where the site's visitors fetch the script from and where it reports to.
 */
export function lineToPaste(app: string, key: string): string {
  // The script is at the root of where the product is served, whatever else `app` holds.
  return `<script async src="${new URL("/line.js", app)}" data-site="${key}"></script>`;
}

/**
 * The address an owner opens to see that the line is on their site: the website on file, marked
 * as a check. Null where what is on file is not an address.
 */
export function checkAddress(website: string | null): string | null {
  if (!website) return null;
  try {
    const address = new URL(website);
    address.hash = LINE_CHECK;
    return address.toString();
  } catch {
    return null;
  }
}

const tidy = (value: string | null) => value?.trim().toLowerCase() || null;

/**
 * The assistant a visit came from, or null when it does not say.
 *
 * Where the visitor's browser names a site, that site decides: a tag on the address is not
 * believed over it, since a tagged link that somebody copied and posted elsewhere arrives from
 * elsewhere. A tag counts only where no site is named at all, which is how a visit out of an
 * assistant's app arrives.
 */
export function assistantOf(sent: {
  referrer: string | null;
  tag: string | null;
}): VisitAssistant | null {
  const referrer = tidy(sent.referrer)?.replace(/\.$/, "");
  if (referrer) {
    return (
      VISIT_ASSISTANTS.find((assistant) =>
        ASSISTANT_REFERRERS[assistant].hosts.some(
          (host) => referrer === host || referrer.endsWith(`.${host}`),
        ),
      ) ?? null
    );
  }
  const tag = tidy(sent.tag);
  if (!tag) return null;
  return (
    VISIT_ASSISTANTS.find((assistant) => ASSISTANT_REFERRERS[assistant].tags.includes(tag)) ?? null
  );
}
