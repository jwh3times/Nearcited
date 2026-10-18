import { describe, expect, it } from "vitest";
import {
  analyzeObservation,
  type BusinessIdentity,
  hostOf,
  hostsMatch,
  namesMatch,
  normalizeName,
  phonesGivenFor,
} from "../src/analysis";

const business: BusinessIdentity = {
  name: "Joe's Pizza",
  website: "https://www.joespizza.example",
  google_place_id: "place-joes",
};

describe("normalizeName", () => {
  it("folds case, punctuation, accents and legal suffixes", () => {
    expect(normalizeName("Café  Lüna, LLC")).toBe("cafe luna");
    expect(normalizeName("Smith & Sons Plumbing Co.")).toBe("smith and sons plumbing");
    expect(normalizeName("Joe’s Pizza")).toBe("joes pizza");
  });

  it("keeps a name that is only a legal suffix", () => {
    expect(normalizeName("Co")).toBe("co");
  });
});

describe("namesMatch", () => {
  it("matches a name inside a longer listing title", () => {
    expect(namesMatch("Joe's Pizza", "Joe's Pizza & Pasta - Raleigh")).toBe(true);
  });

  it("does not match on a partial word", () => {
    expect(namesMatch("Joe's Pizza", "Joe's Pizzaria")).toBe(false);
  });

  it("does not match a single short word by containment", () => {
    expect(namesMatch("Art", "Art of Shaving")).toBe(false);
  });

  it("does not match empty names", () => {
    expect(namesMatch("", "")).toBe(false);
  });
});

describe("hosts", () => {
  it("extracts a bare host with or without a scheme", () => {
    expect(hostOf("https://www.Example.com/menu")).toBe("example.com");
    expect(hostOf("example.com/menu")).toBe("example.com");
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf(null)).toBeNull();
  });

  it("treats subdomains as the same site but not lookalikes", () => {
    expect(hostsMatch("order.example.com", "example.com")).toBe(true);
    expect(hostsMatch("notexample.com", "example.com")).toBe(false);
    expect(hostsMatch(null, null)).toBe(false);
  });
});

describe("analyzeObservation: rankings", () => {
  it("matches by place ID even when the listing name differs", () => {
    const finding = analyzeObservation(
      {
        kind: "ranking",
        entries: [
          { name: "Tony's Slice House" },
          { name: "JP Raleigh", place_id: "place-joes" },
          { name: "Crust & Co" },
        ],
      },
      business,
      "google_local_pack",
    );
    expect(finding).toMatchObject({
      mentioned: true,
      position: 2,
      competitors: ["Tony's Slice House", "Crust & Co"],
    });
  });

  it("reports absence with everyone who ranked instead", () => {
    const finding = analyzeObservation(
      { kind: "ranking", entries: [{ name: "Tony's Slice House" }, { name: "Crust & Co" }] },
      business,
      "google_local_pack",
    );
    expect(finding.mentioned).toBe(false);
    expect(finding.position).toBeNull();
    expect(finding.competitors).toEqual(["Tony's Slice House", "Crust & Co"]);
  });

  it("does not match a business with no place ID to an entry with no place ID", () => {
    const finding = analyzeObservation(
      { kind: "ranking", entries: [{ name: "Tony's Slice House", place_id: null }] },
      { ...business, google_place_id: null },
      "google_local_pack",
    );
    expect(finding.mentioned).toBe(false);
  });
});

describe("analyzeObservation: answers", () => {
  it("takes position from the order businesses were named", () => {
    const finding = analyzeObservation(
      {
        kind: "answer",
        text: "For a classic slice, try Tony's Slice House. Joe's Pizza is also well reviewed.",
        businesses: ["Tony's Slice House", "Joe's Pizza"],
        cited_urls: ["https://tonys.example"],
      },
      business,
      "chatgpt",
    );
    expect(finding).toMatchObject({ mentioned: true, position: 2 });
    expect(finding.competitors).toEqual(["Tony's Slice House"]);
    expect(finding.answer_excerpt).toContain("Joe's Pizza");
  });

  it("counts a citation of the website as a mention with no position", () => {
    const finding = analyzeObservation(
      {
        kind: "answer",
        text: "Several places deliver late.",
        businesses: [],
        cited_urls: ["https://order.joespizza.example/late-night"],
      },
      business,
      "chatgpt",
    );
    expect(finding).toMatchObject({ mentioned: true, position: null });
  });

  it("is absent when neither named nor cited", () => {
    const finding = analyzeObservation(
      {
        kind: "answer",
        text: "Try Tony's Slice House.",
        businesses: ["Tony's Slice House"],
        cited_urls: [],
      },
      business,
      "chatgpt",
    );
    expect(finding.mentioned).toBe(false);
  });

  it("keeps long answers to a bounded excerpt around the mention", () => {
    const filler = "Lots of places serve pizza in this town. ".repeat(30);
    const finding = analyzeObservation(
      {
        kind: "answer",
        text: `${filler}Joe's Pizza stands out. ${filler}`,
        businesses: ["Joe's Pizza"],
        cited_urls: [],
      },
      business,
      "chatgpt",
    );
    expect(finding.answer_excerpt).toContain("Joe's Pizza");
    expect(finding.answer_excerpt?.length).toBeLessThanOrEqual(282);
  });
});

