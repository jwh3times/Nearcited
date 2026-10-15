import {
  type ConnectionChoice,
  sameSite,
  type WordPressApproved,
  type WordPressCheck,
} from "@nearcited/shared";
import { SITE_USER_AGENT, safeSiteUrl } from "../site/fetch";

/**
 * A business's own WordPress site, reached through WordPress's own interface (issue #140).
 * Like a provider, this only fetches: it says what the site answered and decides nothing.
 *
 * The site's address comes from a user, so every request is held to the rules the on-page check
 * follows (`safeSiteUrl`): the web's default ports, no IP addresses or internal names, and each
 * redirect checked before it is followed. A request that carries the sign-in goes further: only
 * over https, only to the site's own host, and never on through a redirect, so the password is
 * sent nowhere but where it was made.
 */

/** What the worker keeps, sealed, for a WordPress connection. */
export interface WordPressSignIn {
  /** The site's home, as WordPress gives it. */
  site: string;
  /** Where its interface is: `.../wp-json/`, or `...?rest_route=/` where the site has no pretty addresses. */
  api: string;
  user: string;
  password: string;
  /** The application password's own ID, to take it back with. Null where the site did not say. */
  uuid: string | null;
}

export interface WordPressDeps {
  fetch?: typeof fetch;
  /**
   * The one origin of a WordPress running on this machine for testing, such as
   * `http://localhost:8099`, which may then be reached over http. Never set on a deployment.
   */
  localOrigin?: string | null;
}

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;
/** The most of an answer that is read. The fields asked for are a few hundred bytes. */
const MAX_BYTES = 200_000;

/** Thrown when the site answered in a way that says nothing: not reached, or not understood. */
export class SiteUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteUnreachable";
  }
}

/** Thrown when the site refused the sign-in: the password was taken back, or the user removed. */
export class WordPressRefused extends Error {
  constructor(message = "The site refused the sign-in.") {
    super(message);
    this.name = "WordPressRefused";
  }
}

/** The address, or null when the Worker should not call it. A local WordPress may be on http. */
function siteAddress(address: string, deps: WordPressDeps, base?: URL): URL | null {
  if (deps.localOrigin) {
    try {
      const url = base ? new URL(address, base) : new URL(address);
      if (url.origin === new URL(deps.localOrigin).origin) return url;
    } catch {
      // Not an address at all: the rules below say so.
    }
  }
  return safeSiteUrl(address, base);
}

/** Whether a request may carry the sign-in to `url`: over https to the site's own host. */
function mayCarrySignIn(url: URL, site: string, deps: WordPressDeps): boolean {
  if (deps.localOrigin && url.origin === new URL(deps.localOrigin).origin) return true;
  return url.protocol === "https:" && safeSiteUrl(url.href) !== null && sameSite(url.href, site);
}

async function readJson(response: Response): Promise<unknown> {
  const text = (await response.text()).slice(0, MAX_BYTES);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Fetches without the sign-in, following redirects by hand so each hop is checked first. */
async function look(
  start: URL,
  accept: string,
  deps: WordPressDeps,
): Promise<{ url: URL; response: Response }> {
  const fetchImpl = deps.fetch ?? fetch;
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchImpl(url.href, {
      redirect: "manual",
      headers: { "User-Agent": SITE_USER_AGENT, Accept: accept },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const location = response.headers.get("Location");
    if (response.status < 300 || response.status >= 400 || !location) return { url, response };
    await response.body?.cancel().catch(() => {});
    const next = siteAddress(location, deps, url);
    if (!next) throw new SiteUnreachable("The site sent the request somewhere it may not go.");
    url = next;
  }
  throw new SiteUnreachable("The site redirected too many times.");
}

/** An address on the site's interface: `wp/v2/users/me` under `/wp-json/`, or as `rest_route`. */
export function route(api: string, path: string, params: Record<string, string> = {}): URL {
  const root = new URL(api);
  let url: URL;
  if (root.searchParams.has("rest_route")) {
    url = new URL(root);
    url.searchParams.set("rest_route", `/${path}`);
  } else {
    url = new URL(path, root.href.endsWith("/") ? root : new URL(`${root.href}/`));
  }
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url;
}

/** The few HTML entities WordPress writes into a site's name. */
export function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const point =
        code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    return named[code.toLowerCase()] ?? whole;
  });
}

/** What a site's interface says of the site, read without a sign-in. */
interface Found {
  home: string;
  api: string;
  name: string | null;
  /** Where the owner approves a password, when the site gives them out. */
  authorize: string | null;
}

/**
 * The address a `Link` header names as the site's interface, `rel="https://api.w.org/"`, or
 * undefined. Read by splitting, not by a pattern: the header is the site's to write, and a
 * pattern for "anything up to the next >" is tried again from every "<" of one that never closes.
 */
