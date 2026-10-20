import {
  type Action,
  type ActionKind,
  type ActionMessage,
  buildBusinessBlock,
  type Connection,
  type ConnectionMatch,
  DETAILS_RULE,
  detailsOnPage,
  EDITABLE_ACTION_KINDS,
  type Location,
  pageBlocks,
  pageClosing,
  pageParts,
  pageSlug,
  pageWords,
  promptOfRule,
  type Recommendation,
  underWebsite,
  withDetails,
} from "@nearcited/shared";
import { type Hosting, readWordPressSignIn, SignInRefused } from "../connections";
import { tellIndexNow } from "../connections/hosted";
import { open } from "../connections/seal";
import {
  createPage,
  mayAddScripts,
  readFrontPage,
  readPageAt,
  trashPage,
  type WordPressDeps,
  WordPressRefused,
  writePageContent,
} from "../connections/wordpress";
import type { NewAction, Store } from "../store/types";

/**
 * Actions: what the product does outside itself for a location, once a member said yes
 * (docs/adr/0014-only-the-worker-carries-out-an-action.md).
 *
 * Everything here runs in the worker. It proposes after a sync, and it carries out what was
 * approved, because both need what only the worker can read or write: a connection's sign-in,
 * or, for an answer subdomain, which has none, the hosted pages only the worker writes.
 */

export interface ActionDeps {
  store: Store;
  /** The key this deployment seals with. Null where none is set. */
  key: CryptoKey | null;
  /** How an outside service is reached. The tests put a made-up WordPress here. */
  outside?: WordPressDeps;
  /** Where answer subdomains are served from, and how IndexNow is reached. */
  hosting?: Hosting;
  /**
   * Where a proposal that standing permission approved as it was made is queued to be carried
   * out. Without one the schedule finds it, a quarter of an hour later.
   */
  queue?: Pick<Queue<ActionMessage>, "send">;
}

/**
 * Proposes one action, and queues it to be carried out where standing permission approved it as
 * it was made. True when it was proposed.
 */
async function propose({ store, queue }: ActionDeps, action: NewAction): Promise<boolean> {
  const made = await store.proposeAction(action);
  if (made?.status === "approved" && queue) {
    try {
      await queue.send({ action_id: made.id, step: "carry_out" });
    } catch (error) {
      console.error(`Action ${made.id}: could not queue it, the schedule will`, error);
    }
  }
  return made !== null;
}

/** What a kind of action is given to work with: the account, and what of it is the location's. */
interface Target {
  store: Store;
  connection: Connection;
  match: ConnectionMatch;
  signIn: string;
  outside: WordPressDeps;
  /** The action being carried out. */
  action: Action;
  /** The location it is for. */
  location: Location;
  /** Where answer subdomains are served from, for a kind that tells IndexNow. */
  hosting?: Hosting;
}

/** How one kind of action reads what is there now and makes its change. */
interface ActionHandler {
  /** What is there now, as the text a member would be shown. Null when there is nothing. */
  current(target: Target): Promise<string | null>;
  /**
   * Puts the text there, or takes away what is there where it is null. Says where it put it,
   * for a kind whose work has an address of its own.
   */
  apply(target: Target, text: string | null): Promise<string | undefined>;
  /** Where what the action put there is, for a kind whose work has an address of its own. */
  where?(target: Target): Promise<string | undefined>;
}

/**
 * The sample kind changes the opening line of one of the sample account's listings. The
 * listings exist nowhere but in this product's own table, so nothing leaves it.
 */
const sample: ActionHandler = {
  current: ({ store, connection, match }) => store.getSampleLine(connection.id, match.external_id),
  async apply({ store, connection, match }, text) {
    await store.setSampleLine(connection.id, match.external_id, text);
    return undefined;
  },
};

/** The site's home page, which has to be a page of its own for the block to go on it. */
async function homePage(signIn: string, outside: WordPressDeps) {
  const site = readWordPressSignIn(signIn);
  const page = await readFrontPage(site, outside);
  if (!page) throw new Error("The site's home page is no longer a page of its own.");
  return { site, page };
}

