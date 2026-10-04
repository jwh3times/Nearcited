import { describe, expect, it } from "vitest";
import {
  analyzeObservation,
  type BusinessIdentity,
  hostOf,
  hostsMatch,
  namesMatch,
  normalizeName,
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
    );
    expect(finding.mentioned).toBe(false);
    expect(finding.position).toBeNull();
    expect(finding.competitors).toEqual(["Tony's Slice House", "Crust & Co"]);
  });

  it("does not match a business with no place ID to an entry with no place ID", () => {
    const finding = analyzeObservation(
      { kind: "ranking", entries: [{ name: "Tony's Slice House", place_id: null }] },
      { ...business, google_place_id: null },
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
    );
    expect(finding.answer_excerpt).toContain("Joe's Pizza");
    expect(finding.answer_excerpt?.length).toBeLessThanOrEqual(282);
  });
});
