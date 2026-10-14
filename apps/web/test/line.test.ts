import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASSISTANT_REFERRERS,
  assistantOf,
  LINE_CHECK,
  VISIT_ASSISTANTS,
  VisitSentSchema,
} from "@nearcited/shared";
import { describe, expect, it } from "vitest";

/** The line as a site loads it: one file, served as it is written. */
const source = readFileSync(join(import.meta.dirname, "../public/line.js"), "utf8");

const KEY = "0123456789abcdef0123456789abcdef";
const SCRIPT = "https://nearcited.example/line.js";

interface Arrival {
  /** The address the visitor's browser says it came from. */
  from?: string;
  /** The page landed on. */
  on?: string;
  /** How the browser says the page was reached. Null where it does not say. */
  how?: "navigate" | "reload" | "back_forward" | null;
  framed?: boolean;
  key?: string | null;
  /** The line is on the page a second time, and this is the second. */
  again?: boolean;
}

interface Sent {
  to: string;
  init: Record<string, unknown>;
  body: unknown;
}

/** Runs the line as a page would, and says what it posted. */
function arrive({
  from = "",
  on = "https://joes.example/menu",
  how = "navigate",
  framed = false,
  key = KEY,
  again = false,
}: Arrival = {}): Sent[] {
  const sent: Sent[] = [];
  const window: Record<string, unknown> = { location: new URL(on) };
  window.self = window;
  window.top = framed ? {} : window;
  if (again) window.nearcitedLine = true;
  const document = {
    referrer: from,
    currentScript: {
      src: SCRIPT,
      getAttribute: (name: string) => (name === "data-site" ? key : null),
    },
  };
  const performance = { getEntriesByType: () => (how ? [{ type: how }] : []) };
  const fetch = (to: unknown, init: Record<string, unknown>) => {
    sent.push({ to: String(to), init, body: JSON.parse(String(init.body)) });
    return Promise.resolve();
  };
  new Function("window", "document", "performance", "fetch", source)(
    window,
    document,
    performance,
    fetch,
  );
  return sent;
}