/**
 * The business details block on a WordPress home page. What is there is the product's own block,
 * found between its marks, and the change replaces or takes away that block and touches nothing
 * else on the page. The page is read again just before it is saved, so what the owner wrote
 * since the proposal is kept.
 */
const wordpressDetails: ActionHandler = {
  async current({ signIn, outside }) {
    return detailsOnPage((await homePage(signIn, outside)).page.raw);
  },
  async apply({ signIn, outside }, text) {
    const { site, page } = await homePage(signIn, outside);
    await writePageContent(site, page.id, withDetails(page.raw, text), outside);
    return undefined;
  },
};

/**
 * The copy a page action is about: what it puts there, or, taking one back, what was put there.
 * Its title says the page's address.
 */
const copyOf = (action: Action): string => actionText(action) ?? action.seen?.text ?? "";
const addressOf = (copy: string) => pageSlug(pageParts(copy).title);
/** What stands for a page at the address that is not the one the action is about. */
const SOMEBODY_ELSES = "Another page is at this address.";
/** What stands for an answer subdomain no longer under the location's website. */
const WEBSITE_MOVED = "The website is no longer on this subdomain's domain.";

/**
 * A page task's copy, published as a new page of the WordPress site. What is there is the page at
 * the address the copy's title makes, and it counts as the product's only while it still says
 * what was published there; the closing line is the location's details as they are now. Taking it
 * back moves that page to WordPress's trash. Nothing else on the site is touched.
 */
const wordpressPage: ActionHandler = {
  async current({ signIn, outside, action }) {
    const copy = copyOf(action);
    const page = await readPageAt(readWordPressSignIn(signIn), addressOf(copy), outside);
    if (!page) return null;
    return pageWords(page.raw).startsWith(pageWords(pageBlocks(copy, null)))
      ? copy
      : SOMEBODY_ELSES;
  },
  async apply({ signIn, outside, action, location }, text) {
    const site = readWordPressSignIn(signIn);
    if (text === null) {
      const page = await readPageAt(site, addressOf(copyOf(action)), outside);
      if (page) await trashPage(site, page.id, outside);
      return undefined;
    }
    const made = await createPage(
      site,
      {
        title: pageParts(text).title,
        slug: addressOf(text),
        content: pageBlocks(text, pageClosing(location)),
      },
      outside,
    );
    return made.link;
  },
  async where({ signIn, outside, action }) {
    return (await readPageAt(readWordPressSignIn(signIn), addressOf(copyOf(action)), outside))
      ?.link;
  },
};

/** Where a page is on its connection's answer subdomain. Undefined where it has none. */
async function hostedAddress(store: Store, connectionId: string, slug: string) {
  const kept = await store.getAnswerSubdomain(connectionId);
  return kept
    ? { hostname: kept.hostname, address: `https://${kept.hostname}/${slug}` }
    : undefined;
}

/** Tells IndexNow that a page on an answer subdomain changed, except on sample data. */
async function noticeChange({ store, connection, hosting }: Target, slug: string) {
  if (!hosting || hosting.sampleData) return;
  const where = await hostedAddress(store, connection.id, slug);
  if (where) await tellIndexNow(where.hostname, where.address, hosting);
}

/**
 * A page task's copy, served on the location's answer subdomain. What is there is the page at the
 * address the copy's title makes, which counts as the product's only while it is the copy that was
 * published. Taking it back marks it gone: its address then answers that it was taken down.
 * Either way IndexNow is told, so search engines read the address again.
 */
