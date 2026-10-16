import {
  type HostedAnswer,
  HostedAnswerSchema,
  INDEXNOW_KEY,
  ZONE_DOMAIN,
} from "@nearcited/shared";
import { render, sitemap } from "./render";

/**
 * The Pages Worker: serves the hosted pages of each business on its answer subdomain, and nothing
 * else (issue #141, docs/adr/0019-hosted-pages-are-served-by-a-worker-of-their-own.md).
 *
 * It holds no secret. It reads through one database function any caller may call, which answers
 * only for an answer subdomain that is live and only with what the page shows anyway. A host the
 * function does not answer for gets nothing, so this Worker never shows the app, its API or
 * anything of one business on another's domain.
 */

export interface Env {
  SUPABASE_URL: string;
  /** Safe to expose: it reads only what anyone may read. */
  SUPABASE_PUBLISHABLE_KEY: string;
}

/** The zone's own names. Its route runs before them, so what is theirs is handed on. */
const ownName = (host: string) => host === ZONE_DOMAIN || host.endsWith(`.${ZONE_DOMAIN}`);

/**
 * Where a certificate authority checks that a name may have a certificate. Cloudflare answers
 * these for a custom hostname, so they are handed on untouched, over http or https, or the
 * certificate is never issued.
 */
const certificateCheck = (path: string) =>
  path.startsWith("/.well-known/acme-challenge/") ||
  path.startsWith("/.well-known/pki-validation/");

/** How long a browser or a cache may keep what was answered, in seconds. */
const KEEP_SECONDS = 300;

/** Sent with every answer: nothing may run, be fetched or frame the page. */
const SECURITY = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/** An answer of one kind, with what every answer carries. A HEAD has the same, without a body. */
function answer(
  request: Request,
  status: number,
  type: string,
  body: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(request.method === "HEAD" ? null : body, {
    status,
    headers: {
      "Content-Type": `${type}; charset=utf-8`,
      "Cache-Control": status >= 500 ? "no-store" : `public, max-age=${KEEP_SECONDS}`,
      ...SECURITY,
      ...extra,
    },
  });
}

/** Nothing is served here. Said the same way whatever was asked. */
const nothing = (request: Request) => answer(request, 404, "text/plain", "Not found");

/** Thrown when the database could not be read, so the visitor is asked to come back. */
class Unreadable extends Error {}

/** What the database answers for one address on a host. Null for a host that is not served. */
async function ask(env: Env, host: string, path: string): Promise<HostedAnswer | null> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/hosted_page`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_PUBLISHABLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ host, path }),
  });
  if (!response.ok) throw new Unreadable(`The database answered ${response.status}.`);
  const kept: unknown = await response.json();
  return kept === null ? null : HostedAnswerSchema.parse(kept);
}

/** Answers one request to an answer subdomain. */
async function serve(request: Request, env: Env, url: URL, host: string): Promise<Response> {
  const path = url.pathname;
  // The files a crawler or a search engine asks for are made from the list of live pages.
  if (path === "/robots.txt" || path === "/sitemap.xml" || path === `/${INDEXNOW_KEY}.txt`) {
    const list = await ask(env, host, "/");
    if (list?.kind !== "list") return nothing(request);
    if (path === "/robots.txt") {
      return answer(
        request,
        200,
        "text/plain",
        `User-agent: *\nAllow: /\n\nSitemap: ${url.origin}/sitemap.xml\n`,
      );
    }
    if (path === "/sitemap.xml") {
      return answer(request, 200, "application/xml", sitemap(list, url.origin));
    }
    return answer(request, 200, "text/plain", INDEXNOW_KEY);
  }
  const found = await ask(env, host, path);
  if (!found) return nothing(request);
  const { status, html } = render(found, url);
  return answer(request, status, "text/html", html);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    // The app and every other name of the zone's own are not this Worker's to answer, and nor is
    // a certificate check.
    if (ownName(host) || certificateCheck(url.pathname)) return fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD", ...SECURITY } });
    }
    // Pages are read over https.
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return new Response(null, { status: 301, headers: { Location: url.href } });
    }
    try {
      return await serve(request, env, url, host);
    } catch (error) {
      console.error(`${host}${url.pathname} could not be answered`, error);
      return answer(request, 503, "text/plain", "Try again in a few minutes.", {
        "Retry-After": String(KEEP_SECONDS),
      });
    }
  },
} satisfies ExportedHandler<Env>;
