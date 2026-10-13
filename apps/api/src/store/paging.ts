/**
 * Reading a list that may be longer than one answer carries.
 *
 * The database's API answers a request with at most a set number of rows (1,000 as hosted) and
 * says nothing when it leaves the rest out. A list read in one request is therefore right until
 * it is long, and then short without an error. Anything that reads across every organization
 * goes through here instead: it asks a page at a time until it has the whole list.
 *
 * The list has to be asked for in an order no two rows share, or a row can fall between two
 * pages. Where the rows have a time they were made, ask oldest first, so one made while the
 * pages are being read lands past the end and moves nothing that was already read.
 *
 * The pages are separate requests, not one look at the table. A row that leaves the list while
 * it is being read moves the later rows up one, and the row that crosses a page's edge is then
 * not read this time. Nothing here is read only once: the next read has it.
 */

/** How many rows a page asks for. The server may still answer with fewer. */
export const PAGE_SIZE = 1000;

/** One answer: some rows, or what went wrong, and on the first page how many rows there are. */
export interface Page<Row, Problem> {
  data: Row[] | null;
  error: Problem | null;
  count?: number | null;
}

/**
 * Asks for rows `from` to `to`, counting from zero. `first` is true for the first page, which is
 * the one asked to say how many rows there are in all.
 */
export type ReadPage<Row, Problem> = (
  from: number,
  to: number,
  first: boolean,
) => PromiseLike<Page<Row, Problem>>;

/**
 * Every row of a list, read a page at a time. Stops when it holds as many rows as the first page
 * said there were, or when a page comes back empty, which is how a list that shrank meanwhile
 * ends. The next page starts after the rows that came, not after the rows that were asked for,
 * so a server that answers with fewer than a page loses nothing.
 *
 * A problem on any page is the answer: no part of a list is handed back as if it were the list.
 */
export async function readEvery<Row, Problem>(
  page: ReadPage<Row, Problem>,
  size = PAGE_SIZE,
): Promise<{ rows: Row[]; error: Problem | null }> {
  const rows: Row[] = [];
  let total: number | null = null;
  for (let first = true; ; first = false) {
    const answer = await page(rows.length, rows.length + size - 1, first);
    if (answer.error) return { rows: [], error: answer.error };
    if (first) total = answer.count ?? null;
    const came = answer.data ?? [];
    rows.push(...came);
    if (came.length === 0 || (total !== null && rows.length >= total)) return { rows, error: null };
  }
}