const hostedPage: ActionHandler = {
  async current({ store, connection, action, location }) {
    // A page is put up only while the subdomain is still under the business's website.
    if (action.takes_back === null) {
      const kept = await store.getAnswerSubdomain(connection.id);
      if (!kept || !underWebsite(kept.hostname, location.website)) return WEBSITE_MOVED;
    }
    const copy = copyOf(action);
    const page = await store.getHostedPage(connection.id, addressOf(copy));
    if (!page) return null;
    return page.copy === copy ? copy : SOMEBODY_ELSES;
  },
  async apply(target, text) {
    const { store, action } = target;
    if (text === null) {
      if (action.takes_back && (await store.takeBackHostedPage(action.takes_back))) {
        await noticeChange(target, addressOf(copyOf(action)));
      }
      return undefined;
    }
    const slug = addressOf(text);
    const address = await store.publishHostedPage(action.id, {
      slug,
      title: pageParts(text).title,
      copy: text,
    });
    if (!address) throw new Error("The answer subdomain is not served.");
    await noticeChange(target, slug);
    return address;
  },
  async where({ store, connection, action }) {
    const slug = addressOf(copyOf(action));
    if (!(await store.getHostedPage(connection.id, slug))) return undefined;
    return (await hostedAddress(store, connection.id, slug))?.address;
  },
};

const HANDLERS: Record<ActionKind, ActionHandler> = {
  sample,
  wordpress_details: wordpressDetails,
  wordpress_page: wordpressPage,
  hosted_page: hostedPage,
};

/** What the sample listing of a location should open with, composed by rule from its details. */
export function sampleOpeningLine(location: { name: string; city: string | null }): string {
  const place = location.city ? ` in ${location.city}` : "";
  return `${location.name}${place}: open every day. Call ahead for large orders.`;
}

/**
 * Proposes what a connection's last sync shows could be done, for each location matched to it.
 * A proposal the store refuses, because one is already waiting or was declined, is not made
 * again. Returns how many were proposed.
 *
 * The sample kind offers to set its sample listing's opening line to what the location's own
 * details say. A WordPress site offers the business details block on its home page (below).
 */
export async function proposeAfterSync(connectionId: string, deps: ActionDeps): Promise<number> {
  const { store, key } = deps;
  const connection = await store.getConnection(connectionId);
  if (connection?.status !== "working") return 0;
  // An answer subdomain has no sign-in to open.
  if (connection.kind === "hosted_pages") return proposeHostedPages(connection, deps);
  if (!key) return 0;
  const sealed = await store.getConnectionSecret(connectionId);
  if (!sealed) return 0;
  let signIn: string;
  try {
    signIn = await open(key, connectionId, sealed);
  } catch {
    return 0;
  }
  if (connection.kind === "wordpress") {
    return (
      (await proposeDetails(connection, signIn, deps)) +
      (await proposePages(connection, signIn, deps))
    );
  }

  let proposed = 0;
  for (const match of connection.matches) {
    const location = await store.getLocation(match.location_id);
    if (!location) continue;
    const text = sampleOpeningLine(location);
    const now = await store.getSampleLine(connection.id, match.external_id);
    if (now === text) continue;
    const made = await propose(deps, {
      location_id: location.id,
      kind: "sample",
      connection_id: connection.id,
      subject: `opening-line:${match.external_id}`,
      basis: text,
      summary: `Set the opening line of ${match.external_label}`,
      seen: { text: now },
      proposed_text: text,
      written_by: "rule",
    });
    if (made) proposed++;
  }
  return proposed;
}

/**
 * Offers the business details block on a WordPress site's home page, for the location matched to
 * it. Only where the home page is a page of the site's own and the account may put a script on
 * it, and only where the on-page check found the details missing or the product's own block no
 * longer says what is on file. The block is composed by rule, and the task it does the work of
 * is the check's.
 */
