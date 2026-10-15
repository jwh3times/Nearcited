import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_WORDS,
  CONNECT_STEPS,
  forgetStarted,
  noteStarted,
  passwordsNote,
  startedFrom,
  takeHandedBack,
} from "../src/lib/wordpress";

let kept: Map<string, string>;
let replaced: string[];

beforeEach(() => {
  kept = new Map();
  replaced = [];
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => kept.set(key, value),
    removeItem: (key: string) => kept.delete(key),
  });
  vi.stubGlobal("window", {
    history: { replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url) },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const at = (pathname: string, search: string) => ({ pathname, search }) as Location;

describe("what WordPress hands back", () => {
  it("is the site, the user and the password, taken off the address at once", () => {
    expect(
      takeHandedBack(
        at(
          "/wordpress/return",
          "?state=abc&site_url=https%3A%2F%2Fjoes.example&user_login=owner&password=abcd+EFGH+1234",
        ),
      ),
    ).toEqual({
      kind: "approved",
      state: "abc",
      approved: {
        site_url: "https://joes.example",
        user_login: "owner",
        password: "abcd EFGH 1234",
      },
    });
    expect(replaced).toEqual(["/wordpress/return"]);
  });

  it("is a no where the owner said no, however WordPress says it", () => {
    expect(takeHandedBack(at("/wordpress/return", "?state=abc&declined=1"))).toEqual({
      kind: "declined",
      state: "abc",
    });
    expect(takeHandedBack(at("/wordpress/return", "?state=abc&success=false"))).toEqual({
      kind: "declined",
      state: "abc",
    });
  });

  it("is nothing on any other page, or without all of it", () => {
    expect(takeHandedBack(at("/locations/x", "?password=secret"))).toEqual({ kind: "nothing" });
    // Another page's address is not touched.
    expect(replaced).toEqual([]);
    expect(
      takeHandedBack(at("/wordpress/return", "?state=abc&site_url=https%3A%2F%2Fjoes.example")),
    ).toEqual({ kind: "nothing" });
    expect(replaced).toEqual(["/wordpress/return"]);
  });
});

describe("knowing this tab started it", () => {
  it("believes the code it noted, for the location it noted, until it is forgotten", () => {
    const state = noteStarted("loc-1");
    expect(state).toMatch(/^[0-9a-f-]{36}$/);
    expect(startedFrom("someone else's")).toBeNull();
    expect(startedFrom(state ?? "")).toBe("loc-1");
    forgetStarted();
    expect(startedFrom(state ?? "")).toBeNull();
  });

  it("starts nothing where the browser keeps nothing", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    expect(noteStarted("loc-1")).toBeNull();
    expect(startedFrom("anything")).toBeNull();
    expect(() => forgetStarted()).not.toThrow();
  });
});

describe("what the owner is told", () => {
  it("quotes WordPress's own screen, and says where the access is taken away", () => {
    expect(CONNECT_STEPS.join(" ")).toContain("“Authorize Application”");
    expect(CONNECT_STEPS.join(" ")).toContain("“Yes, I approve of this connection”");
    expect(CONNECT_STEPS.join(" ")).toContain("Users, Profile, Application Passwords");
  });

  it("has a sentence for each way the site cannot be connected, and a note to forward", () => {
    for (const verdict of [
      "not_wordpress",
      "passwords_off",
      "unreachable",
      "no_website",
    ] as const) {
      expect(CHECK_WORDS[verdict].length, verdict).toBeGreaterThan(20);
    }
    expect(passwordsNote("https://joes.example")).toContain("https://joes.example");
    expect(passwordsNote("https://joes.example")).toContain(
      "developer.wordpress.org/advanced-administration/security/application-passwords/",
    );
  });
});
