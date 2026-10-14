import { describe, expect, it } from "vitest";
import { ALLOWANCE_KINDS } from "../src/allowances";
import { VISIT_ASSISTANTS, VisitSentSchema } from "../src/schemas";
import {
  ASSISTANT_REFERRERS,
  assistantOf,
  checkAddress,
  LINE_CHECK,
  lineToPaste,
  VISIT_ASSISTANT_LABELS,
  VISITS_ALLOWANCE,
} from "../src/visits";

const KEY = "0123456789abcdef0123456789abcdef";

describe("the assistant a visit came from", () => {
  it("is the one whose site the visitor's browser names", () => {
    expect(assistantOf({ referrer: "chatgpt.com", tag: null })).toBe("chatgpt");
    expect(assistantOf({ referrer: "chat.openai.com", tag: null })).toBe("chatgpt");
    expect(assistantOf({ referrer: "gemini.google.com", tag: null })).toBe("gemini");
    expect(assistantOf({ referrer: "perplexity.ai", tag: null })).toBe("perplexity");
    expect(assistantOf({ referrer: "copilot.microsoft.com", tag: null })).toBe("copilot");
    expect(assistantOf({ referrer: "claude.ai", tag: null })).toBe("claude");
  });

  it("takes a subdomain for its site, however the host is written", () => {
    expect(assistantOf({ referrer: "www.perplexity.ai", tag: null })).toBe("perplexity");
    expect(assistantOf({ referrer: " WWW.Perplexity.AI. ", tag: null })).toBe("perplexity");
  });

  it("is nobody for a search, a site that only ends the same way, or no site at all", () => {
    for (const referrer of [
      // An AI Overview and AI Mode arrive as any search does, and so does Copilot inside Bing.
      "google.com",
      "www.google.com",
      "bing.com",
      "microsoft.com",
      "notchatgpt.com",
      "chatgpt.com.example",
      "claude.ai.example.com",
      "",
      null,
    ]) {
      expect(assistantOf({ referrer, tag: null }), String(referrer)).toBeNull();
    }
  });

  it("is ChatGPT for an address carrying its tag where no site is named", () => {
    expect(assistantOf({ referrer: null, tag: "chatgpt.com" })).toBe("chatgpt");
    expect(assistantOf({ referrer: "", tag: " ChatGPT.com " })).toBe("chatgpt");
    for (const tag of ["chatgpt", "perplexity", "newsletter", "claude.ai", "", null]) {
      expect(assistantOf({ referrer: null, tag }), String(tag)).toBeNull();
    }
  });

  it("believes the site named over a tag: a tagged link posted elsewhere arrives from elsewhere", () => {
    expect(assistantOf({ referrer: "facebook.com", tag: "chatgpt.com" })).toBeNull();
    expect(assistantOf({ referrer: "google.com", tag: "chatgpt.com" })).toBeNull();
    expect(assistantOf({ referrer: "perplexity.ai", tag: "chatgpt.com" })).toBe("perplexity");
  });
});

describe("the list of what each assistant's visits carry", () => {
  it("has every assistant, each with a name and a site of its own", () => {
    expect(Object.keys(ASSISTANT_REFERRERS).sort()).toEqual([...VISIT_ASSISTANTS].sort());
    const hosts = VISIT_ASSISTANTS.flatMap((assistant) => ASSISTANT_REFERRERS[assistant].hosts);
    expect(new Set(hosts).size).toBe(hosts.length);
    for (const assistant of VISIT_ASSISTANTS) {
      expect(VISIT_ASSISTANT_LABELS[assistant], assistant).toMatch(/^[A-Z]/);
      expect(ASSISTANT_REFERRERS[assistant].hosts.length, assistant).toBeGreaterThan(0);
    }
  });

  it("names hosts and tags as they are compared: small letters, no address around them", () => {
    for (const { hosts, tags } of Object.values(ASSISTANT_REFERRERS)) {
      for (const host of hosts) expect(host).toMatch(/^([a-z0-9-]+\.)+[a-z]{2,}$/);
      for (const tag of tags) expect(tag).toBe(tag.trim().toLowerCase());
    }
  });

  it("leaves out every site a search arrives from", () => {
    for (const { hosts } of Object.values(ASSISTANT_REFERRERS)) {
      for (const host of hosts) {
        expect(["google.com", "www.google.com", "bing.com", "duckduckgo.com"]).not.toContain(host);
      }
    }
  });
});

describe("what the line sends", () => {
  it("is a visit: the site's key, where it came from and the page", () => {
    const visit = { key: KEY, referrer: "chatgpt.com", tag: null, path: "/menu" };
    expect(VisitSentSchema.parse(visit)).toEqual(visit);
    expect(VisitSentSchema.parse({ ...visit, referrer: null, tag: "chatgpt.com" })).toEqual({
      ...visit,
      referrer: null,
      tag: "chatgpt.com",
    });
  });

  it("or a check, which carries the key and nothing else", () => {
    expect(
      VisitSentSchema.parse({ key: KEY, check: true, referrer: "chatgpt.com", path: "/" }),
    ).toEqual({ key: KEY, check: true });
  });

  it("is refused without a key of the right form, or with a page that is not a path", () => {
    const visit = { key: KEY, referrer: "chatgpt.com", tag: null, path: "/menu" };
    for (const bad of [
      { ...visit, key: "abc" },
      { ...visit, key: KEY.toUpperCase() },
      { ...visit, key: `${KEY}0` },
      { ...visit, path: "menu" },
      { ...visit, path: "https://joes.example/menu" },
      { ...visit, path: `/${"a".repeat(2000)}` },
      { ...visit, referrer: "a".repeat(254) },
      { key: KEY, check: false },
      { key: KEY },
      {},
      null,
      "visit",
    ]) {
      expect(VisitSentSchema.safeParse(bad).success, JSON.stringify(bad)?.slice(0, 60)).toBe(false);
    }
  });
});

describe("the line an owner pastes", () => {
  it("is one script tag, loaded from where the product is served and carrying the key", () => {
    expect(lineToPaste("https://nearcited.example", KEY)).toBe(
      `<script async src="https://nearcited.example/line.js" data-site="${KEY}"></script>`,
    );
    expect(lineToPaste("https://nearcited.example/", KEY)).toBe(
      lineToPaste("https://nearcited.example", KEY),
    );
    expect(lineToPaste("http://localhost:5173", KEY)).toContain(
      'src="http://localhost:5173/line.js"',
    );
    // Whatever follows the host in where the product is served, the script is at its root.
    expect(lineToPaste(`https://nearcited.example${"/".repeat(5000)}`, KEY)).toBe(
      lineToPaste("https://nearcited.example", KEY),
    );
    expect(lineToPaste("https://nearcited.example/app/", KEY)).toBe(
      lineToPaste("https://nearcited.example", KEY),
    );
  });
});

describe("the address an owner opens to check the line", () => {
  it("is the website on file, marked as a check", () => {
    expect(checkAddress("https://joes.example")).toBe(`https://joes.example/#${LINE_CHECK}`);
    expect(checkAddress("https://joes.example/raleigh?ref=1#menu")).toBe(
      `https://joes.example/raleigh?ref=1#${LINE_CHECK}`,
    );
  });

  it("is nothing where no address is on file", () => {
    expect(checkAddress(null)).toBeNull();
    expect(checkAddress("")).toBeNull();
    expect(checkAddress("joes pizza")).toBeNull();
  });
});

describe("the allowance for visits", () => {
  it("is a kind a plan includes or does not, with no number", () => {
    expect(ALLOWANCE_KINDS[VISITS_ALLOWANCE]?.counted).toBe(false);
  });
});