async function proposeDetails(
  connection: Connection,
  signIn: string,
  deps: ActionDeps,
): Promise<number> {
  const { store, outside = {} } = deps;
  const site = readWordPressSignIn(signIn);
  let proposed = 0;
  for (const match of connection.matches) {
    const location = await store.getLocation(match.location_id);
    if (!location) continue;
    let front: Awaited<ReturnType<typeof readFrontPage>>;
    try {
      front = await readFrontPage(site, outside);
      if (!front || !(await mayAddScripts(site, outside))) continue;
    } catch (error) {
      // The sync read the site a moment ago. The next one proposes what this one could not.
      console.error(`Connection ${connection.id}: its home page could not be read`, error);
      continue;
    }
    const block = buildBusinessBlock(location).html;
    const now = detailsOnPage(front.raw);
    if (now === block) continue;
    const task = (await store.listRecommendations(location.id)).find(
      (recommendation) => recommendation.rule === DETAILS_RULE && recommendation.status === "open",
    );
    // A page with no block of the product's is offered one only where the check found it lacking.
    if (now === null && !task) continue;
    const made = await propose(deps, {
      location_id: location.id,
      kind: "wordpress_details",
      connection_id: connection.id,
      subject: `details:${front.id}`,
      basis: block,
      summary:
        now === null
          ? "Add your business details to your home page"
          : "Update the business details on your home page",
      seen: { text: now },
      proposed_text: block,
      written_by: "rule",
      recommendation_id: task?.id ?? null,
    });
    if (made) proposed++;
  }
  return proposed;
}

/** A page task whose copy is written and whose page is nowhere yet: what to offer publishing. */
interface PageToOffer {
  task: Recommendation;
  /** The copy as it was written. */
  copy: string;
  title: string;
  /** Where its title puts it. */
  slug: string;
  /** Whether a model wrote it, or it is sample text made by rule. */
  writtenBy: "model" | "rule";
}

/**
 * The page tasks of a location that could be offered for publishing: still to do, with their copy
 * written, and nobody has said where their page is already.
 */
async function pagesToOffer(store: Store, locationId: string): Promise<PageToOffer[]> {
  const [recommendations, drafts, pages] = await Promise.all([
    store.listRecommendations(locationId),
    store.listDrafts(locationId),
    store.listPromptPages(locationId),
  ]);
  const offered: PageToOffer[] = [];
  for (const task of recommendations) {
    if (task.status !== "open" || !promptOfRule(task.rule)) continue;
    if (pages.some((page) => page.recommendation_id === task.id)) continue;
    const draft = drafts.find((kept) => kept.recommendation_id === task.id);
    if (draft?.kind !== "page" || !draft.text) continue;
    const { title } = pageParts(draft.text);
    if (!title) continue;
    offered.push({
      task,
      copy: draft.text,
      title,
      slug: pageSlug(title),
      writtenBy: draft.sample_data ? "rule" : "model",
    });
  }
  return offered;
}

/** A page's title as a proposal names it, cut short where it is long. */
const shortTitle = (title: string) => (title.length > 200 ? `${title.slice(0, 199)}…` : title);

/** The proposal to publish a page task's copy somewhere: `where` ends its summary. */
const pageProposal = (
  page: PageToOffer,
  locationId: string,
  connectionId: string,
  kind: "wordpress_page" | "hosted_page",
  where: string,
): NewAction => ({
  location_id: locationId,
  kind,
  connection_id: connectionId,
  subject: `page:${page.task.id}`,
  basis: page.copy,
  summary: `Publish the page “${shortTitle(page.title)}” ${where}`,
  seen: { text: null },
  proposed_text: page.copy,
  written_by: page.writtenBy,
  recommendation_id: page.task.id,
});

/**
 * Offers to publish each page task's copy on a WordPress site, for the location matched to it,
 * where no page is at the address its title makes. The copy is the task's draft, and the member
 * may change it before saying yes.
 */
async function proposePages(
  connection: Connection,
  signIn: string,
  deps: ActionDeps,
): Promise<number> {
  const { store, outside = {} } = deps;
  const site = readWordPressSignIn(signIn);
  let proposed = 0;
  for (const match of connection.matches) {
    for (const page of await pagesToOffer(store, match.location_id)) {
      try {
        // An address already taken is the owner's page, and nothing is published over it.
        if (await readPageAt(site, page.slug, outside)) continue;
      } catch (error) {
        console.error(`Connection ${connection.id}: its pages could not be read`, error);
        return proposed;
      }
      const made = await propose(
        deps,
        pageProposal(page, match.location_id, connection.id, "wordpress_page", "on your site"),
      );
      if (made) proposed++;
    }
  }
  return proposed;
}