describe("the line on a business's site", () => {
  it("reports a visit that arrived from an assistant: the key, its host and the page", () => {
    const [report, ...more] = arrive({ from: "https://chatgpt.com/" });
    expect(more).toEqual([]);
    expect(report?.body).toEqual({ key: KEY, referrer: "chatgpt.com", tag: null, path: "/menu" });
    // To the product the script came from, as a post that carries no cookie and waits on nothing.
    expect(report?.to).toBe("https://nearcited.example/api/visits");
    expect(report?.init).toMatchObject({
      method: "POST",
      mode: "no-cors",
      credentials: "omit",
      referrerPolicy: "origin",
      keepalive: true,
    });
    expect(VisitSentSchema.safeParse(report?.body).success).toBe(true);
  });

  it("reports every site the product's list names, and a subdomain of one", () => {
    for (const assistant of VISIT_ASSISTANTS) {
      for (const host of ASSISTANT_REFERRERS[assistant].hosts) {
        for (const from of [`https://${host}/`, `https://www.${host}/some/page`]) {
          const [report] = arrive({ from });
          expect(report, from).toBeDefined();
          expect(assistantOf(report?.body as never), from).toBe(assistant);
        }
      }
    }
  });

  it("holds the same list as the product, and no other", () => {
    const [, written] = /\/\/ list:start\s+const ASSISTANTS = (\{[\s\S]*?\});\s+\/\/ list:end/.exec(
      source,
    ) ?? [null, ""];
    expect(written).not.toBe("");
    expect(new Function(`return ${written}`)()).toEqual(ASSISTANT_REFERRERS);
  });

  it("says nothing about any other visit", () => {
    for (const from of [
      "",
      // A search, an AI Overview and AI Mode all arrive the same way.
      "https://www.google.com/",
      "https://www.bing.com/search?q=pizza",
      "https://duckduckgo.com/",
      "https://www.facebook.com/",
      // The visitor's own last page on this site.
      "https://joes.example/",
      "https://notchatgpt.com/",
      "https://chatgpt.com.elsewhere.example/",
      "not an address",
    ]) {
      expect(arrive({ from }), from).toEqual([]);
    }
  });

  it("agrees with the product about which visits came from an assistant", () => {
    const froms = [
      "",
      "https://chatgpt.com/",
      "https://www.perplexity.ai/search/abc",
      "https://www.google.com/",
      "https://www.facebook.com/",
      "https://joes.example/",
    ];
    const tags = [null, "chatgpt.com", "ChatGPT.com", "perplexity", "newsletter", ""];
    for (const from of froms) {
      for (const tag of tags) {
        const on = `https://joes.example/menu${tag === null ? "" : `?utm_source=${tag}`}`;
        const expected = assistantOf({ referrer: from ? new URL(from).hostname : null, tag });
        const [report] = arrive({ from, on });
        expect(
          report === undefined ? null : assistantOf(report.body as never),
          `${from} ${tag}`,
        ).toBe(expected);
      }
    }
  });

  it("reports a visit out of ChatGPT's app, which names no site and carries a tag", () => {
    const [report] = arrive({ on: "https://joes.example/menu?utm_source=chatgpt.com" });
    expect(report?.body).toEqual({ key: KEY, referrer: null, tag: "chatgpt.com", path: "/menu" });
    // The tag does not count where the browser names somewhere else.
    expect(
      arrive({
        from: "https://www.facebook.com/",
        on: "https://joes.example/?utm_source=chatgpt.com",
      }),
    ).toEqual([]);
  });

  it("sends the host a visitor came from and the path they landed on, and nothing around either", () => {
    const [report] = arrive({
      from: "https://www.perplexity.ai/search/why-does-my-knee-hurt-a1b2c3?session=xyz",
      on: "https://joes.example/book/table?email=someone@example.com&utm_source=spring-offer#confirm",
    });
    expect(report?.body).toEqual({
      key: KEY,
      referrer: "www.perplexity.ai",
      tag: null,
      path: "/book/table",
    });
    const posted = JSON.stringify(report);
    for (const kept of ["knee", "session", "someone", "spring-offer", "confirm"]) {
      expect(posted, kept).not.toContain(kept);
    }
  });

  it("counts an arrival once: not a reload, a step back, or a second copy of the line", () => {
    const from = "https://claude.ai/";
    expect(arrive({ from, how: "reload" })).toEqual([]);
    expect(arrive({ from, how: "back_forward" })).toEqual([]);
    expect(arrive({ from, again: true })).toEqual([]);
    // A browser that does not say how the page was reached is taken to have arrived.
    expect(arrive({ from, how: null })).toHaveLength(1);
  });

  it("does nothing inside a frame, or without the site's key", () => {
    const from = "https://chatgpt.com/";
    expect(arrive({ from, framed: true })).toEqual([]);
    expect(arrive({ from, key: null })).toEqual([]);
    expect(arrive({ from, key: "" })).toEqual([]);
  });

  it("reports a check when the owner opens the site to look for it, and never as a visit", () => {
    const on = `https://joes.example/#${LINE_CHECK}`;
    for (const arrival of [
      { on },
      { on, from: "https://nearcited.example/" },
      // Even where the owner happened to arrive from an assistant, or looked twice.
      { on, from: "https://chatgpt.com/" },
      { on, how: "reload" as const },
    ]) {
      const [report, ...more] = arrive(arrival);
      expect(report?.body).toEqual({ key: KEY, check: true });
      expect(more).toEqual([]);
    }
    expect(arrive({ on, framed: true })).toEqual([]);
    expect(arrive({ on: "https://joes.example/#menu" })).toEqual([]);
  });

  it("keeps nothing in the browser", () => {
    for (const store of ["cookie", "localStorage", "sessionStorage", "indexedDB", "caches"]) {
      expect(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), store).not.toContain(store);
    }
  });

  it("is never the site's problem", () => {
    const broken = (globals: Record<string, unknown>) => () =>
      new Function("window", "document", "performance", "fetch", source)(
        globals.window,
        globals.document,
        globals.performance,
        globals.fetch,
      );
    const window: Record<string, unknown> = { location: new URL("https://joes.example/") };
    window.self = window;
    window.top = window;
    const document = {
      referrer: "https://chatgpt.com/",
      currentScript: { src: SCRIPT, getAttribute: () => KEY },
    };
    // No way to ask how the page was reached, and no way to post.
    expect(broken({ window, document, performance: {}, fetch: undefined })).not.toThrow();
    expect(broken({ window: {}, document: {}, performance: {}, fetch: undefined })).not.toThrow();
  });
});