describe("phonesGivenFor", () => {
  const joes = { name: "Joe's Pizza", country_code: "US" };
  const given = (
    text: string,
    named: string[],
    about: { name: string; country_code?: string } = joes,
  ) => phonesGivenFor(text, named, about);

  it("reads the number in the business's own entry of a list", () => {
    const text = [
      "For pizza in Raleigh I'd start with these:",
      "1. **Joe's Pizza** — a long-established shop with strong reviews. **12 Main St.; (919) 555-0101.**",
      "2. **Tony's Slice House** — open late, by the slice. **40 Oak Ave.; (919) 555-0199.**",
    ].join("\n");
    const named = ["Joe's Pizza", "Tony's Slice House"];

    expect(given(text, named)).toEqual(["+19195550101"]);
    expect(given(text, named, { name: "Tony's Slice House", country_code: "US" })).toEqual([
      "+19195550199",
    ]);
  });

  it("reads one written in the run of a sentence", () => {
    const text =
      "Best first: 1) Joe's Pizza (Joe and Ann, (919) 555-0101), which looks locally rooted. 2) Tony's Slice House, which has several branches.";
    expect(given(text, ["Joe's Pizza", "Tony's Slice House"])).toEqual(["+19195550101"]);
  });

  it("gives a number to the name written nearest before it, not to the first one named", () => {
    // The business is named in passing, then each has its own entry.
    const text =
      "Joe's Pizza and Tony's Slice House are the two to try. Tony's Slice House: 919-555-0199. Joe's Pizza: 919-555-0101.";
    expect(given(text, ["Joe's Pizza", "Tony's Slice House"])).toEqual(["+19195550101"]);
  });

  it("takes no number that follows another business's name, or comes before any name", () => {
    const named = ["Tony's Slice House", "Joe's Pizza"];
    expect(given("Try Tony's Slice House, (919) 555-0199, or Joe's Pizza.", named)).toEqual([]);
    expect(given("Call (919) 555-0101 to order from Joe's Pizza.", named)).toEqual([]);
    expect(given("Try Joe's Pizza or Tony's Slice House.", named)).toEqual([]);
  });

  it("knows the business by a longer name than the one on file, and by the one on file alone", () => {
    const text = "1) Joe's Pizza & Pasta - Raleigh: (919) 555-0101. 2) Tony's: (919) 555-0199.";
    expect(given(text, ["Joe's Pizza & Pasta - Raleigh", "Tony's"])).toEqual(["+19195550101"]);
    // The answer listed nobody, and still wrote the business's name before the number.
    expect(given("Joe's Pizza can be reached on (919) 555-0101.", [])).toEqual(["+19195550101"]);
  });

  it("keeps each number once, however it was written", () => {
    const text = "Joe's Pizza: (919) 555-0101, or +1 919-555-0101, or 919.555.0102.";
    expect(given(text, ["Joe's Pizza"])).toEqual(["+19195550101", "+19195550102"]);
  });

  it("reads a number the way it is written where the business is", () => {
    const cafe = { name: "Ivy Cafe", country_code: "GB" };
    expect(given("Ivy Cafe takes bookings on 020 7946 0958.", ["Ivy Cafe"], cafe)).toEqual([
      "+442079460958",
    ]);
    // The same digits are not a number in the United States.
    expect(
      given("Ivy Cafe takes bookings on 020 7946 0958.", ["Ivy Cafe"], { name: "Ivy Cafe" }),
    ).toEqual([]);
    expect(
      given("Ivy Cafe: (919) 555-0101.", ["Ivy Cafe"], { name: "Ivy Cafe", country_code: "ZZ" }),
    ).toEqual([]);
  });

  it("is part of what an answer is found to say, and no part of a list of results", () => {
    const answer = analyzeObservation(
      {
        kind: "answer",
        text: "Try Tony's Slice House or Joe's Pizza, (919) 555-0101.",
        businesses: ["Tony's Slice House", "Joe's Pizza"],
        cited_urls: [],
      },
      { ...business, country_code: "US" },
      "chatgpt",
    );
    expect(answer.phones).toEqual(["+19195550101"]);

    const ranking = analyzeObservation(
      { kind: "ranking", entries: [{ name: "Joe's Pizza (919) 555-0101" }] },
      business,
      "google_local_pack",
    );
    expect(ranking.phones).toEqual([]);
  });
});