/**
 * Offers to serve each page task's copy on the location's answer subdomain, once it is live and
 * while it still sits under the location's website, where no page is served at the address its
 * title makes.
 */
async function proposeHostedPages(connection: Connection, deps: ActionDeps): Promise<number> {
  const { store } = deps;
  const kept = await store.getAnswerSubdomain(connection.id);
  if (!kept?.live_at || !kept.location_id) return 0;
  const location = await store.getLocation(kept.location_id);
  if (!location || !underWebsite(kept.hostname, location.website)) return 0;
  let proposed = 0;
  for (const page of await pagesToOffer(store, location.id)) {
    if (await store.getHostedPage(connection.id, page.slug)) continue;
    const made = await propose(
      deps,
      pageProposal(page, location.id, connection.id, "hosted_page", `at ${kept.hostname}`),
    );
    if (made) proposed++;
  }
  return proposed;
}

/**
 * The connection to read once a draft is written, where the draft is a page's copy and its
 * location publishes pages somewhere: its WordPress site or its answer subdomain. Reading it is
 * what proposes publishing the page, so the owner need not wait for the daily run. Null where
 * there is none. A location publishes to one place, so there is at most one.
 */
export async function connectionToPublishWith(
  store: Store,
  draftId: string,
): Promise<string | null> {
  const draft = await store.getDraft(draftId);
  if (draft?.kind !== "page" || draft.status !== "written") return null;
  const connections = await store.listLocationConnections(draft.location_id);
  return (
    connections.find(
      (connection) => connection.kind === "wordpress" || connection.kind === "hosted_pages",
    )?.connection_id ?? null
  );
}

/** How many times an action is tried before it is marked failed. */
const MOST_ATTEMPTS = 3;

export type CarriedOut =
  | "done"
  | "failed"
  | "out_of_date"
  | "again"
  | "not_approved"
  | "busy"
  | "held"
  | "waiting";

/** The text an action puts there: what was approved, which is the proposal unless it was changed. */
export const actionText = (action: Pick<Action, "approved_text" | "proposed_text">) =>
  action.approved_text ?? action.proposed_text;

/**
 * Carries out one approved action, once.
 *
 * It looks first at what is there now. If that is already what the action would make it, the
 * action is done and nothing is written: this is what makes a message delivered twice harmless.
 * If it is no longer what the member was shown, nothing is written either and the action lapses
 * as out of date, since a yes to one change is not a yes to another.
 *
 * A try that does not work is tried again, up to three times, and then the action is failed
 * with the reason. `again` asks whoever called to have it delivered again later. `held` is an
 * action left approved because its organization's owners are still to be told of an earlier one.
 * `waiting` is one that standing permission approved, put back to wait for a member's yes because
 * that permission no longer stands: the database checks as the action is taken.
 *
 * Taking the action also takes one from the month's allowance, where its kind is counted, and
 * an ending that left the thing undone gives it back. Being done marks the task the action does
 * the work of. The database does both, in the same step as it records the taking and the ending.
 */
