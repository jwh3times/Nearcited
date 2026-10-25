import { describe, expect, it } from "vitest";
import { fetchCitedPages, fetchSite, SITE_USER_AGENT, safeSiteUrl } from "../src/site/fetch";

type Answer = { status?: number; body?: string; headers?: Record<string, string> } | Error;

/** A fetch that answers by URL and records what was asked. */
function fakeFetch(pages: Record<string, Answer>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const answer = pages[url];
    if (!answer) return new Response("not found", { status: 404 });
    if (answer instanceof Error) throw answer;
    return new Response(answer.body ?? "", {
      status: answer.status ?? 200,
      headers: { "Content-Type": "text/html; charset=utf-8", ...answer.headers },
    });
  }) as typeof fetch;
  return { impl, calls };
}

describe("safeSiteUrl", () => {
  it("accepts a web address, with or without the scheme", () => {
    expect(safeSiteUrl("joes.example")?.href).toBe("https://joes.example/");
    expect(safeSiteUrl("http://www.joes.example/menu#top")?.href).toBe(
      "http://www.joes.example/menu",
    );
  });

  it("refuses anything that is not a public web address", () => {
    for (const address of [
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://localhost/",
      "http://intranet/",
      "http://db.internal/",
      "http://printer.local/",
      "https://joes.example:8443/",
      "https://user:pass@joes.example/",
      "ftp://joes.example/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "",
    ]) {
      expect(safeSiteUrl(address), address).toBeNull();
    }
  });
});

