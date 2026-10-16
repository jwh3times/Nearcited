import { INDEXNOW_KEY } from "@nearcited/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

const env: Env = {
  SUPABASE_URL: "https://db.example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
};

const BUSINESS = {
  name: "Joe's <Pizza> & Pasta",
  website: "https://www.joespizza.example/",
  address_line: "12 Main St",
  city: "Raleigh",
  region: "NC",
  postal_code: "27601",
  country_code: "US",
  phone: "+19195550100",
};

const COPY = [
  "Late night pizza in Raleigh",
  "",
  "We make wood-fired pizza until 2am, every night of the week.",
  "",
  "## Where we are",
  "",
  "On Main Street, by the <station>.",
].join("\n");

/** What the database function answers, by host and then path. A host not here is not served. */
let answers: Map<string, (path: string) => unknown>;
/** Every call the Worker made to the database, and anything it fetched elsewhere. */
let asked: { url: string; body: unknown; apikey: string | null }[];
let passedOn: string[];

const database: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (input instanceof Request) {
    passedOn.push(url);
    return new Response("the app", { status: 200 });
  }
  const body = JSON.parse(String(init?.body ?? "null")) as { host: string; path: string };
  asked.push({ url, body, apikey: new Headers(init?.headers).get("apikey") });
  if (url === `${env.SUPABASE_URL}/rest/v1/rpc/record_page_fetch`) {
    return new Response(null, { status: 204 });
  }
  if (url !== `${env.SUPABASE_URL}/rest/v1/rpc/hosted_page`) {
    return new Response("Not found", { status: 404 });
  }
  const answer = answers.get(body.host)?.(body.path) ?? null;
  return new Response(JSON.stringify(answer), {
    headers: { "Content-Type": "application/json" },
  });
};

const pages = (path: string) => {
  if (path === "/") {
    return {
      kind: "list",
      business: BUSINESS,
      pages: [
        {
          slug: "late-night-pizza-in-raleigh",
          title: "Late night pizza in Raleigh",
          published_at: "2026-10-20T10:00:00Z",
        },
        {
          slug: "gluten-free-pizza",
          title: "Gluten-free pizza",
          published_at: "2026-10-18T09:00:00Z",
        },
      ],
    };
  }
  if (path === "/late-night-pizza-in-raleigh" || path === "/late-night-pizza-in-raleigh/") {
    return {
      kind: "page",
      business: BUSINESS,
      title: "Late night pizza in Raleigh",
      copy: COPY,
      published_at: "2026-10-20T10:00:00Z",
    };
  }
  if (path === "/taken-back") return { kind: "gone", business: BUSINESS };
  if (path === "/wound-down") {
    return { kind: "redirect", business: BUSINESS, to: "https://www.joespizza.example/" };
  }
  return { kind: "missing", business: BUSINESS };
};

