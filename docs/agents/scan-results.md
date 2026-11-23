# Alerts, Google results and NearcitedBot

The project rules for what a scan raises and reads beyond the assistants' answers: alerts, the
Google checks and a location's point, and the pages NearcitedBot reads. `AGENTS.md` "Rules"
points here, and these bind as its own do: read this file before changing anything in this
area.

- **Only the worker raises or clears an alert, and an alert is kept, not worked out again.**
  `complete_scan()` writes the alerts a scan raises and clears (`deriveAlerts`,
  `packages/shared/src/alerts.ts`). A request only dismisses one, through `dismiss_alert()`, which
  answers a member of the location's organization and no one else, the operator included
  (`docs/adr/0015-an-alert-is-kept-not-worked-out-again.md`). What raises an alert and what clears
  it are separate conditions: never clear a drop because its rule stopped firing over the window,
  and never by age. A first sighting is news, not a state: it is cleared as `old_news` when the
  scan that raised it leaves the window, and by nothing else. "For the first time" is said of the
  whole record, read through `listSeenBefore` (`seen_before()`, worker only), never of the window
  alone, and only written answers count. A phone number the answers give is read in
  `analyzeObservation`, never by a provider, and kept on the result (`scan_results.phones`), since
  a scan keeps only an excerpt of an answer; it is counted over the window, and a dismissed phone
  alert is never cleared, so that number is not raised again. A dismissed alert stays current
  until the worker clears it, so the same thing is not raised twice. An alert is composed by rule
  from the facts on its row, says what was seen and never what to do, and no model writes one. An
  alert is told to the owners once, in the report a scheduled scan emails, and marked told
  (`markAlertsTold`) only when the report went to someone: one that failed, or had nobody to go
  to, leaves it for the next. Nothing on a request path writes `told_at` or `cleared_told_at`.
- **Only the worker writes a location's point, and Google is checked only where a plan allows
  it.** `latitude`, `longitude`, `point_source` and `geocoded_from` are written by the worker
  alone, through `setLocationPoint` after the scan runner looks the address up
  (`docs/adr/0023-google-results-are-bought-and-checked-from-one-point.md`); the
  `guard_location_point` trigger keeps them as they were for any other writer. Nothing on a
  request path writes them, and nothing a request sends decides where a check is made from. A scan
  checks the Google surfaces only where an organization's allowances include `google_results`
  (`coveredSurfaces`, `packages/shared/src/google.ts`), never because `surfaces` names them, and
  only when `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` and `MAPBOX_TOKEN` are all set. A location
  that cannot be placed is not checked on Google. Keep all three. A Google search that showed
  nothing is kept as such (`scan_results.shown`), decided in `analyzeObservation` and never by a
  provider, and counts nowhere: whatever counts checks asks `isCounted`, so it raises, counts
  toward and clears nothing
  (`docs/adr/0024-a-search-that-showed-nothing-is-kept-and-not-counted.md`).
- **NearcitedBot obeys robots.txt, and reads only pages an answer cited.** Every page it reads,
  through `apps/api/src/site/fetch.ts`, is asked for only after that host's `robots.txt`, read as
  RFC 9309 says (`robotsAllows`, `packages/shared/src/robots.ts`): the group naming `NearcitedBot`,
  else `*`, except on a location's own site, where only a group naming it counts (an audit's site is
  read as anyone else's); a `robots.txt` that faults or does not answer shuts everything
  (`docs/adr/0027-nearcitedbot-obeys-robots-txt-and-reads-only-pages-an-answer-cited.md`). Besides
  the business's own home page, it reads only the cited-page check's pages: for up to three open
  directory tasks no member dismissed, the page the answers cited most for the site
  (`citedPagesToRead`), once a scan, within `CITED_PAGE_REQUESTS`, never off the task's site, and
  never on sample data, for a test organization or for an audit. What it found is kept on the scan
  (`scans.cited_pages`), composed by rule, never the page, and only the phone is ever called
  different. Do not add another page NearcitedBot reads, a read that skips `robots.txt`, or a
  retry of a cited page.
