import { describe, expect, it } from "vitest";
import { deriveRecommendations } from "../src/recommendations";
import type { SiteCheck } from "../src/schemas";
import { analyzeSite, blockedCrawlers, type SiteSnapshot, visibleText } from "../src/site";

const filler = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
const jsonLd = (data: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

const goodPage = `<!doctype html><html><head>
  <title>Joe&#39;s Pizza | Raleigh, NC</title>
  ${jsonLd({ "@type": "Restaurant", name: "Joe's Pizza", address: { addressLocality: "Raleigh" } })}
  <style>.x { color: red }</style>
</head><body>
  <h1>Joe&rsquo;s Pizza</h1><p>Thin-crust pies in downtown Raleigh since 1998. ${filler}</p>
  <script>window.app = "Tony's Slice House";</script>
</body></html>`;

const snapshot = (change: Partial<SiteSnapshot> = {}): SiteSnapshot => ({
  url: "https://joes.example/",
  status: 200,
  html: goodPage.replace("&rsquo;", "'"),
  robots_txt: null,
  noindex_header: false,
  ...change,
});

const joes = { name: "Joe's Pizza", city: "Raleigh" };
const failed = (check: SiteCheck) =>
  check.checks.filter((item) => !item.passed).map((item) => item.id);

describe("visibleText", () => {
  it("keeps what a reader sees with scripts off", () => {
    expect(
      visibleText(
        "<p>Fish &amp; chips&nbsp;&#8212; open</p><!-- hidden --><script>var a = '<p>no</p>';</script><style>p{}</style><noscript>Call us</noscript>",
      ),
    ).toBe("Fish & chips — open Call us");
  });
});

describe("blockedCrawlers", () => {
  it("allows everything when nothing is disallowed", () => {
    expect(blockedCrawlers("User-agent: *\nDisallow:\n")).toEqual([]);
    expect(blockedCrawlers("User-agent: *\nDisallow: /admin\n")).toEqual([]);
    expect(blockedCrawlers("")).toEqual([]);
  });

  it("finds every crawler shut out by a blanket rule", () => {
    // Written out, not read from ANSWER_CRAWLERS: these are the names the vendors publish.
    expect(blockedCrawlers("User-agent: *\nDisallow: /\n")).toEqual([
      "OAI-SearchBot",
      "Claude-SearchBot",
      "Claude-User",
      "PerplexityBot",
    ]);
  });

  it("follows the group that names a crawler, not the blanket one", () => {
    const robots = [
      "# keep the answer bots out",
      "User-agent: OAI-SearchBot",
      "User-agent: claude-searchbot",
      "Disallow: /   # all of it",
      "",
      "User-agent: PerplexityBot",
      "Allow: /",
      "",
      "User-agent: *",
      "Disallow: /",
      "Allow: /",
    ].join("\r\n");
    expect(blockedCrawlers(robots)).toEqual(["OAI-SearchBot", "Claude-SearchBot"]);
  });

  it("does not count a crawler that only gathers training data", () => {
    expect(blockedCrawlers("User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n")).toEqual([]);
  });

  it("does not count a fetcher whose vendor says robots.txt may not apply to it", () => {
    const robots = "User-agent: ChatGPT-User\nUser-agent: Perplexity-User\nDisallow: /\n";
    expect(blockedCrawlers(robots)).toEqual([]);
  });
});

describe("analyzeSite", () => {
  it("passes a page that says who and where the business is", () => {
    const check = analyzeSite(snapshot(), joes);
    expect(failed(check)).toEqual([]);
    expect(check.checks.map((item) => item.id)).toEqual([
      "reachable",
      "crawlers_allowed",
      "indexable",
      "text_content",
      "names_business",
      "names_city",
      "structured_data",
    ]);
    expect(check.words).toBeGreaterThan(60);
  });

  it("reports only that the page did not load when it did not", () => {
    const check = analyzeSite(snapshot({ html: null, status: 503 }), joes);
    expect(check).toMatchObject({ status: 503, checks: [{ id: "reachable", passed: false }] });
  });

  it("notices a page that is empty until scripts run", () => {
    const shell = `<html><head><title>Joe's Pizza Raleigh</title></head><body><div id="root"></div><script>render("Joe's Pizza in Raleigh ${filler}")</script></body></html>`;
    expect(failed(analyzeSite(snapshot({ html: shell }), joes))).toEqual([
      "text_content",
      "structured_data",
    ]);
  });

  it("looks for the name and the city in the text, not in scripts", () => {
    const page = `<html><body><img alt="" src="logo.png"><p>${filler}</p><script>var name = "Joe's Pizza Raleigh"</script></body></html>`;
    expect(failed(analyzeSite(snapshot({ html: page }), joes))).toEqual([
      "names_business",
      "names_city",
      "structured_data",
    ]);
  });

  it("matches the name the way answers are matched, and skips the city when none is on file", () => {
    const page = `<html><body><p>JOES PIZZA, LLC welcomes you. ${filler}</p></body></html>`;
    const check = analyzeSite(snapshot({ html: page }), { name: "Joe's Pizza", city: null });
    expect(failed(check)).toEqual(["structured_data"]);
    expect(check.checks.map((item) => item.id)).not.toContain("names_city");
  });

  it("reads a noindex from the page or from the response", () => {
    const meta = goodPage.replace(
      "<title>",
      '<meta content="NOINDEX, follow" name="robots"><title>',
    );
    expect(failed(analyzeSite(snapshot({ html: meta }), joes))).toEqual(["indexable"]);
    expect(failed(analyzeSite(snapshot({ noindex_header: true }), joes))).toEqual(["indexable"]);
    const other = goodPage.replace("<title>", '<meta name="description" content="noindex"><title>');
    expect(failed(analyzeSite(snapshot({ html: other }), joes))).toEqual([]);
  });

  it("names the crawlers a robots.txt shuts out", () => {
    const check = analyzeSite(
      snapshot({ robots_txt: "User-agent: Claude-User\nDisallow: /\n" }),
      joes,
    );
    expect(failed(check)).toEqual(["crawlers_allowed"]);
    expect(check.blocked_crawlers).toEqual(["Claude-User"]);
  });

  it("accepts structured data nested in a graph, and ignores a broken block", () => {
    const graph = jsonLd({
      "@graph": [
        { "@type": "WebSite", name: "Site" },
        { name: "Joe's Pizza", address: "1 Main St" },
      ],
    });
    const page = (block: string) =>
      `<html><body><p>Joe's Pizza Raleigh ${filler}</p>${block}</body></html>`;
    expect(failed(analyzeSite(snapshot({ html: page(graph) }), joes))).toEqual([]);
    expect(
      failed(
        analyzeSite(snapshot({ html: page(jsonLd({ "@type": "WebSite", name: "Site" })) }), joes),
      ),
    ).toEqual(["structured_data"]);
    expect(
      failed(
        analyzeSite(
          snapshot({ html: page('<script type="application/ld+json">{ not json</script>') }),
          joes,
        ),
      ),
    ).toEqual(["structured_data"]);
  });
});

describe("recommendations from the site check", () => {
  const location = { name: "Joe's Pizza", website: "https://joes.example", google_place_id: "p" };
  const rules = (site: SiteCheck | null) =>
    deriveRecommendations(location, [], site).map((recommendation) => recommendation.rule);

  it("makes one per failed check and none for a pass", () => {
    const check = analyzeSite(
      snapshot({ robots_txt: "User-agent: *\nDisallow: /\n", noindex_header: true }),
      joes,
    );
    expect(rules(check)).toEqual(["site:crawlers_allowed", "site:indexable"]);
    const [blocked] = deriveRecommendations(location, [], check);
    expect(blocked?.title).toBe("Your website tells assistants to stay out");
    expect(blocked?.detail).toContain("Blocked: OAI-SearchBot, Claude-SearchBot");
  });

  it("clears when the page passes, and says nothing when the page was not checked", () => {
    expect(rules(analyzeSite(snapshot(), joes))).toEqual([]);
    expect(rules(null)).toEqual([]);
  });

  it("says only that the site could not be read when it could not", () => {
    expect(rules(analyzeSite(snapshot({ html: null, status: null }), joes))).toEqual([
      "site:reachable",
    ]);
  });
});

describe("hostile pages", () => {
  it("reads a page built to be slow to parse in time that grows with its length", () => {
    const start = performance.now();
    for (const piece of [
      "<!--",
      "<script",
      '<script type="application/ld+json">',
      "<title",
      "<",
      "&#",
    ]) {
      const check = analyzeSite(snapshot({ html: piece.repeat(120_000) }), joes);
      expect(check.checks.find((item) => item.id === "reachable")?.passed).toBe(true);
    }
    blockedCrawlers("#".repeat(600_000));
    blockedCrawlers("User-agent:".repeat(60_000));
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it("copes with tags and blocks that never close", () => {
    expect(visibleText("Open <b>bold <!-- never closed")).toBe("Open bold");
    expect(visibleText("Before <script>var a = 1;")).toBe("Before");
    expect(visibleText("Text <unclosed")).toBe("Text");
  });
});