export function interfaceLink(header: string): string | undefined {
  for (const part of header.split(",")) {
    const close = part.indexOf(">");
    const start = part.indexOf("<");
    if (start === -1 || close < start) continue;
    const params = part
      .slice(close + 1)
      .split(";")
      .map((param) => param.trim());
    if (params.includes('rel="https://api.w.org/"')) return part.slice(start + 1, close).trim();
  }
  return undefined;
}

/** Where the interface is: the address the home page names for it, or `/wp-json/` beside it. */
function apiRoot(response: Response, home: URL, deps: WordPressDeps): URL | null {
  const named = interfaceLink(response.headers.get("Link") ?? "");
  const root = named ? siteAddress(named, deps, home) : new URL("/wp-json/", home);
  return root && sameSite(root.href, home.href) ? root : null;
}

/**
 * Finds the site's interface from its home page, and asks it what the site is and whether it
 * gives out application passwords. Null where it is not WordPress, or not one that says so.
 * Throws `SiteUnreachable` where the site could not be read at all.
 */
async function discover(website: string, deps: WordPressDeps): Promise<Found | null> {
  const start = siteAddress(website, deps);
  if (!start) throw new SiteUnreachable("That is not an address the product reaches.");
  let page: Awaited<ReturnType<typeof look>>;
  try {
    page = await look(start, "text/html,*/*;q=0.5", deps);
  } catch (error) {
    if (error instanceof SiteUnreachable) throw error;
    throw new SiteUnreachable("The site did not answer.");
  }
  await page.response.body?.cancel().catch(() => {});
  if (page.response.status === 429 || page.response.status >= 500) {
    throw new SiteUnreachable(`The site answered ${page.response.status}.`);
  }
  const root = apiRoot(page.response, page.url, deps);
  if (!root) return null;

  let index: Awaited<ReturnType<typeof look>>;
  try {
    index = await look(
      route(root.href, "", { _fields: "name,url,home,authentication" }),
      "application/json",
      deps,
    );
  } catch {
    return null;
  }
  if (index.response.status !== 200) {
    await index.response.body?.cancel().catch(() => {});
    return null;
  }
  const body = (await readJson(index.response)) as {
    name?: unknown;
    home?: unknown;
    url?: unknown;
    authentication?: { "application-passwords"?: { endpoints?: { authorization?: unknown } } };
  } | null;
  const home =
    typeof body?.home === "string" ? body.home : typeof body?.url === "string" ? body.url : null;
  if (!body || !home) return null;
  const endpoint = body.authentication?.["application-passwords"]?.endpoints?.authorization;
  const authorize =
    typeof endpoint === "string" && siteAddress(endpoint, deps) && sameSite(endpoint, home)
      ? endpoint
      : null;
  const name = typeof body.name === "string" ? decodeEntities(body.name).trim() : "";
  return { home, api: root.href, name: name || null, authorize };
}

/**
 * Whether the location's website is a WordPress that gives out application passwords, and where
 * its owner approves one. Never throws: what went wrong is the verdict.
 */
export async function checkWordPress(
  website: string | null,
  deps: WordPressDeps = {},
): Promise<WordPressCheck> {
  const nothing = { authorize_url: null, site_name: null };
  if (!website) return { verdict: "no_website", ...nothing };
  let found: Found | null;
  try {
    found = await discover(website, deps);
  } catch {
    return { verdict: "unreachable", ...nothing };
  }
  if (!found) return { verdict: "not_wordpress", ...nothing };
  if (!found.authorize) return { verdict: "passwords_off", ...nothing, site_name: found.name };
  return { verdict: "ready", authorize_url: found.authorize, site_name: found.name };
}

