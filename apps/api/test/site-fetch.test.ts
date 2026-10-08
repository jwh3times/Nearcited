import { describe, expect, it } from "vitest";
import { fetchSite, SITE_USER_AGENT, safeSiteUrl } from "../src/site/fetch";

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
    expect(new Headers(calls[0]?.init?.headers).get("User-Agent")).toBe(SITE_USER_AGENT);
    expect(calls[0]?.init?.redirect).toBe("manual");
  });

  it("follows redirects, and reads robots.txt from where it ended up", async () => {
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
    expect(calls.at(-1)?.url).toBe("https://www.joes.example/robots.txt");
  });

  it("will not follow a redirect to an address it would refuse", async () => {
    const { impl, calls } = fakeFetch({
      "https://joes.example/": { status: 302, headers: { Location: "http://169.254.169.254/" } },
    });
    expect(await fetchSite("joes.example", impl)).toMatchObject({ html: null, status: null });
    expect(calls).toHaveLength(1);
  });

  it("gives up on a redirect loop", async () => {
    const { impl, calls } = fakeFetch({
      "https://joes.example/": { status: 302, headers: { Location: "https://joes.example/" } },
    });
    expect((await fetchSite("joes.example", impl)).html).toBeNull();
    expect(calls.length).toBeLessThanOrEqual(5);
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
    expect(calls).toHaveLength(2);
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

  it("treats an unreadable robots.txt as no robots.txt", async () => {
    const { impl } = fakeFetch({
      "https://joes.example/": { body: "<html></html>" },
      "https://joes.example/robots.txt": new Error("timeout"),
    });
    expect(await fetchSite("joes.example", impl)).toMatchObject({
      html: "<html></html>",
      robots_txt: null,
    });
  });
});
