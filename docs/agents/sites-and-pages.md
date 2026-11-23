# The line, hosted pages and structured details

The project rules for the line on a business's site and the visits it counts, the Pages Worker
and its hosted pages, and the structured details. `AGENTS.md` "Rules" points here, and these
bind as its own do: read this file before changing anything in this area.

- **A visit is counted for whoever holds the site's key, and nothing rests on the count.** The
  line on a business's site reports a visit with no sign-in, and `record_visit()` is the only
  thing that counts one
  (`docs/adr/0017-a-visit-is-counted-for-whoever-holds-the-site-key.md`). The key is in the
  site's source, so the function trusts nothing it is told: the day is its own, the page must be
  on the location's own website, and a location counts a bounded number of visits a day under a
  bounded number of pages. Keep those bounds inside the function, since anyone can call it. The
  route works out the assistant from what the visit carried (`assistantOf`,
  `packages/shared/src/visits.ts`), takes the site from where the browser says the post came
  from, and answers the same whatever became of the visit. Nothing is kept about a visitor: a
  count for a day, a location, an assistant and a page, and never a row for a visit, a time of
  day or an address. The line (`apps/web/public/line.js`) sends nothing for a visit that did not
  come from an assistant, sets no cookie and keeps nothing in the browser: keep all three. Its
  list of assistants is a copy of the shared one, and the database names them too
  (`visits.assistant`, `record_visit()`, `analytics_visits.assistant`,
  `record_analytics_visits()`, `FOUND_ASSISTANTS` and `found_answers.assistant`): add one in all
  eight. The count can be padded by anyone who reads the key, so no score, alert, task or bill is
  worked out from it. Do not open `visits` or
  `visit_lines` to a caller who is not signed in, and do not count a visit on any other path. A
  key is replaced only by `replace_site_key()`, which answers an owner or an admin of the
  location's organization and no one else, the operator included: the old key then belongs to
  nobody and what was counted stays. Do not add another path that changes a key.
- **The Pages Worker serves hosted pages and nothing else, and holds no secret.** It reads only
  through `hosted_page()`, which anyone may call with the publishable key and which answers only
  for a live answer subdomain, with only what the page shows anyway, and writes only a count
  through `record_page_fetch()`, which anyone may call too and which trusts nothing it is told:
  the day is its own, the page must be live and the fetcher a known one, and a day's count stops
  at a ceiling (`docs/adr/0019-hosted-pages-are-served-by-a-worker-of-their-own.md`). Do not give
  it the secret key, another table, another write, or anything of the app; do not serve hosted
  pages from the main Worker. Nothing is kept about a fetch but that count, for a day, a page and
  a fetcher, and nothing is worked out from it: anyone can claim to be a fetcher. Its list of
  fetchers (`PAGE_FETCHERS`) is the one list for hosted pages and a business's own site: the checks
  on `hosted_page_fetches.fetcher` and `site_fetches.fetcher`, `record_page_fetch()`,
  `record_site_fetches()` and `SPELLED` (`apps/api/src/connections/cloudflare.ts`) name the same
  ones, so add one in all six. It hands on any request for a
  name of the zone's own (`nearcited.com` and its subdomains) untouched. A hosted page is plain HTML: no script but the structured details, no
  cookie, image or tracking, every word written as text, and nothing of Nearcited's but a
  generator tag. Keep all of that.
- **Structured details carry only what a location holds.** A detail not on file is left out, never
  filled in, and no model writes any of it (`packages/shared/src/structured-details.ts`).