/** Base64 of the user name and password, for HTTP basic authentication, in UTF-8. */
function basic(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

/**
 * A request to the site's interface carrying the sign-in. It goes only where the sign-in may be
 * sent, and a redirect is not followed: that would send the password to wherever it points.
 */
export async function signedIn(
  signIn: WordPressSignIn,
  url: URL,
  init: { method?: string; body?: unknown } = {},
  deps: WordPressDeps = {},
): Promise<Response> {
  if (!mayCarrySignIn(url, signIn.site, deps)) {
    throw new SiteUnreachable("The site's interface is not somewhere the sign-in may be sent.");
  }
  const response = await (deps.fetch ?? fetch)(url.href, {
    method: init.method ?? "GET",
    redirect: "manual",
    headers: {
      Authorization: basic(signIn.user, signIn.password),
      "User-Agent": SITE_USER_AGENT,
      Accept: "application/json",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new SiteUnreachable("The site sent a signed-in request somewhere else.");
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {});
    throw new WordPressRefused(`The site answered ${response.status}.`);
  }
  return response;
}

/** Why approving did not end in a connection, as the API says it. */
export type NotConnected = "not_this_site" | "refused" | "cannot_publish" | "unreachable";

/**
 * Signs in with what WordPress handed back once its owner approved, and says what the account
 * may do. The site has to be the location's website, and the account one that may publish pages.
 * What is returned is what the worker keeps, sealed, and what the connection is called.
 */
export async function signInWith(
  approved: WordPressApproved,
  website: string,
  deps: WordPressDeps = {},
): Promise<{ signIn: WordPressSignIn; label: string } | NotConnected> {
  if (!sameSite(approved.site_url, website)) return "not_this_site";
  let found: Found | null;
  try {
    found = await discover(approved.site_url, deps);
  } catch {
    return "unreachable";
  }
  if (!found || !sameSite(found.home, website)) return found ? "not_this_site" : "unreachable";
  const signIn: WordPressSignIn = {
    site: found.home,
    api: found.api,
    user: approved.user_login,
    password: approved.password,
    uuid: null,
  };
  try {
    const me = await signedIn(
      signIn,
      route(signIn.api, "wp/v2/users/me", { context: "edit", _fields: "id,capabilities" }),
      {},
      deps,
    );
    const body = (await readJson(me)) as { capabilities?: Record<string, unknown> } | null;
    if (me.status !== 200 || !body) return "unreachable";
    if (body.capabilities?.publish_pages !== true) return "cannot_publish";

    // Its own ID, so removing the connection can take this password back and no other.
    const introspect = await signedIn(
      signIn,
      route(signIn.api, "wp/v2/users/me/application-passwords/introspect", { _fields: "uuid" }),
      {},
      deps,
    );
    const password = (await readJson(introspect)) as { uuid?: unknown } | null;
    if (introspect.status === 200 && typeof password?.uuid === "string") {
      signIn.uuid = password.uuid;
    }
  } catch (error) {
    return error instanceof WordPressRefused ? "refused" : "unreachable";
  }
  return { signIn, label: new URL(found.home).hostname.replace(/^www\./, "") };
}

/**
 * What the sign-in reaches: the one site, with what it calls itself. Reading as the account is
 * what tells that the sign-in still works. Throws `WordPressRefused` where the site refuses it.
 */
export async function readSite(
  signIn: WordPressSignIn,
  deps: WordPressDeps = {},
): Promise<ConnectionChoice[]> {
  const me = await signedIn(
    signIn,
    route(signIn.api, "wp/v2/users/me", { _fields: "id" }),
    {},
    deps,
  );
  await me.body?.cancel().catch(() => {});
  if (me.status !== 200) throw new SiteUnreachable(`The site answered ${me.status}.`);
  const index = await signedIn(signIn, route(signIn.api, "", { _fields: "name" }), {}, deps);
  const body = (await readJson(index)) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? decodeEntities(body.name).trim() : "";
  const host = new URL(signIn.site).hostname.replace(/^www\./, "");
  return [{ id: signIn.site, label: name ? `${name} (${host})` : host }];
}

/**
 * Takes the application password back at the site, so the access it gave ends there too. True
 * when the site no longer holds it: taken back now, or already gone. False where the site could
 * not be asked, which leaves it in the owner's WordPress profile for them to take back; removing
 * the connection still deletes the product's copy, since nobody then holds it.
 */
export async function withdrawPassword(
  signIn: WordPressSignIn,
  deps: WordPressDeps = {},
): Promise<boolean> {
  if (!signIn.uuid) return false;
  try {
    const response = await signedIn(
      signIn,
      route(signIn.api, `wp/v2/users/me/application-passwords/${encodeURIComponent(signIn.uuid)}`),
      { method: "DELETE" },
      deps,
    );
    await response.body?.cancel().catch(() => {});
    return response.status === 200 || response.status === 404 || response.status === 410;
  } catch (error) {
    // Refused: the password was already taken back, or its user removed.
    return error instanceof WordPressRefused;
  }
}

/** A page of the site, as its editor holds it. */
export interface WordPressPage {
  id: number;
  /** Its content as written, before WordPress lays it out. */
  raw: string;
  link: string;
}

/** Reads one page as its editor holds it, or null where the site has no such page. */
export async function readPage(
  signIn: WordPressSignIn,
  id: number,
  deps: WordPressDeps = {},
): Promise<WordPressPage | null> {
  const response = await signedIn(
    signIn,
    route(signIn.api, `wp/v2/pages/${id}`, { context: "edit", _fields: "id,link,content,status" }),
    {},
    deps,
  );
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const body = (await readJson(response)) as {
    id?: unknown;
    link?: unknown;
    status?: unknown;
    content?: { raw?: unknown };
  } | null;
  if (response.status !== 200 || !body || typeof body.content?.raw !== "string") {
    throw new SiteUnreachable(`The site answered ${response.status} for a page.`);
  }
  if (body.status === "trash") return null;
  return {
    id,
    raw: body.content.raw,
    link: typeof body.link === "string" ? body.link : signIn.site,
  };
}

/**
 * The page the site shows as its home page, where it is a page of its own. Null where the home
 * page is the list of latest posts, which has no content of its own to add to.
 */
export async function readFrontPage(
  signIn: WordPressSignIn,
  deps: WordPressDeps = {},
): Promise<WordPressPage | null> {
  const index = await signedIn(
    signIn,
    route(signIn.api, "", { _fields: "show_on_front,page_on_front" }),
    {},
    deps,
  );
  const body = (await readJson(index)) as {
    show_on_front?: unknown;
    page_on_front?: unknown;
  } | null;
  if (index.status !== 200 || !body)
    throw new SiteUnreachable(`The site answered ${index.status}.`);
  const id = body.page_on_front;
  if (body.show_on_front !== "page" || typeof id !== "number" || id <= 0) return null;
  return readPage(signIn, id, deps);
}

/**
 * Whether the account may put any HTML on a page, a script included. WordPress strips a script
 * from what anyone else saves, so the details block is offered only where this is true.
 */
export async function mayAddScripts(
  signIn: WordPressSignIn,
  deps: WordPressDeps = {},
): Promise<boolean> {
  const me = await signedIn(
    signIn,
    route(signIn.api, "wp/v2/users/me", { context: "edit", _fields: "capabilities" }),
    {},
    deps,
  );
  const body = (await readJson(me)) as { capabilities?: Record<string, unknown> } | null;
  if (me.status !== 200 || !body) throw new SiteUnreachable(`The site answered ${me.status}.`);
  return body.capabilities?.unfiltered_html === true;
}

/** Saves a page's content as written. */
export async function writePageContent(
  signIn: WordPressSignIn,
  id: number,
  raw: string,
  deps: WordPressDeps = {},
): Promise<void> {
  const response = await signedIn(
    signIn,
    route(signIn.api, `wp/v2/pages/${id}`, { _fields: "id" }),
    { method: "POST", body: { content: raw } },
    deps,
  );
  await response.body?.cancel().catch(() => {});
  if (response.status !== 200) throw new SiteUnreachable(`The site answered ${response.status}.`);
}

/**
 * The page at an address of the site, as its editor holds it, or null where none is: none was
 * ever there, or it was moved to the trash. Pages waiting to be published count, since a new page
 * there would take another address.
 */
export async function readPageAt(
  signIn: WordPressSignIn,
  slug: string,
  deps: WordPressDeps = {},
): Promise<WordPressPage | null> {
  const response = await signedIn(
    signIn,
    route(signIn.api, "wp/v2/pages", {
      slug,
      status: "publish,future,draft,pending,private",
      context: "edit",
      _fields: "id,link,content",
    }),
    {},
    deps,
  );
  const body = (await readJson(response)) as
    | { id?: unknown; link?: unknown; content?: { raw?: unknown } }[]
    | null;
  if (response.status !== 200 || !Array.isArray(body)) {
    throw new SiteUnreachable(`The site answered ${response.status} for its pages.`);
  }
  const [page] = body;
  if (!page || typeof page.id !== "number" || typeof page.content?.raw !== "string") return null;
  return {
    id: page.id,
    raw: page.content.raw,
    link: typeof page.link === "string" ? page.link : signIn.site,
  };
}

/** Publishes a new page, and says where it is. */
export async function createPage(
  signIn: WordPressSignIn,
  page: { title: string; slug: string; content: string },
  deps: WordPressDeps = {},
): Promise<WordPressPage> {
  const response = await signedIn(
    signIn,
    route(signIn.api, "wp/v2/pages", { _fields: "id,link" }),
    { method: "POST", body: { ...page, status: "publish" } },
    deps,
  );
  const body = (await readJson(response)) as { id?: unknown; link?: unknown } | null;
  if (response.status !== 201 || typeof body?.id !== "number") {
    throw new SiteUnreachable(`The site answered ${response.status} to a new page.`);
  }
  return {
    id: body.id,
    raw: page.content,
    link: typeof body.link === "string" ? body.link : signIn.site,
  };
}

/** Moves a page to WordPress's trash, from which its owner can restore it for thirty days. */
export async function trashPage(
  signIn: WordPressSignIn,
  id: number,
  deps: WordPressDeps = {},
): Promise<void> {
  const response = await signedIn(
    signIn,
    route(signIn.api, `wp/v2/pages/${id}`, { _fields: "id" }),
    { method: "DELETE" },
    deps,
  );
  await response.body?.cancel().catch(() => {});
  if (response.status !== 200) throw new SiteUnreachable(`The site answered ${response.status}.`);
}