describe("fetchSite", () => {
  it("returns the page and its robots.txt, identifying itself", async () => {
    const { impl, calls } = fakeFetch({
      "https://joes.example/": { body: "<html>Joe's</html>" },
      "https://joes.example/robots.txt": { body: "User-agent: *\nDisallow:\n" },
    });
    expect(await fetchSite("joes.example", impl)).toEqual({
      url: "https://joes.example/",
      status: 200,
      html: "<html>Joe's</html>",
      robots_txt: "User-agent: *\nDisallow:\n",
      noindex_header: false,
    });
    // robots.txt first: what it says decides whether the page is asked for at all.
    expect(calls.map((call) => call.url)).toEqual([
      "https://joes.example/robots.txt",
      "https://joes.example/",
    ]);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get("User-Agent")).toBe(SITE_USER_AGENT);
      expect(call.init?.redirect).toBe("manual");
    }
  });

  it("follows redirects, reading robots.txt at each host before asking it for a page", async () => {
    const { impl, calls } = fakeFetch({
      "https://joes.example/": { status: 301, headers: { Location: "https://www.joes.example/" } },
      "https://www.joes.example/": { status: 302, headers: { Location: "/home" } },
      "https://www.joes.example/home": {
        body: "<html>home</html>",
        headers: { "X-Robots-Tag": "noindex" },
      },
    });
    const snapshot = await fetchSite("https://joes.example", impl);
    expect(snapshot).toMatchObject({
      url: "https://www.joes.example/home",
      html: "<html>home</html>",
      robots_txt: null,
      noindex_header: true,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://joes.example/robots.txt",
      "https://joes.example/",
      "https://www.joes.example/robots.txt",
      "https://www.joes.example/",
      "https://www.joes.example/home",
    ]);
  });

  it("will not follow a redirect to an address it would refuse", async () => {
    const { impl, calls } = fakeFetch({
      "https://joes.example/": { status: 302, headers: { Location: "http://169.254.169.254/" } },
    });
    expect(await fetchSite("joes.example", impl)).toMatchObject({ html: null });
    expect(calls.map((call) => call.url)).toEqual([
      "https://joes.example/robots.txt",
      "https://joes.example/",
    ]);
  });

  it("gives up on a redirect loop", async () => {
    const { impl, calls } = fakeFetch({
      "https://joes.example/": { status: 302, headers: { Location: "https://joes.example/" } },
    });
    expect((await fetchSite("joes.example", impl)).html).toBeNull();
    // robots.txt once, then the first try and four redirects.
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  it("never calls an address it refuses", async () => {
    const { impl, calls } = fakeFetch({});
    expect(await fetchSite("http://127.0.0.1/admin", impl)).toMatchObject({ html: null });
    expect(calls).toHaveLength(0);
  });

  it("tries once more when the page does not answer or the server faults", async () => {
    for (const first of [new Error("connection reset"), { status: 503 }, { status: 429 }]) {
      let asked = 0;
      const impl = (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/robots.txt")) return new Response("", { status: 404 });
        asked += 1;
        if (asked === 1) {
          if (first instanceof Error) throw first;
          return new Response("busy", { status: first.status });
        }
        return new Response("<p>Joe's Pizza</p>", { headers: { "Content-Type": "text/html" } });
      }) as typeof fetch;
      expect(await fetchSite("joes.example", impl)).toMatchObject({
        status: 200,
        html: "<p>Joe's Pizza</p>",
      });
      expect(asked).toBe(2);
    }
  });

  it("does not ask again for a page that is not there or turns it away", async () => {
    const { impl, calls } = fakeFetch({ "https://shut.example/": { status: 403 } });
    expect(await fetchSite("gone.example", impl)).toMatchObject({ status: 404, html: null });
    expect(await fetchSite("shut.example", impl)).toMatchObject({ status: 403, html: null });
    expect(calls.filter((call) => !call.url.endsWith("/robots.txt"))).toHaveLength(2);
  });

  it("reports a page that is not there, is not HTML, or does not answer", async () => {
    const { impl } = fakeFetch({
      "https://gone.example/": { status: 404 },
      "https://pdf.example/": { body: "%PDF", headers: { "Content-Type": "application/pdf" } },
      "https://down.example/": new Error("connection reset"),
    });
    expect(await fetchSite("gone.example", impl)).toMatchObject({ status: 404, html: null });
    expect(await fetchSite("pdf.example", impl)).toMatchObject({ status: 200, html: null });
    expect(await fetchSite("down.example", impl)).toMatchObject({ status: null, html: null });
  });

  it("reads no more than its limit of a huge page", async () => {
    const { impl } = fakeFetch({ "https://big.example/": { body: "x".repeat(2_000_000) } });
    expect((await fetchSite("big.example", impl)).html).toHaveLength(600_000);
  });

  it("asks for no page when robots.txt shuts NearcitedBot out by name", async () => {
    const robots = "User-agent: NearcitedBot\nDisallow: /\n\nUser-agent: *\nDisallow: /\n";
    const { impl, calls } = fakeFetch({
      "https://joes.example/robots.txt": {
        body: robots,
        headers: { "Content-Type": "text/plain" },
      },
      "https://joes.example/": { body: "<html></html>" },
    });
    expect(await fetchSite("joes.example", impl)).toMatchObject({
      html: null,
      robots_txt: robots,
      not_read: "shut_out",
    });
    expect(calls).toHaveLength(1);
  });

  it("still reads the business's own site when robots.txt shuts out only the * group", async () => {
    const robots = "User-agent: *\nDisallow: /\n";
    const { impl } = fakeFetch({
      "https://joes.example/robots.txt": { body: robots },
      "https://joes.example/": { body: "<html>Joe's</html>" },
    });
    const snapshot = await fetchSite("joes.example", impl);
    expect(snapshot).toMatchObject({ html: "<html>Joe's</html>", robots_txt: robots });
    expect(snapshot.not_read).toBeUndefined();
  });

  it("obeys the * group on a site read as anyone else's, as an audit reads one", async () => {
    const robots = "User-agent: *\nDisallow: /\n";
    const { impl, calls } = fakeFetch({
      "https://joes.example/robots.txt": { body: robots },
      "https://joes.example/": { body: "<html>Joe's</html>" },
    });
    expect(await fetchSite("joes.example", impl, { ownSite: false })).toMatchObject({
      html: null,
      robots_txt: robots,
      not_read: "shut_out",
    });
    expect(calls).toHaveLength(1);
  });

  it("takes a robots.txt that faults or does not answer as shutting everything", async () => {
    for (const robots of [{ status: 500 }, { status: 503 }, new Error("timeout")]) {
      const { impl, calls } = fakeFetch({
        "https://joes.example/": { body: "<html></html>" },
        "https://joes.example/robots.txt": robots,
      });
      expect(await fetchSite("joes.example", impl)).toMatchObject({
        html: null,
        not_read: "robots_unreadable",
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("takes a robots.txt that is not there as no rules", async () => {
    for (const status of [404, 403, 410]) {
      const { impl } = fakeFetch({
        "https://joes.example/": { body: "<html></html>" },
        "https://joes.example/robots.txt": { status },
      });
      expect(await fetchSite("joes.example", impl)).toMatchObject({
        html: "<html></html>",
        robots_txt: null,
      });
    }
  });
});

describe("fetchCitedPages", () => {
  const listing = { host: "yellowpages.com", url: "https://www.yellowpages.com/raleigh/joes" };

  it("reads robots.txt before the page, and returns the page", async () => {
    const { impl, calls } = fakeFetch({
      "https://www.yellowpages.com/robots.txt": { body: "User-agent: *\nDisallow: /search\n" },
      "https://www.yellowpages.com/raleigh/joes": { body: "<html>Joe's Pizza</html>" },
    });
    expect(await fetchCitedPages([listing], impl)).toEqual([
      {
        host: "yellowpages.com",
        url: "https://www.yellowpages.com/raleigh/joes",
        status: 200,
        html: "<html>Joe's Pizza</html>",
        not_read: null,
      },
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://www.yellowpages.com/robots.txt",
      "https://www.yellowpages.com/raleigh/joes",
    ]);
    expect(new Headers(calls[1]?.init?.headers).get("User-Agent")).toBe(SITE_USER_AGENT);
  });

  it("obeys the * group on someone else's site", async () => {
    const { impl, calls } = fakeFetch({
      "https://www.yellowpages.com/robots.txt": { body: "User-agent: *\nDisallow: /raleigh/\n" },
    });
    expect(await fetchCitedPages([listing], impl)).toMatchObject([
      { html: null, not_read: "shut_out" },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("stops at a robots.txt that faults", async () => {
    const { impl, calls } = fakeFetch({
      "https://www.yellowpages.com/robots.txt": { status: 503 },
    });
    expect(await fetchCitedPages([listing], impl)).toMatchObject([
      { not_read: "robots_unreadable" },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("reads another host's robots.txt before following a redirect to it on the same site", async () => {
    const { impl, calls } = fakeFetch({
      "https://www.yellowpages.com/raleigh/joes": {
        status: 301,
        headers: { Location: "https://m.yellowpages.com/joes" },
      },
      "https://m.yellowpages.com/robots.txt": { body: "User-agent: NearcitedBot\nDisallow: /\n" },
    });
    expect(await fetchCitedPages([listing], impl)).toMatchObject([
      { url: "https://m.yellowpages.com/joes", not_read: "shut_out" },
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://www.yellowpages.com/robots.txt",
      "https://www.yellowpages.com/raleigh/joes",
      "https://m.yellowpages.com/robots.txt",
    ]);
  });

  it("does not follow a redirect off the site that was cited", async () => {
    const { impl, calls } = fakeFetch({
      "https://www.yellowpages.com/raleigh/joes": {
        status: 302,
        headers: { Location: "https://tracker.example/joes" },
      },
    });
    expect(await fetchCitedPages([listing], impl)).toMatchObject([
      { url: "https://tracker.example/joes", not_read: "left_site" },
    ]);
    expect(calls.map((call) => call.url)).not.toContain("https://tracker.example/joes");
    expect(calls.map((call) => call.url)).not.toContain("https://tracker.example/robots.txt");

    // Nor to an address it would refuse, which is off the site too.
    const inside = fakeFetch({
      "https://www.yellowpages.com/raleigh/joes": {
        status: 302,
        headers: { Location: "http://169.254.169.254/" },
      },
    });
    expect(await fetchCitedPages([listing], inside.impl)).toMatchObject([
      { not_read: "left_site", status: 302 },
    ]);
    expect(inside.calls).toHaveLength(2);
  });

  it("says why a page that answered was not read, and asks once", async () => {
    const { impl, calls } = fakeFetch({
      "https://manta.com/joes": { status: 503 },
      "https://bing.com/joes": { body: "%PDF", headers: { "Content-Type": "application/pdf" } },
      "https://nextdoor.com/joes": new Error("connection reset"),
    });
    expect(
      await fetchCitedPages(
        [
          { host: "manta.com", url: "https://manta.com/joes" },
          { host: "bing.com", url: "https://bing.com/joes" },
          { host: "nextdoor.com", url: "https://nextdoor.com/joes" },
          { host: "superpages.com", url: "http://127.0.0.1/joes" },
        ],
        impl,
      ),
    ).toMatchObject([
      { host: "manta.com", not_read: "unreachable", status: 503 },
      { host: "bing.com", not_read: "not_html", status: 200 },
      { host: "nextdoor.com", not_read: "unreachable", status: null },
      { host: "superpages.com", not_read: "unreachable", status: null },
    ]);
    expect(calls.filter((call) => call.url === "https://manta.com/joes")).toHaveLength(1);
    expect(calls.map((call) => call.url)).not.toContain("http://127.0.0.1/joes");
  });

  it("makes no more than thirty requests, and says which pages it did not get to", async () => {
    // Each page costs two requests: robots.txt, then the page.
    const targets = Array.from({ length: 16 }, (_, index) => ({
      host: `site${index}.com`,
      url: `https://site${index}.com/joes`,
    }));
    const pages = Object.fromEntries(
      targets.map((target) => [target.url, { body: "<html>Joe's Pizza</html>" }]),
    );
    const { impl, calls } = fakeFetch(pages);
    const read = await fetchCitedPages(targets, impl);
    expect(calls).toHaveLength(30);
    expect(read.slice(0, 15).every((page) => page.not_read === null)).toBe(true);
    expect(read[15]).toMatchObject({ host: "site15.com", not_read: "over_budget", html: null });
  });
});