/** What the Worker left to finish after answering: the fetches it counts. */
let after: Promise<unknown>[];
const context = {
  waitUntil: (promise: Promise<unknown>) => {
    after.push(promise);
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const get = async (url: string, init?: RequestInit) => {
  const response = await worker.fetch(new Request(url, init), env, context);
  await Promise.all(after);
  return response;
};
/** The fetches the Worker counted, as it asked the database to. */
const counted = () =>
  asked.filter((call) => call.url.endsWith("/rpc/record_page_fetch")).map((call) => call.body);

beforeEach(() => {
  answers = new Map([["answers.joespizza.example", pages]]);
  asked = [];
  passedOn = [];
  after = [];
  vi.stubGlobal("fetch", database);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every response must be readable without running anything, and keep nothing in the browser. */
async function plain(response: Response) {
  const html = await response.clone().text();
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    expect(tag).toBe('<script type="application/ld+json">');
  }
  expect(html).not.toMatch(/<img|<iframe|\son[a-z]+=/i);
  expect(response.headers.get("Set-Cookie")).toBeNull();
  expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'none'");
  return html;
}

describe("a hosted page", () => {
  it("is plain HTML with the business's name linking to its site, the copy, and the closing", async () => {
    const response = await get("https://answers.joespizza.example/late-night-pizza-in-raleigh");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const html = await plain(response);
    expect(html).toContain("<h1>Late night pizza in Raleigh</h1>");
    expect(html).toContain("<p>We make wood-fired pizza until 2am, every night of the week.</p>");
    expect(html).toContain("<h2>Where we are</h2>");
    // Everything it was given is text, never markup.
    expect(html).toContain("On Main Street, by the &lt;station&gt;.");
    expect(html).toContain(
      `<a href="https://www.joespizza.example/">Joe's &lt;Pizza&gt; &amp; Pasta</a>`,
    );
    // The closing is composed by rule from the location's details as they are now.
    expect(html).toContain("12 Main St, Raleigh, NC 27601");
    expect(html).toContain(
      '<link rel="canonical" href="https://answers.joespizza.example/late-night-pizza-in-raleigh">',
    );
    expect(html).toContain('<meta name="generator" content="Nearcited">');
    expect(html).not.toMatch(/nearcited\.com/i);
    // A trailing slash is the same page.
    expect(
      (await get("https://answers.joespizza.example/late-night-pizza-in-raleigh/")).status,
    ).toBe(200);
    // The database is asked with the publishable key and nothing else.
    expect(asked[0]).toEqual({
      url: `${env.SUPABASE_URL}/rest/v1/rpc/hosted_page`,
      body: { host: "answers.joespizza.example", path: "/late-night-pizza-in-raleigh" },
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
    });
  });

  it("states who and where the business is as structured details", async () => {
    const html = await plain(
      await get("https://answers.joespizza.example/late-night-pizza-in-raleigh"),
    );
    const [, json] = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html) ?? [];
    expect(JSON.parse(json ?? "{}")).toMatchObject({
      "@type": "LocalBusiness",
      name: "Joe's <Pizza> & Pasta",
      url: "https://www.joespizza.example/",
      telephone: "+19195550100",
      address: { streetAddress: "12 Main St", addressLocality: "Raleigh" },
    });
  });

  it("answers 410 once taken back, with a line and a link to the business's site", async () => {
    const response = await get("https://answers.joespizza.example/taken-back");
    expect(response.status).toBe(410);
    const html = await plain(response);
    expect(html).toContain('<a href="https://www.joespizza.example/">');
  });

  it("answers 404 for a page that was never there", async () => {
    const response = await get("https://answers.joespizza.example/nothing-here");
    expect(response.status).toBe(404);
    await plain(response);
  });

  it("answers a HEAD as a GET, without the body, and nothing that writes", async () => {
    const head = await get("https://answers.joespizza.example/late-night-pizza-in-raleigh", {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const post = await get("https://answers.joespizza.example/late-night-pizza-in-raleigh", {
      method: "POST",
    });
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD");
  });

  it("sends a visit over http to https", async () => {
    const response = await get("http://answers.joespizza.example/late-night-pizza-in-raleigh");
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(
      "https://answers.joespizza.example/late-night-pizza-in-raleigh",
    );
  });

  it("hands a certificate check on untouched, over http or https, before anything else", async () => {
    const checks = [
      "http://answers.joespizza.example/.well-known/acme-challenge/abc",
      "https://answers.joespizza.example/.well-known/pki-validation/abc.txt",
      "http://answers.somebodyelse.example/.well-known/acme-challenge/xyz",
    ];
    for (const url of checks) {
      expect(await (await get(url)).text(), url).toBe("the app");
    }
    expect(passedOn).toEqual(checks);
    expect(asked).toEqual([]);
  });
});

describe("an answer subdomain", () => {
  it("lists its pages at the bare subdomain, newest first, with the way to the business's site", async () => {
    const response = await get("https://answers.joespizza.example/");
    expect(response.status).toBe(200);
    const html = await plain(response);
    const first = html.indexOf('href="/late-night-pizza-in-raleigh"');
    const second = html.indexOf('href="/gluten-free-pizza"');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(html).toContain('<a href="https://www.joespizza.example/">');
  });

  it("lets every crawler in, and names its sitemap", async () => {
    const response = await get("https://answers.joespizza.example/robots.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe(
      "User-agent: *\nAllow: /\n\nSitemap: https://answers.joespizza.example/sitemap.xml\n",
    );
  });

  it("lists every live page in its sitemap", async () => {
    const response = await get("https://answers.joespizza.example/sitemap.xml");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    const xml = await response.text();
    expect(xml).toContain("<loc>https://answers.joespizza.example/</loc>");
    expect(xml).toContain(
      "<url><loc>https://answers.joespizza.example/late-night-pizza-in-raleigh</loc><lastmod>2026-10-20</lastmod></url>",
    );
    expect(xml).toContain("<loc>https://answers.joespizza.example/gluten-free-pizza</loc>");
  });

  it("serves the IndexNow key, so a notice of its pages is known to be its own", async () => {
    const response = await get(`https://answers.joespizza.example/${INDEXNOW_KEY}.txt`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEXNOW_KEY);
  });
});

describe("a host that is not a live answer subdomain", () => {
  it("is answered with nothing at all, whatever is asked", async () => {
    for (const path of [
      "/",
      "/late-night-pizza-in-raleigh",
      "/robots.txt",
      "/sitemap.xml",
      `/${INDEXNOW_KEY}.txt`,
    ]) {
      const response = await get(`https://answers.somebodyelse.example${path}`);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe("Not found");
    }
  });

  it("is handed on untouched when it is one of the zone's own names, such as the app", async () => {
    for (const url of [
      "https://nearcited.com/locations",
      "https://abcdefabcdef.pages.nearcited.com/",
    ]) {
      const response = await get(url);
      expect(await response.text()).toBe("the app");
    }
    expect(passedOn).toEqual([
      "https://nearcited.com/locations",
      "https://abcdefabcdef.pages.nearcited.com/",
    ]);
    expect(asked).toEqual([]);
  });

  it("answers 503 when the database cannot be read, so a crawler comes back", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));
    const response = await get("https://answers.joespizza.example/late-night-pizza-in-raleigh");
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("300");
  });
});

describe("counting who fetches a page", () => {
  const as = (agent: string) =>
    get("https://answers.joespizza.example/late-night-pizza-in-raleigh", {
      headers: { "User-Agent": agent },
    });

  it("counts a fetch by an assistant's fetcher or a search engine's crawler, for the page", async () => {
    await as(
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    );
    await as(
      "Mozilla/5.0 AppleWebKit/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot",
    );
    await as("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)");
    expect(counted()).toEqual([
      {
        host: "answers.joespizza.example",
        path: "/late-night-pizza-in-raleigh",
        fetcher: "claudebot",
      },
      {
        host: "answers.joespizza.example",
        path: "/late-night-pizza-in-raleigh",
        fetcher: "chatgpt-user",
      },
      {
        host: "answers.joespizza.example",
        path: "/late-night-pizza-in-raleigh",
        fetcher: "googlebot",
      },
    ]);
  });

  it("knows each of a maker's fetchers apart", async () => {
    await as("Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)");
    expect(counted().map((call) => (call as { fetcher: string }).fetcher)).toEqual([
      "claude-searchbot",
    ]);
  });

  it("counts nothing for a person's browser, nor for anything but a page", async () => {
    await as("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15");
    for (const path of ["/", "/robots.txt", "/sitemap.xml", "/taken-back", "/nothing-here"]) {
      await get(`https://answers.joespizza.example${path}`, {
        headers: { "User-Agent": "GPTBot/1.1" },
      });
    }
    expect(counted()).toEqual([]);
  });

  it("answers the page all the same when the count cannot be kept", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/record_page_fetch")
        ? new Response("down", { status: 500 })
        : database(input, init),
    );
    const response = await as("GPTBot/1.1");
    expect(response.status).toBe(200);
  });
});

describe("a subdomain winding down", () => {
  it("sends every visitor on to the business's own site, for now, since the plan may come back", async () => {
    const response = await get("https://answers.joespizza.example/wound-down");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://www.joespizza.example/");
  });
});
