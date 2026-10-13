import { describe, expect, it } from "vitest";
import {
  type DraftGiven,
  draftKindFor,
  draftRequest,
  draftsStanding,
  factsNobodyGave,
} from "../src/drafts";

const joes = {
  name: "Joe's Pizza",
  city: "Raleigh",
  region: "NC",
  primary_category: "Pizza restaurant",
  website: "https://joespizza.example",
  what_we_do: "Wood-fired pizza and fresh pasta, family-run since 1998. We seat 40.",
};
const task = {
  host: "usnews.com",
  url: "https://travel.usnews.com/raleigh/best-pizza-2026",
  draft_kind: "note" as const,
};
const given: DraftGiven = {
  name: joes.name,
  city: joes.city,
  region: joes.region,
  category: joes.primary_category,
  website: joes.website,
  what_we_do: joes.what_we_do,
  host: task.host,
  url: task.url,
};

describe("which tasks have a draft", () => {
  it("is the ones whose work is wording: a note to an author, or a listing's description", () => {
    expect(draftKindFor("editorial")).toBe("note");
    expect(draftKindFor("directory")).toBe("listing");
    // It may not ask for reviews, and its listing still takes a description.
    expect(draftKindFor("reviews_unasked")).toBe("listing");
  });

  it("is not one whose work is asking customers, or one on a site nobody knows", () => {
    expect(draftKindFor("reviews")).toBeNull();
    expect(draftKindFor("unknown")).toBeNull();
  });
});

describe("the draft to write for a task", () => {
  it("is written from what the location holds, what its owner said, and the page", () => {
    expect(draftRequest(joes, task)).toEqual({ kind: "note", given });
  });

  it("carries a detail that is not on file as nothing, never as a guess", () => {
    const bare = { ...joes, region: null, primary_category: null, website: null };
    expect(draftRequest(bare, { ...task, url: null })).toEqual({
      kind: "note",
      given: { ...given, region: null, category: null, website: null, url: null },
    });
  });

  it("is none for a task that is gone or has no wording to write", () => {
    expect(draftRequest(joes, undefined)).toBe("no_draft");
    expect(draftRequest(joes, { ...task, draft_kind: null })).toBe("no_draft");
  });

  it("is none until the owner has said what the business does", () => {
    expect(draftRequest({ ...joes, what_we_do: null }, task)).toBe("what_we_do_missing");
    expect(draftRequest({ ...joes, what_we_do: "" }, task)).toBe("what_we_do_missing");
  });
});

describe("the facts in a draft that nobody gave", () => {
  const unknown = (text: string) => factsNobodyGave(text, given);

  it("are none in a draft that says only what it was given", () => {
    expect(
      unknown(
        "Hello, I run Joe's Pizza in Raleigh, NC. We have made wood-fired pizza since 1998 and seat 40. " +
          "Your guide at https://travel.usnews.com/raleigh/best-pizza-2026 is one people read. " +
          "More at joespizza.example.",
      ),
    ).toEqual([]);
  });

  it("are every number that was not given", () => {
    expect(unknown("Open since 1987, with 3 locations and 40 seats.")).toEqual(["1987", "3"]);
    expect(unknown("Call (919) 555-0100.")).toEqual(["919", "555", "0100"]);
  });

  it("read a number the same however it is punctuated, and never as part of another", () => {
    const thousands = { ...given, what_we_do: "We have served 12,500 pizzas." };
    expect(factsNobodyGave("Over 12500 pizzas served.", thousands)).toEqual([]);
    expect(factsNobodyGave("Over 12,500 pizzas served.", thousands)).toEqual([]);
    // 199 is not 1998, and 98 is not either.
    expect(unknown("Founded in 199 or '98.")).toEqual(["199", "98"]);
  });

  it("are every web address that was not given", () => {
    expect(unknown("See joespizza.example/menu or www.other.example.")).toEqual([
      "joespizza.example/menu",
      "www.other.example.",
    ]);
  });

  it("pass an address that was given, however it is written, and the site of one", () => {
    expect(
      unknown(
        "HTTPS://WWW.JoesPizza.example/ and joespizza.example, travel.usnews.com and usnews.com, " +
          "and (travel.usnews.com/raleigh/best-pizza-2026).",
      ),
    ).toEqual([]);
  });

  it("do not pass a page of a given site that nobody gave", () => {
    expect(unknown("Our story is at https://joespizza.example/about.")).toEqual([
      "https://joespizza.example/about.",
    ]);
    expect(unknown("I liked travel.usnews.com/raleigh/best-burgers too.")).toEqual([
      "travel.usnews.com/raleigh/best-burgers",
    ]);
  });

  it("are every email address, since a location holds none", () => {
    expect(unknown("Write to joe@joespizza.example or JOE@gmail.com.")).toEqual([
      "joe@joespizza.example",
      "JOE@gmail.com",
    ]);
  });

  it("pass an email address the owner wrote down themselves", () => {
    const said = { ...given, what_we_do: "Catering: write to Catering@JoesPizza.example." };
    expect(factsNobodyGave("Write to catering@joespizza.example.", said)).toEqual([]);
  });

  it("name a thing once however often the draft says it", () => {
    expect(unknown("In 2001. Yes, 2001.")).toEqual(["2001"]);
  });

  it("do not take ordinary writing for an address", () => {
    expect(unknown("We open at 5 p.m., e.g. on Fridays. Dr. Lee says hello... really.")).toEqual([
      "5",
    ]);
  });
});

describe("where a month of drafts stands", () => {
  const now = new Date("2026-10-12T15:00:00Z");

  it("is the plan's number for each location it covers, and what is used of it", () => {
    expect(draftsStanding({ drafts: 5 }, 3, { drafts: 4 }, now)).toEqual({
      allowed: 15,
      used: 4,
      resets_on: "2026-11-01",
    });
    expect(draftsStanding({ drafts: 5 }, 1, {}, now).used).toBe(0);
  });

  it("is none allowed on a plan that includes none", () => {
    expect(draftsStanding({}, 3, {}, now).allowed).toBeNull();
    expect(draftsStanding({ google_profile: true }, 3, {}, now).allowed).toBeNull();
  });

  it("starts again on the first of next month, across a year's end", () => {
    expect(draftsStanding({}, 1, {}, new Date("2026-12-31T23:59:59Z")).resets_on).toBe(
      "2027-01-01",
    );
    expect(draftsStanding({}, 1, {}, new Date("2026-10-01T00:00:00Z")).resets_on).toBe(
      "2026-11-01",
    );
  });
});