export async function carryOutAction(
  actionId: string,
  { store, key, outside = {}, hosting }: ActionDeps,
): Promise<CarriedOut> {
  const action = await store.getAction(actionId);
  if (action?.status !== "approved") return "not_approved";
  // Nothing more is carried out for an organization whose owners have gone 36 hours untold of
  // something that was. The action stays approved, and the schedule asks again.
  const location = await store.getLocation(action.location_id);
  if (location && (await store.isOrganizationHeld(location.organization_id))) return "held";
  const attempt = await store.claimAction(actionId);
  if (attempt === 0) {
    // Nobody else is on it if the month had no room for it: it was failed as it was taken. Nor
    // if the permission that approved it had ended: it waits for a yes again.
    const now = (await store.getAction(actionId))?.status;
    return now === "failed" ? "failed" : now === "proposed" ? "waiting" : "busy";
  }

  const fail = async (why: string): Promise<CarriedOut> => {
    await store.finishAction(actionId, "failed", why);
    return "failed";
  };

  const connection = action.connection_id ? await store.getConnection(action.connection_id) : null;
  // A paused answer subdomain still serves its pages for a while, so one can still be taken back.
  const takingBackWhilePaused =
    connection?.kind === "hosted_pages" &&
    connection.status === "paused" &&
    action.takes_back !== null;
  if (!connection || (connection.status !== "working" && !takingBackWhilePaused)) {
    return fail("The account this goes through is not connected, or is not working.");
  }
  const match = connection.matches.find((kept) => kept.location_id === action.location_id);
  if (!match) return fail("This location is no longer matched to that account.");
  // An answer subdomain has no sign-in: its pages are served from the product's own tables.
  let signIn = "";
  if (connection.kind !== "hosted_pages") {
    const sealed = await store.getConnectionSecret(connection.id);
    if (!sealed || !key) return fail("The account's sign-in could not be read.");
    try {
      signIn = await open(key, connection.id, sealed);
    } catch {
      return fail("The account's sign-in could not be read.");
    }
  }
  const text = actionText(action);
  // Taking an action back puts back nothing where there was nothing: that is taking it away.
  if (text === null && action.takes_back === null) {
    return fail("There is nothing for this action to put there.");
  }
  if (action.approved_text !== null && !EDITABLE_ACTION_KINDS.includes(action.kind)) {
    return fail("This change is made as it was proposed, so it cannot be changed first.");
  }
  // What the member was shown it would replace is no longer kept, so there is nothing to check
  // what is there now against.
  if (action.seen_dropped_at !== null) {
    await store.finishAction(actionId, "out_of_date");
    return "out_of_date";
  }

  const handler = HANDLERS[action.kind];
  if (!location) return fail("The location is no longer there.");
  const target = { store, connection, match, signIn, outside, action, location, hosting };
  // Where a kind's work has an address of its own, it is kept for the task the action did.
  const keep = async (address: string | undefined) => {
    if (address && text !== null) await store.keepPublishedPage(actionId, address);
  };
  try {
    const now = await handler.current(target);
    if (now === text) {
      await keep(await handler.where?.(target));
      await store.finishAction(actionId, "done");
      return "done";
    }
    if (now !== (action.seen?.text ?? null)) {
      await store.finishAction(actionId, "out_of_date");
      return "out_of_date";
    }
    await keep(await handler.apply(target, text));
    await store.finishAction(actionId, "done");
    return "done";
  } catch (error) {
    const why = error instanceof Error ? error.message : "It could not be done.";
    console.error(`Action ${actionId}: a try at carrying it out failed`, error);
    // A refused sign-in will not work the next time either.
    if (error instanceof SignInRefused || error instanceof WordPressRefused) {
      return fail("The account refused the sign-in.");
    }
    if (attempt >= MOST_ATTEMPTS) return fail(why);
    await store.finishAction(actionId, "again", why);
    return "again";
  }
}

/** The one queue method used here. `env.SCAN_QUEUE` satisfies it. */
type ActionQueue = Pick<Queue<ActionMessage>, "sendBatch">;

/**
 * How long an approved action may sit before it is queued again. Longer than the ten minutes a
 * worker's hold on one lasts, so one a worker took and died with can be taken by the next.
 */
const STALLED_AFTER_MS = 15 * 60_000;

/**
 * Queues again every approved action nobody is carrying out: its message was lost, the worker
 * let go of it to be tried again, or the worker that took it died. Returns how many.
 */
export async function requeueStalledActions(
  store: Store,
  queue: ActionQueue,
  now = Date.now(),
): Promise<number> {
  const stalled = await store.listStalledActions(new Date(now - STALLED_AFTER_MS).toISOString());
  if (stalled.length === 0) return 0;
  await queue.sendBatch(
    stalled.slice(0, 100).map((id) => ({ body: { action_id: id, step: "carry_out" as const } })),
  );
  return Math.min(stalled.length, 100);
}
