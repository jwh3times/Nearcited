import { describe, expect, it } from "vitest";
import { robotsAllows } from "../src/robots";

const elsewhere = (robots: string, path: string) => robotsAllows(robots, path, { ownSite: false });
const own = (robots: string, path: string) => robotsAllows(robots, path, { ownSite: true });

describe("robotsAllows", () => {
  it("allows everything with no rules, an empty file or an empty Disallow", () => {
    expect(elsewhere("", "/biz/joes-pizza")).toBe(true);
    expect(elsewhere("User-agent: *\nDisallow:\n", "/biz/joes-pizza")).toBe(true);
    expect(elsewhere("# nothing here\n", "/")).toBe(true);
  });

  it("follows the * group on someone else's site when none names NearcitedBot", () => {
    expect(elsewhere("User-agent: *\nDisallow: /\n", "/biz/joes-pizza")).toBe(false);
    expect(elsewhere("User-agent: *\nDisallow: /search\n", "/biz/joes-pizza")).toBe(true);
    expect(elsewhere("User-agent: *\nDisallow: /search\n", "/search?q=pizza")).toBe(false);
  });

  it("on the business's own site follows only a group that names NearcitedBot", () => {
    expect(own("User-agent: *\nDisallow: /\n", "/")).toBe(true);
    expect(own("User-agent: NearcitedBot\nDisallow: /\n", "/")).toBe(false);
  });

  it("follows the group that names NearcitedBot over the * group, whatever the case", () => {
    const robots = "User-agent: *\nDisallow: /\n\nUser-agent: nearcitedbot\nAllow: /\n";
    expect(elsewhere(robots, "/biz/joes-pizza")).toBe(true);
    const shut = "User-agent: *\nAllow: /\n\nUser-Agent: NEARCITEDBOT\nDisallow: /biz/\n";
    expect(elsewhere(shut, "/biz/joes-pizza")).toBe(false);
    expect(elsewhere(shut, "/about")).toBe(true);
  });

  it("reads agent lines in a row as one group, and merges groups for the same agent", () => {
    const shared = "User-agent: Googlebot\nUser-agent: NearcitedBot\nDisallow: /private\n";
    expect(elsewhere(shared, "/private/page")).toBe(false);
    const split =
      "User-agent: NearcitedBot\nDisallow: /a\n\nUser-agent: Other\nDisallow: /\n\nUser-agent: NearcitedBot\nDisallow: /b\n";
    expect(elsewhere(split, "/a/1")).toBe(false);
    expect(elsewhere(split, "/b/1")).toBe(false);
    expect(elsewhere(split, "/c/1")).toBe(true);
  });

  it("lets the longest matching rule win, and an Allow win a tie", () => {
    const robots = "User-agent: *\nDisallow: /biz\nAllow: /biz/joes\n";
    expect(elsewhere(robots, "/biz/joes-pizza")).toBe(true);
    expect(elsewhere(robots, "/biz/marios")).toBe(false);
    const tie = "User-agent: *\nDisallow: /biz\nAllow: /biz\n";
    expect(elsewhere(tie, "/biz/joes")).toBe(true);
  });

  it("reads * as any run of characters and $ as the end of the path", () => {
    const robots = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /*/reviews\n";
    expect(elsewhere(robots, "/menu.pdf")).toBe(false);
    expect(elsewhere(robots, "/menu.pdf?download=1")).toBe(true);
    expect(elsewhere(robots, "/biz/joes/reviews")).toBe(false);
    expect(elsewhere(robots, "/biz/joes")).toBe(true);
  });

  it("always allows robots.txt itself", () => {
    expect(elsewhere("User-agent: *\nDisallow: /\n", "/robots.txt")).toBe(true);
  });

  it("ignores comments, unknown lines and rules before any agent", () => {
    const robots =
      "Disallow: /\nSitemap: https://example.com/sitemap.xml\nUser-agent: * # everyone\nDisallow: /x # not here\nCrawl-delay: 10\n";
    expect(elsewhere(robots, "/biz")).toBe(true);
    expect(elsewhere(robots, "/x/1")).toBe(false);
  });

  it("matches a pattern built to be slow in time that grows with its length", () => {
    const robots = `User-agent: *\nDisallow: /${"*a".repeat(2_000)}b\n`;
    const started = performance.now();
    expect(elsewhere(robots, `/${"a".repeat(5_000)}`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
