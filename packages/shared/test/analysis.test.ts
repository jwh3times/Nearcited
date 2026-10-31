import { describe, expect, it } from "vitest";
import {
  analyzeObservation,
  type BusinessIdentity,
  competitorKey,
  hostOf,
  hostsMatch,
  namesMatch,
  normalizeName,
  phonesGivenFor,
  placesNamed,
  textNames,
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

describe("competitorKey", () => {
  const same = (a: string, b: string) => competitorKey(a) === competitorKey(b);

  it("makes one competitor of spellings that differ by spaces or a legal ending", () => {
    expect(same("North Star Realty", "Northstar Realty Co")).toBe(true);
    expect(same("Smith Plumbing Company", "Smith Plumbing Co")).toBe(true);
    expect(same("Smith Plumbing Company", "Smith Plumbing, Inc.")).toBe(true);
    expect(same("Acme Corporation", "Acme Corp")).toBe(true);
    expect(same("Main Street Limited", "Main Street Ltd")).toBe(true);
    expect(same("Bright Smiles Incorporated", "Bright Smiles")).toBe(true);
    expect(same("Oak Realty, L.L.C.", "Oak Realty")).toBe(true);
  });

  it("keeps apart names that differ by a word that is not a legal ending, or contain another", () => {
    expect(same("Rowe Group", "Rowe Partners")).toBe(false);
    expect(same("Oak Realty", "Oak Realty Partners")).toBe(false);
    expect(same("Joe's Pizza", "Joe's Pizza & Pasta")).toBe(false);
    expect(same("Ma & Pa", "Ma &")).toBe(false);
  });

  it("drops an ending only as a whole last word, and keeps a name that is only one", () => {
    expect(same("Coco", "Co")).toBe(false);
    expect(same("Fitness Incline", "Fitness")).toBe(false);
    expect(competitorKey("Company")).toBe("company");
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

  it("matches a name however it is spaced, and with its legal ending written out", () => {
    expect(namesMatch("Northstar Realty", "North Star Realty")).toBe(true);
    expect(namesMatch("North Star Realty Company", "North Star Realty")).toBe(true);
    expect(namesMatch("North Star Realty, L.L.C.", "Northstar Realty")).toBe(true);
  });

  it("finds a name inside a longer one however either is spaced, but only as whole words", () => {
    expect(namesMatch("North Star Realty", "Northstar Realty Group")).toBe(true);
    expect(namesMatch("Star Realty", "North Star Realty")).toBe(true);
    expect(namesMatch("Star Realty", "Northstar Realty")).toBe(false);
    // A name left too short by its ending is no more distinctive than before.
    expect(namesMatch("Smith Company", "Smith Plumbing")).toBe(false);
  });
});

describe("textNames", () => {
  it("finds the name written as whole words, however they are spaced", () => {
    expect(textNames("Try Northstar Realty downtown.", "North Star Realty")).toBe(true);
    expect(textNames("Try North Star Realty downtown.", "Northstar Realty")).toBe(true);
    expect(textNames("North Star Realty, L.L.C. sells homes.", "North Star Realty Company")).toBe(
      true,
    );
    expect(textNames("Ask Joe’s PIZZA", "Joe's Pizza")).toBe(true);
  });

  it("does not find a name inside a longer word", () => {
    expect(textNames("Try Northstar Realty downtown.", "Star Realty")).toBe(false);
    expect(textNames("Joe's Pizzaria", "Joe's Pizza")).toBe(false);
    expect(textNames("", "Joe's Pizza")).toBe(false);
  });

  it("reads a text in the time it takes to read it, whatever the text is", () => {
    // Each of these comes near the name at every word and never finishes it. A search that
    // started over from each word would take the square of the length.
    for (const run of ["a ", "aa", "a.", "& ", "north star "]) {
      expect(textNames(run.repeat(100_000), "North Star Realty"), run).toBe(false);
      expect(textNames(run.repeat(100_000), `${"a".repeat(60)} b`), run).toBe(false);
    }
  });
});

describe("placesNamed", () => {
  it("gives where the name is written, as it is written", () => {
    const text = "First, Northstar Realty; then North-Star Realty LLC.";
    expect(
      placesNamed(text, "North Star Realty").map(({ at, length }) => text.slice(at, at + length)),
    ).toEqual(["Northstar Realty", "North-Star Realty"]);
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

  it("lists none of the business's own spellings among those ranked instead", () => {
    const finding = analyzeObservation(
      {
        kind: "ranking",
        entries: [
          { name: "Tony's Slice House" },
          { name: "JP Raleigh", place_id: "place-joes" },
          { name: "JoesPizza" },
        ],
      },
      business,
      "google_local_pack",
    );
    expect(finding).toMatchObject({ position: 2, competitors: ["Tony's Slice House"] });
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

  describe("for a business whose name is spaced or ended another way", () => {
    const northStar = { name: "North Star Realty", website: null, google_place_id: null };
    const answer = (text: string, businesses: string[] = []) =>
      analyzeObservation(
        { kind: "answer", text, businesses, cited_urls: [] },
        northStar,
        "chatgpt",
      );

    it("counts it named, with its place, when the list writes it another way", () => {
      const finding = answer("Try Ridge Homes or Northstar Realty.", [
        "Ridge Homes",
        "Northstar Realty",
      ]);
      expect(finding).toMatchObject({ mentioned: true, position: 2, competitors: ["Ridge Homes"] });
    });

    it("counts it named when the text alone writes it another way", () => {
      expect(answer("Northstar Realty is well reviewed.").mentioned).toBe(true);
      expect(answer("North Star Realty Company is well reviewed.").mentioned).toBe(true);
      expect(answer("North Star Realty, L.L.C. is well reviewed.").mentioned).toBe(true);
      const spacedOnFile = { ...northStar, name: "Northstar Realty" };
      expect(
        analyzeObservation(
          {
            kind: "answer",
            text: "North Star Realty sells homes.",
            businesses: [],
            cited_urls: [],
          },
          spacedOnFile,
          "chatgpt",
        ).mentioned,
      ).toBe(true);
    });

    it("does not count a shorter name found inside a longer word", () => {
      const star = { ...northStar, name: "Star Realty" };
      expect(
        analyzeObservation(
          { kind: "answer", text: "Northstar Realty sells homes.", businesses: [], cited_urls: [] },
          star,
          "chatgpt",
        ).mentioned,
      ).toBe(false);
    });

    it("quotes the answer where it wrote the name", () => {
      const filler = "Lots of agents sell homes in this town. ".repeat(30);
      const finding = answer(`${filler}Northstar Realty stands out. ${filler}`, [
        "Northstar Realty",
      ]);
      expect(finding.answer_excerpt).toContain("Northstar Realty stands out.");
    });
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

  it("knows the business however the answer spaces its name, listed or not", () => {
    const northStar = { name: "North Star Realty", country_code: "US" };
    const text = "Northstar Realty: (919) 555-0101. Ridge Homes: (919) 555-0199.";
    expect(given(text, ["Northstar Realty", "Ridge Homes"], northStar)).toEqual(["+19195550101"]);
    expect(given(text, ["Ridge Homes"], northStar)).toEqual(["+19195550101"]);
    expect(given("Northstar Realty can be reached on (919) 555-0101.", [], northStar)).toEqual([
      "+19195550101",
    ]);
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
