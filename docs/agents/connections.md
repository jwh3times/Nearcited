# Connections

The project rules for a connection's sign-in and for what the worker reads through a
connection: a business's Cloudflare zone and its Google Analytics property. `AGENTS.md`
"Rules" points here, and these bind as its own do: read this file before changing anything in
this area.

- **A connection's sign-in is sealed by the Worker and read only by the worker.** It is sealed
  before it is stored (`apps/api/src/connections/seal.ts`) and kept in `connection_secrets`, which
  no API role reads (`docs/adr/0013-a-sign-in-is-sealed-by-the-worker.md`). A request may write
  one, through `create_connection()`, and never reads one: whatever needs the sign-in runs from
  the queue, and no route or wire type carries it, sealed or not. Do not add a policy or a grant
  on `connection_secrets`, and do not read it anywhere but `getConnectionSecret`, which only the
  worker calls. A WordPress site's application password is sent only over https to that site's
  own host, and never on through a redirect (`signedIn`, `apps/api/src/connections/wordpress.ts`):
  keep both. `WORDPRESS_LOCAL_ORIGIN` lifts them for one origin on a developer's own machine and
  is never set on a deployment. An answer subdomain has no sign-in: its owner's DNS record is the
  say-so, and it points at a target of that connection's own, so the worker registers a name to
  be served only once its record points at that target (`checkAnswerSubdomain`,
  `apps/api/src/connections/index.ts`). Keep that, or an account that made the subdomain first
  could put its pages on someone else's domain, and keep a name held by one connection at a time.
- **A business's own site's fetches are read by the worker from its Cloudflare zone, and nothing
  rests on the count.** The owner gives a Cloudflare token that only reads, sealed like any
  sign-in; the request never tries it, and the worker's sync (`syncZones`,
  `apps/api/src/connections/index.ts`) lists its zones, has `match_cloudflare_zones()` match each
  to the location whose website it holds (one zone, one location; never by hand), and reads the
  counts for that website's host alone
  (`docs/adr/0028-a-sites-fetches-are-read-from-its-cloudflare-zone.md`). The token goes only to
  Cloudflare's API, never on through a redirect (`apps/api/src/connections/cloudflare.ts`).
  `site_fetches` is written only by `record_site_fetches()`, which only the worker calls and which
  keeps known fetchers and bounds a location's pages a day inside itself, and is read added up, by
  `location_site_fetches()`, as the caller. Nothing is kept but a count for a day, a location, a
  fetcher and a page: no time of day, address, query or user agent. Anyone can claim a fetcher's
  name, so no score, alert, task, report or bill is worked out from it. On sample data the counts
  are made up (`sampleFetches`), kept as `sample_data`, and Cloudflare is never asked.
- **A location's sessions from assistants are read by the worker from its Google Analytics property,
  kept apart from what the line counted, and nothing rests on the count.** An owner or admin signs in
  with Google for read-only Analytics and nothing else; Google returns to a page of the web app, which
  posts the code to a signed-in route with a `state` sealed to that caller and organization, and the
  refresh token is sealed like any sign-in (`docs/adr/0029-analytics-counts-are-kept-apart-from-the-lines.md`).
  The worker's sync (`syncProperties`, `apps/api/src/connections/index.ts`) lists what it reaches, has
  `match_analytics_properties()` match each property to the location whose website a stream measures
  (one property, one location; never by hand), and asks only for sessions whose source is a host or
  tag in `ASSISTANT_REFERRERS`. The sign-in goes only to Google, never on through a redirect
  (`apps/api/src/connections/google.ts`), and removal withdraws it there first. `analytics_visits` is
  written only by `record_analytics_visits()`, which only the worker calls and which keeps known
  assistants and the line's bounds inside itself, and is read added up, by
  `location_analytics_visits()`, as the caller. Never add these counts to `visits` or show their sum,
  and `record_visit()` stays the only thing that writes `visits`. Nothing is kept but a count for a
  day, a location, an assistant and a page, and no score, alert, task, report or bill is worked out
  from it. On sample data and for a test organization the counts are made up
  (`sampleAnalyticsVisits`), kept as `sample_data`, and Google is never asked for them.
