import { describe, expect, it } from "vitest";
import { type Page, readEvery } from "../src/store/paging";

/**
 * A stand-in for the database's API: it holds `rows`, answers a request with at most `cap` of
 * them, and counts them only when asked to.
 */
function server<Row>(rows: Row[], { cap = Number.POSITIVE_INFINITY, counts = true } = {}) {
  const asked: { from: number; to: number; first: boolean }[] = [];
  return {
    asked,
    rows,
    page: async (from: number, to: number, first: boolean): Promise<Page<Row, string>> => {
      asked.push({ from, to, first });
      const data = rows.slice(from, Math.min(to + 1, from + cap));
      return { data, error: null, count: first && counts ? rows.length : null };
    },
  };
}
const numbered = (n: number) => Array.from({ length: n }, (_, index) => index);

describe("reading every row of a list", () => {
  it("takes one request when the list fits in a page", async () => {
    const api = server(numbered(3));
    expect(await readEvery(api.page, 5)).toEqual({ rows: [0, 1, 2], error: null });
    expect(api.asked).toEqual([{ from: 0, to: 4, first: true }]);
  });

  it("asks page after page until it has as many rows as there are", async () => {
    const api = server(numbered(11));
    expect((await readEvery(api.page, 5)).rows).toEqual(numbered(11));
    expect(api.asked).toEqual([
      { from: 0, to: 4, first: true },
      { from: 5, to: 9, first: false },
      { from: 10, to: 14, first: false },
    ]);
  });

  it("asks for the count once, on the first page", async () => {
    const api = server(numbered(10));
    await readEvery(api.page, 4);
    expect(api.asked.map((request) => request.first)).toEqual([true, false, false]);
  });

  it("loses nothing when the server answers with fewer rows than a page asks for", async () => {
    // What the hosted API does: a page asks for 1,000 and the server's own limit is lower.
    const api = server(numbered(10), { cap: 3 });
    expect((await readEvery(api.page, 8)).rows).toEqual(numbered(10));
    expect(api.asked.map((request) => request.from)).toEqual([0, 3, 6, 9]);
  });

  it("is the whole list at exactly a page, and at exactly the server's limit", async () => {
    expect((await readEvery(server(numbered(5)).page, 5)).rows).toEqual(numbered(5));
    const capped = server(numbered(6), { cap: 3 });
    expect((await readEvery(capped.page, 3)).rows).toEqual(numbered(6));
    expect(capped.asked).toHaveLength(2);
  });

  it("is empty for an empty list, in one request", async () => {
    const api = server<number>([]);
    expect(await readEvery(api.page, 5)).toEqual({ rows: [], error: null });
    expect(api.asked).toHaveLength(1);
  });

  it("ends at an empty page when the list shrank while it was being read", async () => {
    const api = server(numbered(10));
    const shrinking = async (from: number, to: number, first: boolean) => {
      const answer = await api.page(from, to, first);
      // Three rows go once the first page, and its count of ten, have been handed over.
      if (first) api.rows.splice(7);
      return answer;
    };
    expect((await readEvery(shrinking, 4)).rows).toEqual(numbered(7));
    expect(api.asked.at(-1)).toEqual({ from: 7, to: 10, first: false });
  });

  it("reads to an empty page when the server gives no count", async () => {
    const api = server(numbered(7), { counts: false });
    expect((await readEvery(api.page, 3)).rows).toEqual(numbered(7));
    // One request more than the rows need: the empty page is the only way to know.
    expect(api.asked.map((request) => request.from)).toEqual([0, 3, 6, 7]);
  });

  it("answers with the problem, and no part of the list, when any page fails", async () => {
    const api = server(numbered(10));
    const failing = async (from: number, to: number, first: boolean) =>
      from >= 4 ? { data: null, error: "The database is down." } : api.page(from, to, first);
    expect(await readEvery(failing, 4)).toEqual({ rows: [], error: "The database is down." });
  });

  it("asks for a thousand rows at a time unless told otherwise", async () => {
    const api = server(numbered(2500));
    expect((await readEvery(api.page)).rows).toHaveLength(2500);
    expect(api.asked.map((request) => [request.from, request.to])).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });
});
