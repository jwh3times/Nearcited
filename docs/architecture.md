# Architecture

## One Worker, three entry points

`apps/api/src/index.ts` exports a single Worker with three handlers:

- **`fetch`**: the HTTP API, a Hono app mounted at `/api`. Only `/api/*` reaches the Worker.
  Every other path is served from the web app's build output, with unknown paths falling back to
  `index.html` so client-side routes work. That routing lives in `wrangler.jsonc` under `assets`.
- **`scheduled`**: two Cron Triggers. Every 15 minutes it fails scans that have been queued or
  running for more than 30 minutes, so an abandoned scan cannot block its location for long. It
  also fails audits still `queued` after 30 minutes (see "Shareable audits"), and queues again
  the removal of any connection asked for more than 15 minutes ago and not finished, the first
  sync of any connection made in the last day that still has none (see "Connections"), and any
  approved action nobody is carrying out (`requeueStalledActions`; see "Actions").
  Once a day it also asks Postgres which locations are due (`locations_due_for_scan`), creates a
  `scheduled` scan row for each, and puts the scan IDs on the queue. It also queues a sync for each
  connection that is due (`enqueueDueSyncs`). It also lapses the proposals that waited fourteen
  days (`lapse_actions()`), drops what an action replaced once it may be kept no longer
  (`drop_expired_seen()`) and tells each organization's owners what was done and what is newly
  waiting (`sendActionNotices`; see "Actions"). It also starts the removal of each connection that
  has been paused for thirty days (`expirePausedConnections`) and reminds, once, the owners and
  admins of each they were told a week ago had broken and that still is
  (`remindBrokenConnections`), and tells those of any broken one nobody could be told of at the
  time (`tellBrokenConnections`; see "Connections"). It also calls `advancePriceChanges`, which queues the reminders a week before an
  announced price change and, from its day on, a move for each subscription not yet moved. It also
  calls `advanceLimitChanges`, which queues the reminders a week before an announced reduction in a
  plan's limits and, on its day, makes the reduction through `apply_limit_change()`.
- **`queue`**: the consumer. For each scan ID it runs the scan and, for scheduled scans, emails
  the organization's owners a report, which opens with any alert they have not been told of (see
  "Alerts"). A message shaped `{ audit_id, prompt_index }` is one prompt of a
  shareable audit instead (see "Shareable audits"). A message shaped
  `{ price_change_id, organization_id, step }` is one step of a price change for one organization
  (see "Price changes"). A message shaped `{ limit_change_id, organization_id, step }` is one step of
  a reduction for one organization (see "Reductions in limits"). A message shaped
  `{ connection_id, step }` is one step for a connection, `remove` or `sync` (see "Connections");
  after a sync that read the account it also proposes actions. A message shaped
  `{ action_id, step }` carries out one approved action (see "Actions").

## How a scan runs

```
POST /api/locations/:id/scans          cron
        |                                |
   insert scan (queued) ------------- insert scan (queued)
        |                                |
        +--------> SCAN_QUEUE <----------+
                       |
              queue consumer: runScan()
                       |
     for each active query x each surface that kind is checked on:
        provider.observe()   -> Observation   (what the surface returned)
        analyzeObservation() -> Finding       (was the business named, where, who else)
                       |
     fetchSite() + analyzeSite() -> SiteCheck  (home page, kept in scans.site_check;
                                                 skipped on sample data)
                       |
     listRecentResults(): the last six successful scans of the same kind
                       |
     windowScore() + deriveRecommendations(), over this scan and those six
                       |
     listAlerts() + deriveAlerts(): the alerts that window ends, and the ones it raises
                       |
     complete_scan() in Postgres: results, score, last_scanned_at,
     recommendations and alerts, in one transaction
                       |
     recordUsage(): what the providers used, by surface and model (also on failure;
                    nothing on sample data)
                       |
     scheduled scans only, where the plan emails a report (not a test organization):
        listAlertsToTell() -> notify(): the report, with the alerts not yet told first
        markAlertsTold() only if the report went to someone
```

A provider only fetches. Whether the business was named is decided by `analyzeObservation` in
`packages/shared`, so every surface is judged by the same rules and those rules are tested without
network access. A provider also reports what each call it is charged for used (`onUsage`); the
scan and audit runners add those up and store them in `provider_usage`. A failure to store them
is logged and does not change the outcome. What a row cost is `usageCost` in `packages/shared`,
from the tuning's `rates`: one entry per model, which a public clone leaves empty, so a model
without an entry has no cost and is never priced as another.

The operator's spend figures (`GET /api/operator/spend`) are the only reader. The database adds
the rows up by calendar month in UTC (`usage_by_month()`, which runs as the caller, so it counts
everything for the operator and nothing for a member), and `buildSpend` prices the sums when they
are read: per organization, audits on their own line, and what deleted organizations had spent. A
rate corrected later therefore corrects past months too. A test organization is never counted, and
usage on a model with no rate is named and left out of the total, not guessed at. Only dollars
leave the server; the rates do not.

## Tuning

Prompt wording and score weights are values, defined by `TuningSchema` in
`packages/shared/src/tuning.ts` with placeholder defaults. The values a deployment really uses
live in the private companion repository as `private/tuning.json`
([ADR 0001](adr/0001-private-tuning-as-data.md)).

```
private/tuning.json (maintainers and the deploy workflow only)
        |
scripts/prepare-tuning.mjs      run by wrangler before dev, deploy and dry run
        |
apps/api/.tuning/tuning.json    gitignored: { source: "private", tuning } or { source: "default" }
        |
apps/api/src/tuning.ts          resolveTuning() at startup; an invalid private file throws
        |
queue consumer -> runScan({ weights, unavailable })
```

`runScan` and the scoring functions take the tuning as arguments, so they are tested without the
bundled file. Only `apps/api/src/index.ts` imports the resolved tuning.

## Live providers

A live scan checks each surface whose key is set and skips the rest (`createLiveProviders`).

**ChatGPT** (`apps/api/src/providers/chatgpt.ts`) calls OpenAI's Responses API with the
`web_search` tool, told to search as someone in the location's city, and asks for the answer and
the businesses it named as JSON. Cited URLs come from the answer's citation annotations. This is
ChatGPT through the API with web search, not the consumer app: same models and search, but no
consumer system prompt and no user memory.

OpenAI requires citations to be visible and clickable wherever information from web results is
shown, so the location page lists each answer's sources under its excerpt. Keep that list when
changing how results are displayed.

**Cost of one ChatGPT check: about 7 cents on `gpt-6.1-sol`**, the default model. This is from
a single live call on 2026-10-06, so treat it as a first reading and not an average:

| Part | Used | Rate | Cost |
| --- | --- | --- | --- |
| Input tokens | 20,977 | $2 per million | $0.042 |
| Web searches | 2 | $10 per 1,000 | $0.02 |
| Output and reasoning tokens | 638 | $10 per million | $0.006 |

OpenAI bills the pages a search reads as input at the model's rate, so the model decides most of
the cost. The same prompt was run once on two other models the same day:

| Model | Cost | Compared with `gpt-6.1-sol` |
| --- | --- | --- |
| `gpt-6-astra` | $0.27 | The same three businesses in the same order |
| `gpt-6-luna` | $0.033 | The same first two, a different third, and longer business names |

Searches are a flat rate on every model, which puts a floor of 2 to 3 cents under any check. The
model and how hard it reasons are tuning values (`chatgpt.model`, `chatgpt.effort`). The provider reports each call's usage as it makes it,
and the runner stores it in `provider_usage` (see "How a scan runs"), so the average can be read
from that table once real scans run.

**Claude** (`apps/api/src/providers/claude.ts`) calls Anthropic's Messages API through its SDK
with the `web_search` tool, located in the location's city, and asks for the answer, the
businesses it named and the pages it relied on as JSON. Three things about it are deliberate:

- **Sources come from the answer, checked against the search.** With a JSON output format Claude
  attaches no citations to its text, so the provider asks for the URLs it relied on and keeps
  only those the search really returned.
- **Searches are called directly and capped.** The tool's default filters results through code
  execution; on the trial prompt that took twice the time and tokens for a similar answer. The
  cap is a tuning value and is the main cost control.
- **A declined prompt is re-run on Anthropic's fallback model** (`fallbacks: "default"`), so a
  scan does not fail on a safety classifier. The usage rows record which model answered.

**Cost of one Claude check: about 7 cents** on the default tuning: `claude-sonnet-5-5`, low
effort, one search. This is from a single live call on 2026-10-06, so treat it as a first reading
and not an average:

| Part | Used | Rate | Cost |
| --- | --- | --- | --- |
| Input tokens | 23,392 | $2 per million | $0.047 |
| Output and thinking tokens | 1,029 | $10 per million | $0.010 |
| Web searches | 1 | $10 per 1,000 | $0.01 |

Anthropic bills search results as input tokens, and on a turn with several searches the earlier
results are read again each time, so the number of searches drives the cost more than the model
or the effort does. The same prompt run other ways the same day:

| Model | Effort | Search cap | Cost | Searches run | Input tokens |
| --- | --- | --- | --- | --- | --- |
| `claude-sonnet-5-5` | low | 1 | $0.067 | 1 | 23,392 |
| `claude-opus-5-5` | low | 1 | $0.089 | 1 | 13,676 |
| `claude-opus-5-5` | medium | 3 | $0.14 | 2 | 22,591 |
| `claude-sonnet-5-5` | low | 3 | $0.22 | 3 | 87,228 |
| `claude-sonnet-5-5` | medium | 3 | $0.28 | 3 | 116,775 |
| `claude-opus-5-5` | medium | 5, filtered search | $0.27 | 5 | 44,890 |

Sonnet searches up to whatever cap it is given and reads more input per search than Opus, so it
is only the cheaper model when the cap is one. All six runs named an overlapping set of
businesses; one run each cannot show whether fewer searches give a worse answer. The model, the
effort and the cap are tuning values (`claude.model`, `claude.effort`, `claude.max_searches`).
The provider reports each call's usage the same way, including a call whose answer was then refused or unusable.

**Gemini is not built on Google's API, on purpose.** Google's terms for Grounding with Google
Search do not allow grounded results to be stored, analysed or collected into a database, and a
scan does all three. One trial call on 2026-10-06 worked and cost about 3 cents, nearly all of it
search queries; the result was not kept. Gemini results would have to come from a data vendor.

## Rates over a window of scans

An assistant can name different businesses for the same prompt an hour apart, so one answer is a
sample. The product reports and scores over a window instead (`SCAN_WINDOW`, seven scans):

- **A cell is one prompt on one surface.** The grid shows "x of y": how many of the cell's checks
  in the window named the business. The latest answer is shown beneath.
- **The score averages each cell over its own checks, then averages the cells.** A prompt added
  yesterday counts as much as one tracked all week.
- **The newest scan decides which cells exist.** A retired prompt, or a surface no longer
  checked, drops out of the rate at once. A scan that asked only retired prompts adds nothing,
  and the number of scans the page reports (`scansCounted`) leaves it out.
- **Prompts are retired, never deleted.** Deleting one would delete every result recorded for
  it. A retired prompt is not scanned; restoring it brings its earlier results back into the
  window where they still fall inside it. Members have no delete permission on the table.
- **The window counts scans, not days.** It works unchanged whatever the organization's cadence.
- **Sample scans and real scans never share a window.** Each scan records `sample_data` when the
  worker starts it (the deployment is in mock mode, or the organization is a test one), and a
  window holds scans of one kind only.
- **A scan's `visibility_score` is the score over the window that scan closed**, so the history
  of scores is already a rolling figure.

A new location has one scan in its window and reads "named" or "not named" until more arrive.

Each cell also carries its `history`, whether each check in the window named the business, which
the grid draws as a strip of dots. The chart of the score over time on the location page plots
each successful scan's `visibility_score` from `GET /api/locations/:id/scans`, on a fixed 0 to
100 axis, and only for scans of the same kind as the latest one.

**One scan in flight per location.** A partial unique index on `scans (location_id)` for the
`queued` and `running` statuses makes a second insert fail, whoever makes it: two requests
arriving together, or the scheduler racing a manual scan. The API reports it as
`scan_in_progress`; the scheduler skips the location. A redelivered message for a scan that
already failed is skipped when a newer scan for the same location is in flight.

Failure handling in `runScan`:

- **Nothing to check, or no provider configured**: the scan is marked failed and the message is
  acknowledged. Retrying would not help.
- **Live mode on the default tuning**: every scan is marked failed with a reason, before any
  provider is called. A build without the private file must not store placeholder results as
  measurements.
- **A provider throws**: the scan is marked failed with the error, and the error is rethrown so
  the queue redelivers. A redelivered scan re-runs from scratch and replaces any earlier results.
  After `max_retries` the message goes to the dead-letter queue.
- **One failed check fails the whole scan.** Scoring a partial scan would move the number for
  reasons unrelated to the business. Revisit this once real providers show how flaky they are.
- **A failed scan changes no alert.** Alerts are written only by `complete_scan()`, with the
  results (see "Alerts"), so a failed scan neither raises nor clears one. Failing to read the
  alerts fails the scan like any other error.
- **A report that is not sent does not fail the scan, and leaves its alerts untold.** The report
  comes after `complete_scan()`. Failing to send it is logged and the scan stands as succeeded.
  `notify` answers whether the report went to anyone, and it answers false when the organization
  has no owner with an address. Failing to read what is still to tell is logged too, and the
  report goes without its alerts. In each case the alerts stay untold and lead the next report. If the report went and keeping that it went fails, that is
  logged too, and the next report says the same alerts again (see "Alerts").

## Where the answers come from

Every stored result of an assistant check carries the pages that answer cited. `summarizeSources`
(`packages/shared/src/sources.ts`) turns a set of answers into one row per site: how many answers
cited it, how many of those answers named the business, whether it is the business's own site,
and its most cited pages. A site counts once per answer. The location route computes it over the
same pool the rates use and returns it in `window.sources`; an audit stores it per cell and
`toPublicAudit` adds the cells together.

It is a statement about answers, not about pages. "Named in 0 of 6" means none of the six answers
that cited the site named the business. Nothing fetches the site to see whether the business is
on it.

Two recommendation rules read it (`packages/shared/src/recommendations.ts`):

- `source:<host>`: a site other than the business's own, cited in at least two answers, where no
  answer that cited it named the business, and that does not look like a competitor's own site (see
  "The action plan"). At most three, most cited first. The action plan's `get_listed` step chooses
  its sites with the same code (`unnamedSources`), so the two never disagree.
- `own_site_uncited`: the location has a website and none of at least four answers cited it.

The rule for adding a rule, settled in issue #14: none ships without a stated way to tell from a
later scan that acting on it worked, and that condition must be the same one that stops the rule
firing, because `complete_scan()` resolves a recommendation whose rule no longer fires. Neither
rule claims that an action causes an assistant to name a business.

## The on-page check

A scan, and the first prompt of an audit, also read the business's own home page. The split is the
same as for providers: `fetchSite` (`apps/api/src/site/fetch.ts`) only fetches and returns a
`SiteSnapshot`; `analyzeSite` (`packages/shared/src/site.ts`) decides what it means and returns a
`SiteCheck`, a fixed list of pass or fail checks.

| Check | Passes when |
| --- | --- |
| `reachable` | The home page answers 200 with HTML. When it does not, no other check is reported, and this one fails only if the address leads nowhere (404, 410, or a 200 that is not HTML). No answer, 401, 403, 429, a 5xx or a refused redirect makes no claim at all: the `SiteCheck` has no checks, because one failed fetch does not show the site is down or that an assistant cannot read it. |
| `crawlers_allowed` | `robots.txt` does not shut the assistants' search crawlers (`ANSWER_CRAWLERS`) out of the whole site. Crawlers that gather training data are not checked, and neither are the fetchers that act for one user and may ignore `robots.txt` (`ChatGPT-User`, `Perplexity-User`). |
| `indexable` | No `noindex` in a robots meta tag or the `X-Robots-Tag` header. |
| `text_content` | The page has at least `MIN_PAGE_WORDS` words with scripts, styles and tags removed. Nothing is rendered, because the crawlers mostly do not run scripts. |
| `names_business` | The title or text contains the business name, matched the way answers are matched. |
| `names_city` | The same for the city. Left out when the location has none. |
| `structured_data` | A JSON-LD block gives something both a `name` and an `address`. |

Each failed check becomes a `site:<check>` recommendation, which clears when a later scan's fetch
passes it. A site that will not load never fails the scan. One that leads nowhere is the finding;
one that merely failed to answer is shown as tried and not checked, and an earlier
`site:reachable` recommendation clears. With no
`inspectSite` given to the runner (a deployment on sample data, or a test), no claim is made
about the site and no site rule fires. A scan keeps its whole `SiteCheck` in
`scans.site_check` (see "The action plan"), and an audit keeps it in its first prompt's part; both
pages show it as a checklist.

The address is typed by a user, so the fetch treats it as hostile: `http` and `https` on default
ports only, no IP addresses or internal names, every redirect checked the same way before it is
followed (at most four), an eight second timeout, and the body cut off at 600 kB. It sends
`User-Agent: NearcitedBot/1.0 (+https://nearcited.com/bot)`. It asks for the home page a second time when the first try got no
answer or a 429 or 5xx, so it makes at most fifteen requests (the page twice and `robots.txt`, each
with up to five including redirects).

## The action plan

`buildActionPlan` (`packages/shared/src/action-plan.ts`) turns the evidence into an ordered list of
at most four steps. The location route calls it over the scan window and `toPublicAudit` calls it
over an audit's samples, so both pages show the same plan from the same code.

| Step | Shown when | Evidence it carries |
| --- | --- | --- |
| `fix_website` | The on-page check failed something, at any answer count; or every check passed (or none was made, or the page could not be loaded) and no answer cited the site, of at least four. | The failed checks, as the reasons, each with its fix. |
| `get_listed` | A site was cited in at least two answers and none of them named the business. | Up to three such sites, the ones the `source:<host>` rule chooses, with the page that was read. |
| `keep_listings` | A site was cited in answers that did name the business. | Up to five, most often first. |
| `competitors` | The answers named other businesses. | The three named most, linked to their own site when it was one of the pages read. Among businesses named equally often, one with such a link comes first. |

Steps are composed by rule, never by a model, and each states the observation it rests on. For
`fix_website` on a site no answer cited, the title and summary depend on whether a failed check
blocks reading (`BLOCKS_READING`: `reachable`, `crawlers_allowed`, `text_content`).
A site whose address contains a named competitor's name run together is treated as that
competitor's own, so nobody is told to get listed on a rival's website; that match is a guess and
is used for nothing else. The same match keeps such a site out of the `source:<host>` rule. A name
is also matched with "&" or "and" dropped.

A location's on-page check is kept in `scans.site_check`, written by the worker just before it
completes the scan, so the page can show the whole checklist and the plan can give reasons. The
recommendations a scan stores are unchanged; the location page leaves the ones the plan already
covers (`source:*`, `site:*`, `own_site_uncited`) out of its list.

## Tasks

A task is a `source:<host>` recommendation put as work for the owner to do and mark done
(`buildTasks`, `packages/shared/src/tasks.ts`; the vocabulary is in
`docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md`). The location route returns
them as `tasks`, and the Overview tab shows them under "Your tasks". Everything is composed by rule
from counts the product holds; nothing a model wrote is in one.

- **Wording follows the source kind.** `sourceKind` (`packages/shared/src/source-kinds.ts`) looks
  the host up in a public list of well-known sites by kind; a subdomain takes its parent's kind,
  and a site not listed is `unknown`. Only a site on the `reviews` list is told to ask customers
  for reviews. A site whose rules forbid asking (`reviews_unasked`) is told to claim and complete
  the listing, and an `unknown` site is told to see whether it can be listed at all. A site goes
  on the `reviews` list only when its rules are known to allow asking.
- **Marking one done** sets `recommendations.acted_at` through `PATCH /api/recommendations/:id`
  with `{ "acted": true }`, or clears it with `false`. A member may update that one column
  (a column grant); a trigger replaces whatever time is sent with `now()`. `complete_scan()` never
  writes it, so no scan moves or clears the mark. A recommendation whose rule has stopped firing
  is resolved by `complete_scan()` as before; the task stays in view if it was marked (the three
  most recently marked), worded as no longer among the sites read most.
- **An action that did the work marks it instead.** `finish_action()` sets `acted_at` and
  `acted_by_action` when it records `done` for an action that points at the task
  (`recommendation_id`), in place of a member's own mark if they had made one, and leaves a mark an
  earlier action made. The trigger then refuses a member's change to that time (`NC013`), so
  `PATCH /api/recommendations/:id` with `acted` answers 409 `limit_reached`, and the task says
  "Done by Nearcited" and offers no Undo. A member's own mark is unchanged: they can clear it.
- **Showing whether it worked.** For a marked task the route counts, for the site, how many answers
  cited it and how many of those named the business, over the seven scans before the mark
  (`SCAN_WINDOW`) and over every scan since, at most `MAX_SCANS_SINCE` (60). These are read by
  `Store.listResultsAround`, separately from the rate window, because that window moves on and the
  mark does not. With fewer than `MIN_ANSWERS_SINCE` (2) answers since, the page says it is too
  early to compare. The two counts are set side by side; nothing says the work caused the change.
- A dismissed recommendation has no task. Ticks on action-plan steps are still kept in the browser
  only. The operator's read-only view hides the buttons.
- Not built: anything a model drafts, a direct review link, a printable code or request text, page
  copy as a task, and anything the product does outside itself for real. Approvals and actions
  exist (see "Actions") but the only kind is a sample one, which does no task's work, so no action
  has marked a task.

## Alerts

An alert says that something measured got worse at a location (`alerts`; the term is in
`GLOSSARY.md`, the decision in `docs/adr/0015-an-alert-is-kept-not-worked-out-again.md`). The only
kind is a drop. The rule, the sentences and the grouping are in `packages/shared/src/alerts.ts`
(`deriveAlerts`, `alertTitle`, `alertDetail`, `groupAlerts`). Everything is composed by rule from
counts the product holds, says what was seen and never what to do, and no model writes one.

- **A drop is a prompt on one surface that named the business and has stopped.** It is raised when
  the latest `DROP_MISSES` (3) checks of the cell did not name the business and at least
  `DROP_NAMED_BEFORE` (3) of the `DROP_CHECKS_BEFORE` (4) before them did. It needs all seven
  checks in the cell, a full `SCAN_WINDOW`, so a new location or a new prompt is quiet for its
  first seven scans. The thresholds are public constants, not tuning. The row keeps the counts it
  rests on (`facts`: the prompt as asked, how many checks in a row missed, how many came before
  and how many of those named the business) and when the run of misses began (`since`). A drop
  that could not be raised at its third miss (the cell's window was not yet full, or alerts did
  not exist yet) counts the whole run it can see, up to four.
- **What raises one and what clears one are different conditions.** After seven scans that did not
  name the business the window holds nothing that says it ever was, so a rule that looked only
  there would stop firing and clear an alert that had not ended. `runScan` gives `deriveAlerts`
  the window and the location's alerts that are not cleared (`listAlerts`). One is cleared as
  `named_again` when a check from a scan after the one that raised it names the business (any
  scan in the window, once the one that raised it has left), and as `not_tracked` when the newest
  scan has no cell for it: its prompt is retired or its surface is no longer checked. Never by
  age.
- **A dismissed alert is still current.** Dismissing takes it off the page and nothing else. The
  rule goes on firing, and a unique index allows one alert that is not cleared for a location,
  kind, subject (here the prompt and surface) and kind of data, so the same thing is not raised
  again until the worker has cleared it and it begins afresh. `complete_scan()` raises with
  `on conflict do nothing`, so running a scan twice raises nothing twice.
- **They are written with the scan.** `runScan` passes `alerts` (`{ clear, raise }`) to
  `completeScan`, and `complete_scan()` clears and raises them in the same transaction as the
  results, for manual and scheduled scans alike. A clear names an alert by its ID and touches only
  the scan's own location. The alerts are an optional fifth argument, so the Worker deployed
  before the migration, which passes four, goes on working and changes none.
- **Sample and real alerts are kept apart.** `alerts.sample_data` records whether the scan that
  raised it ran on generated data, and `listAlerts` and the location page take only the kind the
  page is showing, as the window does (see "Rates over a window of scans").
- **Who reads and writes.** `alerts` has a `select` policy for whoever can read the location
  (`can_access_location`) and one for the operator, and no write grant for any API role. Only the
  worker raises or clears one, through `complete_scan()`, and only the worker keeps that its owners
  were told (`markAlertsTold`, an update the secret key alone may make).
  `POST /api/alerts/:alertId/dismiss` calls `dismiss_alert()`, a security-definer function that
  returns a row only to a member of the location's organization, so the route answers 404 to
  anyone else, the operator included. It keeps who dismissed (the address they had then) and when,
  and changes nothing about an alert already dismissed or cleared. `subject`, `told_at` and
  `cleared_told_at` are the worker's bookkeeping, and no route sends them. An alert is deleted
  with its location.
- **What the page shows.** `GET /api/locations/:id` returns `alerts`: those not cleared, not
  dismissed and not about a prompt retired since the last scan, newest first. The next scan clears
  one about a retired prompt; one about a surface that is no longer checked shows until it does.
  The Overview tab lists them under "Alerts", above "What to do next". The drops one scan raised
  on one surface are one card (`groupAlerts`), because a surface that stops naming the business
  does so for every prompt at once; each says what was counted and since when, links to the
  Prompts tab, and has a Dismiss that dismisses the whole card. The locations table shows the
  count beside the location. The operator reading through an account sees alerts and has no
  Dismiss.
- **The owners are told in the scan report, once.** A scheduled scan's report already goes to the
  organization's owners where the deployment has a Resend key, the plan emails a report
  (`emails_report`) and the organization is not a test one, so an alert goes in that report and
  has no message of its own. Before sending, `runScan` asks `listAlertsToTell` what is still to
  say, for the kind of data the scan ran on (`AlertsToTell`, in `packages/shared/src/alerts.ts`):
  `raised`, the alerts not cleared, not dismissed and not yet told (`told_at` is null), and
  `named_again`, the drops the owners were told of that ended as `named_again`, were not
  dismissed, and whose ending is not yet told (`cleared_told_at` is null). They go on the report
  as `alerts`. `buildScanReportEmail` puts new alerts first, in the subject and at the head of the
  message. One group of them gives the subject `<location>: no longer named for "<prompt>" on
  <surface>`, or `no longer named for N prompts on <surface>` when the group is several (keywords
  on a Google surface); several groups give `<location>: N new alerts`, N counting alerts. Then
  comes one line for each drop that ended (`alertEnded`), then the report as it was. With nothing
  new, the subject and the message are what they were.
- **An alert is marked told only when the report went to someone.** `notify` answers whether it
  did (false, when the organization has no owner with an address), and only then does `runScan` call
  `markAlertsTold`, which sets `told_at` for the new alerts and `cleared_told_at` for the endings.
  A report that fails, or goes to nobody, leaves them untold for the next one (see "How a scan
  runs"). A manual scan sends no report, so what it raised goes in the next scheduled one if it is
  still open. An organization whose plan sends no report, or a deployment with no Resend key, tells
  no one of an alert, and the alerts still open go in its first report once it can send one.
- **What is not told.** An alert a member dismissed before it was sent. That a dismissed alert
  ended, even one the owners had been told of. That an alert ended because its prompt was retired
  or its surface is no longer checked (`not_tracked`). A drop that began and ended between two
  reports. Anything for a test organization. Telling changes nothing the page shows.
- Not built: the other kinds named in
  [#136](https://github.com/jwh3times/Nearcited/issues/136): a competitor named for the first
  time, a site read for the first time, and an answer that gives a phone number or address that is
  not the location's.

## Shareable audits

An audit is a one-off report for a business with no account (`packages/shared/src/audit.ts`). It
exists so a prospect can be shown a measurement without waiting for a window of daily scans to
fill.

```
npm run audit:create (owner, secret key)
        |
insert audits row (queued) ; one message per prompt: { audit_id, prompt_index }
        |
     SCAN_QUEUE  (the same queue as scans)
        |
queue consumer: runAuditPart()
        |
   the prompt, asked `samples` times on each configured assistant
        |
   buildAuditCell() per assistant -> record_audit_part()
        |
   ready once every prompt has reported
```

- **One message per prompt.** Each answer is a subrequest and a whole audit can be dozens, so one
  prompt per invocation stays inside what a Worker may do. A prompt asked again replaces its
  earlier result, so redelivery is safe.
- **Each prompt is asked `samples` times (up to 5) on each assistant.** A cell keeps the number of
  checks and mentions, the positions, the competitors, one excerpt and the cited pages. The
  providers and `analyzeObservation` are the ones scans use.
- **It refuses what a scan refuses.** On sample data, or on the default tuning in live mode, the
  audit is marked failed with a reason and the message is acknowledged. Any other error is
  recorded on the audit and rethrown so the queue redelivers; a later success clears it.
- **An audit that never finishes is failed.** A prompt that exhausts its retries never reports, and
  a later prompt's success sets the audit back to `queued`. `failStaleAudits` marks an audit still
  `queued` 30 minutes after creation as failed ("Some prompts could not be checked."). The prompts
  that finished stay and the page keeps showing them; if the missing prompt reports later, the
  audit becomes ready as before.
- **A revoked audit is skipped.**
- **No public endpoint creates an audit.** One would let anyone spend the provider budget, and
  a customer's would have to decide whose budget it was. The operator makes one with
  `POST /api/operator/audits` (see "The operator makes an audit the same way" below), or with the
  secret key from `scripts/create-audit.mjs`.

**Access is by token through a function, not by row-level security.** An audit belongs to no
organization, so there is no membership for a policy to test, and the reader has no account. The
table is closed to `anon`, and to `authenticated` except for the operator (row-level security on;
`authenticated` has `select` and one policy that answers only `is_operator()`; writes are granted to
`service_role` alone). `get_audit(token)` is `SECURITY DEFINER` and callable by `anon`: it
returns the one audit whose 64-character token matches while it is neither revoked nor past
`expires_at` (30 days), and only the fields the page shows. Otherwise it returns null, which
`GET /api/audits/:token` reports as 404 without saying which case it was. The route is registered
before the sign-in middleware, builds its client from the publishable key (`createAnonClient`),
never the admin client, and sets `Cache-Control: private, no-store` and
`X-Robots-Tag: noindex, nofollow`, because the link is the secret. `record_audit_part()` is
callable by `service_role` only.

The web pages at `/audit/:token`, `/privacy`, `/terms` and `/bot` are rendered before the sign-in gate; the audit page polls while the
audit is queued.

## Connections

A connection is an organization's standing sign-in to an outside account (`connections`; the term
is in `GLOSSARY.md`, the decision in `docs/adr/0013-a-sign-in-is-sealed-by-the-worker.md`). What
exists is making one, listing them, reading what one reaches, saying which of those is each
location's, breaking one that stops working, pausing one the plan stops including, and removing
one. The only kind is `sample`. Nothing yet reads anything else from an account, and the only
thing done through one is the `sample` kind's action (see "Actions"). The `sample` kind never fails
and needs no allowance, so until a real kind exists nothing breaks or pauses in practice, though
the rules for both are built and tested.

- **Only an owner or admin connects or removes.** `create_connection()` and
  `request_connection_removal()` are security-definer functions that return no row to anyone else,
  so `POST /api/organizations/:organizationId/connections` and `DELETE /api/connections/:connectionId`
  answer 404 as they do for a stranger. Members read their organization's connections through a
  `select` policy, the operator reads all of them, and no API role writes the table directly.
  `GET /api/organizations/:organizationId/connections` also says whether the caller may change
  them (`can_manage`, from `has_org_role`), which is false for a plain member and for the operator
  reading through the account.
- **The sign-in is sealed by the Worker and kept apart.** `apps/api/src/connections/seal.ts` seals
  it with AES-256-GCM under `CONNECTIONS_KEY`, a Worker secret of 32 random bytes in base64. Each
  sealing uses a fresh nonce and authenticates the connection's ID, so sealed text moved to
  another connection's row does not open. It is stored in `connection_secrets`, which has
  row-level security on, no policy and no grant to any API role, the operator included. Only the
  Worker's secret key reaches it, and `getConnectionSecret` is the only read. `connections`
  has no column for it, and no route or wire type carries a sign-in, sealed or not. A request
  writes a sign-in and never reads one: the Worker chooses the connection's ID, seals the
  sign-in to it and hands the sealed text to `create_connection()`, which stores both rows in one
  transaction.
- **Removal is two steps.** `DELETE /api/connections/:connectionId` calls
  `request_connection_removal()`, which marks the connection `removing` and records who asked (as
  the address they had then) and when. The route then queues `{ connection_id, step: "remove" }`,
  and the queue consumer runs `removeConnection`: it opens the sign-in, takes back the access at the outside
  service, then calls `finish_connection_removal()`, which only the worker may call. That marks
  the connection `removed`, clears what it reached, deletes the sign-in and the matches, and keeps
  the row as a record of who connected it and who removed it. Asking twice changes nothing
  recorded, and running the step twice is safe: `finish_connection_removal()` answers false when
  none is waiting. A sign-in the Worker cannot
  open (another key, or none) is deleted all the same, without taking the access back. The
  `sample` kind has none to take back.
- **A lost message is asked for again.** If the send fails, the request still succeeds and logs it.
  If a step throws, the queue redelivers it, and after `max_retries` it goes to the dead-letter
  queue. Either way the connection stays `removing`, and every run of the schedule queues again
  (`requeueStalledRemovals`) each removal asked for more than 15 minutes ago.
- **A sync reads what the sign-in reaches.** Connecting queues `{ connection_id, step: "sync" }`;
  if the send fails the request still succeeds and logs it. The queue consumer runs
  `syncConnection`: it opens the sign-in, reads the list of things the account reaches (a profile,
  a site, a property: each an `id` and a `label`) and hands it to `record_connection_sync()`, which
  only the worker may call. That keeps the list in `connections.choices` and sets `last_synced_at`;
  only the worker writes either. Nothing else is read from the account. The `sample` kind reaches
  three sample listings and asks nobody anything. A `working` connection is read, and so is a broken
  one that only kept failing (below); any other is left as it is. So is one whose sign-in the
  Worker cannot open (another key, or none): that is reported `unreadable` and acknowledged, since
  trying again would not help, and it does not count as a failed read. Running a sync twice is
  safe. There is no "sync now".
- **The schedule keeps it fresh.** The daily run queues a sync for every working connection, and
  every broken one that only kept failing, never synced or last synced more than 20 hours ago
  (`enqueueDueSyncs`, through `connections_due_for_sync()`, longest-waiting first, at most 100 a
  run in one `sendBatch`). Every run also queues again the first sync of a connection made in the
  last day, and more than 15 minutes ago, that still has none (`requeueFirstSyncs`), so a lost
  message does not leave the owner waiting for the daily run.
- **A connection breaks when it cannot be read.** `syncConnection` keeps a failed read through
  `record_connection_failure()`, which only the worker may call. A read that throws `SignInRefused`
  (the outside service refused the sign-in: the password changed, or the access was taken away
  there) breaks the connection at once, with `broken_reason` `refused`. Any other failure counts one
  for that day (UTC; `failed_days`, `last_failed_on`) however often it was tried, and the third day
  in a row breaks it, with `broken_reason` `failing`. The function answers nothing for a connection
  that is neither working nor broken, and says whether this failure is what broke it. The queue
  message is acknowledged either way; the daily run tries again.
- **One that only kept failing mends itself; one that was refused waits.** A `failing` connection is
  still synced once a day, and a read that works (`record_connection_sync()`) makes it `working`
  again and starts its count over. A `refused` one is not read at all. Its owner removes it and
  connects the account again: signing in again without removing it is not built.
- **Its owners and admins are told.** When a failure is what broke the connection, `syncConnection`
  emails the organization's owners and admins (`listManagerEmails`; the wording is
  `apps/api/src/email/connection-broken.ts`) and keeps when (`broken_told_at`). The daily run
  reminds them once, a week after they were told, if it is still broken
  (`remindBrokenConnections`; `broken_reminded_at`). If the email could not be sent when it broke,
  the daily run sends it (`tellBrokenConnections`), and the reminder is a week after that. No
  email goes for a test organization, nor where `RESEND_API_KEY` is not set. A send that fails is
  logged and does not undo what was recorded. Mending clears all of it, so a connection that
  breaks again is told again.
- **A plan that stops including a kind of connection pauses it.** `connection_kind_allowances` says
  which allowance a kind needs, and a kind not listed needs none: it is empty, since `sample` needs
  none. `CONNECTION_KIND_ALLOWANCES` (`packages/shared/src/schemas.ts`) is the same list, and a test
  in `packages/db` holds the two equal. The table has row-level security on, no policy and no grant
  to any API role. `create_connection()` refuses a kind the organization's allowances do not include
  (`NC012`), and `availableConnectionKinds` leaves it out. `fit_connections_to_plan()`, which
  `apply_plan()` and `operator_set_limits()` call, pauses the organization's working or broken
  connections of a kind its allowances no longer include (`paused_at`), and brings back the paused
  ones they include again, broken if it was broken. A paused connection is not read, and matching
  refuses it, with the reason. Its sign-in is kept, so going back to the plan restores it without
  signing in again.
- **After thirty days paused it is removed.** The daily run calls `expire_paused_connections()`
  (`expirePausedConnections`), which only the worker may call. It marks each connection paused for
  thirty days `removing`, with `removal_reason` `plan`, and queues the `remove` step for each, which
  the worker finishes like any removal and keeps the row as the record. A removal someone asked for
  records `removal_reason` `asked`.
- **Matching says which of those is a location's, and only an owner or admin can.**
  `PUT /api/connections/:connectionId/locations/:locationId` calls `match_connection_location()`
  and `DELETE` on the same path calls `unmatch_connection_location()`. Both are security-definer
  functions that return nothing to anyone but an owner or admin of the connection's organization,
  and nothing for a location of another organization, so the routes answer 404. Matching refuses,
  with the reason (error code `NC012`, a `limit`, so 409 `limit_reached`), a choice the account
  does not reach, one that is already another location's, a location that already has an account
  of the same kind (two would leave no saying which acts), and a connection that is not `working`
  (a broken one, a paused one and one being removed each say why).
  Matching again replaces the earlier match. A match keeps its choice through later syncs and takes
  the name the choice has then. A match also queues a sync, so the worker can propose actions for
  the location without waiting for the daily run; if the send fails, the request still succeeds and
  logs it.
- **Matches are read with the location.** `connection_locations` has a `select` policy for whoever
  can read the location (`can_access_location`) and one for the operator, and no API role writes
  it. `GET /api/organizations/:organizationId/connections` carries each connection's `choices` and
  `matches`, and `GET /api/locations/:id` the `connections` it is matched to.
- **The sample kind is offered only where the data is generated.** `availableConnectionKinds`
  returns `sample` for a deployment in mock mode, or for a test organization in any deployment,
  and nothing otherwise, and leaves out a kind the organization's allowances do not include. It
  makes up a sign-in and calls the account "Sample account", so the path runs with no outside
  account.
- **Without the key nothing can be connected.** With no `CONNECTIONS_KEY`, `available` is empty and
  `POST` answers 503 `connections_unavailable`. A kind that is not offered answers 422
  `connection_unavailable`. A value that is not base64, or not 32 bytes, throws instead of
  sealing weakly. Changing the key makes every sign-in already kept unreadable (see "Known gaps").

The Connections page is at `/connections`, and at `/operator/o/:organizationId/connections` for
the operator reading through an account, where `can_manage` is false and nothing on it can be
changed. The sidebar links to it once an account has been connected or one could be, and says how
many are not working. For each account the page says when it was last read and, once it has been,
lists the locations: an owner or admin chooses which of the things the account reaches is each
one's (what is another location's already is not offered), and anyone else reads the match. A
location's Settings tab has a "Connected accounts" card while it is matched to something. A broken
account says why, a paused one says until when its sign-in is kept, and a removed one says whether
somebody removed it or its plan had not included it for thirty days. While a removal is waiting, or
a new account has not been read yet, the page asks again every couple of seconds.

## Actions

An action is one thing the product does outside itself for a location, once a member says yes
(`actions`; the terms are in `GLOSSARY.md`, the decision in
`docs/adr/0014-only-the-worker-carries-out-an-action.md`). It is `proposed`, then `approved` and
`done` or `failed`; a proposed one can instead be `declined` or `lapsed`. The only kind is
`sample`: it sets the opening line of one of the sample account's listings, rows in
`sample_listings` that stand in for an outside service, so nothing leaves the product. There is no
real kind, so nothing is counted against an allowance and no action marks a task yet (see "Known
gaps").

- **Only the worker proposes.** After a sync that read a connection (`syncConnection` answers
  `synced`), the queue consumer calls `proposeAfterSync`. For each location matched to a working
  `sample` connection it composes an opening line by rule from the location's name and city
  (`sampleOpeningLine`) and, when the listing does not already say that, calls `propose_action()`,
  which only the worker may call. The proposal keeps what the listing said (`seen`), the text, and
  that a rule wrote it. Matching a location queues a sync (see "Connections"), so a proposal
  appears without waiting for the daily run. No request proposes.
- **One open action for a thing, and a no is remembered.** `subject` (what it is about) and `basis`
  (what the proposal rests on; here, the proposed text) are the worker's bookkeeping, and no route
  sends them. A partial unique index allows one `proposed` or `approved` action for a location, kind
  and subject. `propose_action()` makes none, and returns no row, while one is open, or while a
  declined one rests on the same `basis`. A lapsed one does not stop a new proposal.
- **Each kind is held to terms.** `action_kind_terms` has a row for a kind: the allowance it takes
  from (null for none) and how many days what it replaced may be kept (null for no limit). A kind
  with no row is held to nothing. No API role reads or writes it. The `sample` kind takes from no
  allowance and is given 30 days, though nothing limits how long a made-up listing may be held, so
  that dropping can be seen where the data is generated.
- **A request records the answer.** `approve_action()`, `decline_action()` and `retry_action()` are
  security-definer functions that return a row only to a member of the location's organization
  (`can_access_location`), so their routes answer 404 to anyone else, the operator included. An
  action that is no longer waiting, or whose kind has no room left this month, raises `NC013`, a
  `limit`, so 409 `limit_reached` with the reason. A member may change the text while approving: `approved_text` then keeps it beside
  `proposed_text`, and stays null when the text sent is what was proposed. Who answered is kept as
  the address they had then. Approving and asking again queue `{ action_id, step: "carry_out" }`; if
  the send fails, the request still succeeds and logs it.
- **Asking again is a new action.** `retry_action()` takes a `failed` action and makes another,
  already `approved` by whoever asked, with `retry_of` pointing at the one that failed, so the
  record keeps who approved each try. It refuses an action that did not fail, and one that has
  another waiting or on its way (`NC013`). The new action is for the same task and keeps the first
  one's `seen_until`.
- **It is carried out once, and only by the worker.** `carryOutAction` first calls
  `claim_action()`, which counts the try and, where the kind takes from an allowance, takes one
  from the month's (below). It answers zero, and the worker goes no further, unless the action is
  approved and no worker has had it in the last ten minutes. The worker then finds
  the connection, the location's match and the opened sign-in; if the connection is not working,
  the match is gone or the sign-in will not open, the action fails with that reason. Then it reads
  what is there. If that is already the text to put there (what was approved, which is the proposal
  unless a member changed it), the action is `done` and nothing is written: that is what makes a
  message delivered twice harmless. If it is not what the member was shown, nothing is written and
  the action lapses with `lapse_reason` `out_of_date`, since a yes to one change is not a yes to
  another, and so does one whose `seen` was dropped (below), before anything is read; the queue
  consumer then queues a sync of the connection, which proposes a fresh action
  against what is there now. Otherwise it writes the text and records `done`.
  `finish_action()` records each end, and only the worker may call it.
- **A try that does not work is made again, three times in all.** A try that throws is let go with
  `finish_action()` saying `again`, keeping why, and the queue consumer asks for the message to be
  delivered again in ten minutes. The third try that throws fails the action with the reason, and
  so does any try the account refuses (`SignInRefused`), since it would be refused again. Nothing
  retries a failed action by itself; a member asks again.
- **A lost message is asked for again.** Every run of the schedule calls `requeueStalledActions`:
  each action approved more than 15 minutes ago that no worker has (`carrying_since` is null), or
  that a worker took more than 15 minutes ago, goes on the queue again, at most 100 a run. That
  covers a message that was lost, an action the worker let go of to be tried again, and one whose
  worker died: a worker's hold lasts ten minutes, so the next can take it.
- **The owners are told within 48 hours.** The daily run calls `sendActionNotices`: for each
  organization with something to tell, one email to its owners only (`listOwnerEmails`; the wording
  is `apps/api/src/email/action-notice.ts`) saying what was carried out since the last, with who
  approved each (an owner's own approvals included, and whether they changed the text first), and
  what is newly waiting for a yes. `told_at` is when an action counted as told of, and
  `waiting_told_at` when a message said it was waiting; only the worker's secret key writes them
  (`markActionsTold`), and only once the email went. Where `RESEND_API_KEY` is not set on live
  data, nobody is an owner with an address, or the send fails (logged, and the other organizations
  are still told), nothing is marked, so the next daily run tries again. A test organization is
  never emailed: its actions are marked told at once, since the record on its page is the notice.
- **A notice more than 36 hours late holds the organization.** `organization_held()`, which only
  the worker may call, is true while one of the organization's actions was done more than 36 hours
  ago and has no `told_at`, and never for a test organization. While it is, `claim_action()`
  answers zero and `carryOutAction` returns `held` before it claims anything, leaving the action
  `approved`. The queue consumer acknowledges the message, and the schedule's next run queues the
  action again (`requeueStalledActions`), so it goes ahead once the owners have been told. That
  leaves twelve of the 48 hours to write to them by hand: the operator's overview has an
  `action_untold` line for each organization held (`listUntoldActions`; see "Tenancy"),
  and the Actions tab says nothing more is being carried out and why. The tab learns it from
  `location_held()`, which answers whoever can read the location, or the operator, and is false
  for anyone else; the list route returns it as `held`.
- **Where email is not set up, no real action is approved.** `POST /api/actions/:actionId/approve`
  and `/retry` answer 503 `actions_unavailable` when the deployment has no `RESEND_API_KEY`
  (`requireNotice`), before anything is recorded, because the owners could not be told. A
  deployment on sample data and a test organization are let through, and declining is not refused.
  A deployment on sample data with no `RESEND_API_KEY` sends nothing and marks its actions told at
  the daily run, as a test organization's are, because nothing an action did there left the
  product. So it is never held for want of email.
- **What the product wrote is kept; what it replaced only as long as it may be.** The text, who
  approved it and when stay for as long as the action does. `seen` is held until `seen_until`,
  which `propose_action()` sets from the kind's days, counted from the proposal. The daily run calls
  `drop_expired_seen()`, which only the worker may call: it sets `seen` to null once that day has
  passed and records `seen_dropped_at`, which the routes send, and it lapses as out of date a
  proposal still waiting then, since nobody can be shown what it would replace. The record says
  "No longer kept" and the day, in place of what was there.
- **A kind that takes from an allowance is counted when it is carried out.**
  `action_kind_terms.allowance` names the allowance (see "Tenancy"). `claim_action()` calls
  `claim_allowance()` for it as it takes the action, once for all its tries, and keeps the month in
  `allowance_month`; a kind included without a number counts nothing and keeps none. When the month
  has no room, `claim_action()` fails the action there, with the reason, and answers zero, and
  `carryOutAction` returns `failed`. `finish_action()` gives back what was taken
  (`release_allowance()`, into the month it came from) when the action ends `failed` or
  `out_of_date`, and not when it ends `done`. Before that, `propose_action()` proposes nothing of
  a kind whose allowance has no room this month or is not in the plan, and `approve_action()` and
  `retry_action()` raise `NC013` ("Your plan has no more of these this month.") while it has none,
  since a yes that could only fail is better not taken. `allowance_has_room()` answers that
  question, for the worker only. The sample kind takes from no allowance.
- **An action that does a task's work marks it.** `propose_action()` takes the task
  (`recommendation_id`) and refuses one that is not the location's. When `finish_action()` records
  `done` it sets the task's `acted_at` and `acted_by_action` (see "Tasks"), and a failed or
  out-of-date action marks nothing. The sample kind does no task's work, so nothing is marked in
  practice.
- **A proposal nobody answers lapses.** `lapses_at` is fourteen days after it was proposed. The
  daily run calls `lapse_actions()`, which only the worker may call, and `approve_action()` refuses
  one past its day before then. The record says whether it lapsed because nobody answered or
  because it was out of date.
- **Who reads and writes.** `actions` has a `select` policy for whoever can read the location and
  one for the operator, and no write grant for any API role: every change goes through the
  functions above, except `told_at` and `waiting_told_at`, which the Worker's secret key writes.
  `seen_until`, `allowance_month` and `recommendation_id` are the worker's bookkeeping, and no route
  sends them. No API role writes `recommendations.acted_by_action`: only `finish_action()` does.
  `sample_listings` and `action_kind_terms` have row-level security on, no policy and no grant for
  any API role, the operator included; only the Worker's secret key reaches them
  (`getSampleLine`, `setSampleLine`; the terms are read by the functions above, as their owner).

The Actions tab of the location page (`?tab=actions`) is there once the location has an action,
and carries the count of those waiting. It lists what is waiting, each with what is there now, the
text it would put there and who wrote it (editable; the button then reads "Approve as changed"),
"Approve" and "Decline" with a reason of up to 200 characters, and below it the record, newest first
(at most 100 actions in all), with "Try again" on a failed one. The record shows what an action replaced ("What it replaced", or
"What was there" for one that was not done), or "No longer kept" once it was dropped. While an action is approved the
page asks again every couple of seconds. When the organization is held, a notice above the lists says
so. The sidebar says how many are waiting at each location
(`GET /api/organizations/:organizationId/actions/waiting`, asked every 30 seconds). The operator
reading through an account sees the tab and has no buttons.

## Tenancy

Every row belongs to an organization, and a user reaches a row only through a membership. The
exceptions are `audits`, described above, and `provider_usage`, which keeps its rows after the
organization, scan or audit they describe is deleted. No API role can write either table, and
the only account that can read them is the operator's; the Worker's secret key writes them. Four
more, `connection_secrets`, `connection_kind_allowances`, `sample_listings` and `action_kind_terms`,
no API role can read or write at all (see "Connections" and "Actions").

The API does not check ownership in application code. For each request it builds a Supabase
client that carries the caller's own access token (`createUserClient`), so Postgres evaluates the
row-level security policies as that user. A location in someone else's organization simply reads
as missing, which is why those routes return 404 and not 403.

Two rules follow, and breaking either one is a data leak:

1. **Never construct the admin client on a request path.** `createAdminClient` uses the secret
   key, which bypasses row-level security. It belongs in `scheduled` and `queue`, and in the
   one exception below: the payment webhook.
2. **A new table needs policies and explicit grants in the same migration**, and a test in
   `packages/db` that tries to read and write it as a non-member.

**Plans are rows** (`docs/adr/0006-plans-are-rows.md`). `plans` holds what is on sale, and
`GET /api/plans` serves it without a sign-in. An organization's `plan_key` names its plan, or is
null when its limits were set by hand, as for every organization made before plans and any the
operator's limits editor has touched. `apply_plan()` puts an organization on a plan and copies the
plan's values onto it: its limits, its cadence, whether a report is emailed, its allowances, and
its assistants (a plan with one keeps the one the organization already had, and otherwise starts
on ChatGPT).
Only the worker may call it. `create_organization()` uses it to start every new organization on
the free plan; a test account's organization is still set by hand. Where a plan covers fewer
assistants than are offered, the organization's owner picks which through `choose_assistants()`
(`PUT /api/organizations/:organizationId/assistants`), which checks the pick against the plan;
`surfaces` is still not a column a member can write. The limit columns below are what is
enforced.

**A subscription moves a plan only through the webhook** (`docs/adr/0007-the-payment-webhook-acts-as-the-worker.md`).
An owner starts `POST /api/organizations/:organizationId/checkout`, opens
`.../billing-portal`, or changes plan or locations with `.../subscription` (a `preview`, a `PUT`,
and a `DELETE` of a waiting change at `.../subscription/pending`). These are ordinary requests that
learn what they need from `billing_state()`, which answers only the organization's owner (the
operator gets nothing), and write nothing here. A change goes to Stripe: an upgrade (a higher
monthly price, or the same, as worked out on the server from the plans' prices) is made at once and
the prorated difference charged, a downgrade is scheduled for the end of the paid period.
`apps/api/src/billing/plans.ts` reads a subscription's lines for both these routes and the
webhook, and matches a price to its plan by any price the plan has been sold at (`plan_prices`), so a
subscriber on an older price stays on their plan. A new subscriber, or one switching plan, pays what
the plan is sold at now; one changing the locations on their own plan keeps their prices. The organization's plan still moves only when Stripe
reports the change by calling `POST /api/stripe/webhook`, the one request path that uses the Worker's store. The
route verifies the signature, takes from the event only the subscription's ID, reads that
subscription from Stripe, and `syncSubscription` (`apps/api/src/billing/sync.ts`) makes the plan
agree with it, so events that arrive twice or out of order end in the same place. A subscription
in force (`active`, `trialing`, `past_due`) calls `apply_plan()` for the plan its price belongs to,
with the locations paid for, and records it in `subscriptions`. One that is over (`canceled`,
`unpaid`, `incomplete_expired`) moves the organization to the free plan, but only when it is the
subscription recorded for that organization. A subscription billing a price no plan has is an
error, so Stripe retries and someone sees it. When the outcome is `applied` the route also thanks the
organization's owners by email (`thankForSubscription`, `apps/api/src/billing/started.ts`): the plan,
the locations paid for, the monthly price before tax and the renewal day, with a link to settings.
Stripe reports a new subscription several times close together, so the Worker first calls
`claim_subscription_start()` (`service_role` only), which sets `subscriptions.welcomed_subscription_id`
in one statement and answers true to the first caller for a subscription. Only that caller sends. A
failure to send is logged and does not fail the webhook, and since the claim is made the email is not
retried. Subscriptions that existed before the column were marked as thanked. `subscriptions` has no write grant for any API role;
the operator has a `select` policy on it. A test organization cannot subscribe.

**Usage caps live on the organization** (`max_locations`, `max_queries_per_location`,
`max_manual_scans_per_month`) and are enforced by triggers, because a limit checked only in a route
handler could be skipped by calling the database directly. Four things about them are deliberate:

- **The triggers fire after the row is written.** Row-level security has had its say by then, so
  a non-member is refused as a non-member and never learns whether a limit was reached.
- **They lock the organization row**, so two inserts arriving together are counted one at a time.
- **Only active prompts count**, and restoring a retired one is checked like adding one.
- **A member cannot change the limits.** The update grant on `organizations` covers `name` only.
  Limits come from the organization's plan, or from the operator's limits editor.
- **Scans by hand are counted over a calendar month in UTC.** An organization's first scan ever
  is let through and not counted (`first_scan_at` records it), which is how a new account on the
  free plan, which allows none by hand, sees the product work once.
  The count lives on the organization (`manual_scans_month`, `manual_scans_used`), not in the
  `scans` table, so deleting a location does not give its scans back.

**The limits are an organization's, so three things keep them from being stepped around.** An
account has one organization: `create_organization()` refuses a second, to anyone but the operator
and a test account, because each new one would be a new free plan with its own free first scan.
An organization is not deleted through the API, since deleting one and starting again reset
everything counted against it. And a location cannot change organization, nor a prompt its
location: both limits are checked when a row is added, so a row that could be moved could be moved
past them. Someone signing up again with another email address still gets a new free account.

**An organization can have more than its plan covers**, after moving to a smaller one. Nothing is
deleted. `fit_to_plan()`, which `apply_plan()` calls, marks the locations beyond the plan
`paused_by_plan` and makes the prompts beyond it inactive with `set_aside_by_plan`, oldest kept
first; a larger plan brings them back, and a prompt its owner retired is left alone. A paused
location is skipped by the schedule and refuses a scan by hand, and stays readable. A member
swaps which location is in use with `activate_location()` (`POST /api/locations/:id/activate`),
naming the one to pause when there is no room, and swaps prompts by retiring one and restoring
another. Members may update both tables, so a trigger keeps an API role from changing either flag
except by restoring a prompt. `fit_connections_to_plan()` does the same for connections, which are
paused when the allowances stop including their kind (see "Connections").

**Plan settings live beside the caps**, protected the same way:

- `scan_every_days` is how many days apart the organization's locations are scanned.
  `locations_due_for_scan` uses it, and a location has no pace of its own. Cadences shorter than
  a day are not possible while the schedule fires once a day.
- `surfaces` is which surfaces its scans check; null means every one that is set up. The runner
  never calls a provider outside the list, so a plan is not charged for an assistant it does
  not include, and the results grid shows the same list.

Each trigger raises its own error code with a message written for the user, which the store
passes through as a `limit` error and the API returns as 409 `limit_reached`. The scheduled scans
are not counted against the manual-scan limit.

**Allowances are the kinds of work a plan includes, kept as one set**
(`docs/adr/0012-a-plans-allowances-are-one-set.md`). `plans.allowances` and
`organizations.allowances` are `jsonb` objects by kind: `true` for a kind that is included, a whole
number for how many a month the plan allows for each location it covers, and no entry for a kind
that is not included. They are not columns each, so a new kind does not remake the functions that
copy, edit and lower a plan.

- **`allowance_kinds` lists the kinds that exist**, and whether each is counted (a number) or not
  (included or not). Anyone may read it, `anon` included, as with `plans`; no API role writes it, so
  a kind is added by a migration.
- **A trigger on each column refuses a set that names a kind not in that table, or gives a kind a
  value it does not take** (`NC011`, a `limit` error like the others), whoever writes the row.
  `operator_set_plan()` and `operator_announce_limit_change()` check the set they are sent as well,
  because an announced reduction is made on its day without being looked at again.
- **An organization's set is copied from its plan** by `apply_plan()`, and a member cannot write it,
  as with the limits. `create_organization()` gives a test organization every kind, and a kind
  added later reaches the test organizations that exist.
- **Use of a counted kind is kept in `allowance_use`**, one row for an organization, a kind and a
  calendar month in UTC. Its members read their own organization's rows and the operator reads
  all of them; no API role writes it, since a count a member could write is a count a member could
  clear. `claim_allowance()`, which only the worker may call, adds to the month while the
  organization's number for the kind, times its locations limit (extra locations included), has
  room, locking the organization row so two claims at once cannot both take the last one. It says
  whether it claimed, what the month allows and how much of it is used. `release_allowance()`,
  also worker only, gives back what was claimed for a month, for work that was then not done. A kind
  that is included without a number is not counted. Only the action functions call either, and no
  kind of action is counted yet (see "Actions" and "Known gaps").
- **A kind of connection can name the allowance it needs**, in `connection_kind_allowances`; see
  "Connections".

Users can insert exactly one kind of scan row: a queued, manual scan in their own name for a
location they can see. Results, scores, recommendations and alerts are written only by the worker;
a member can dismiss an alert and nothing more (see "Alerts").
Organizations are created only through `create_organization()`, which makes the caller the owner.

**The operator reads every row, through policies.** `is_operator()` is true for an account with the
`operator` platform role, and each table, including `audits` and `provider_usage`, has a `select`
policy that answers it, except `connection_secrets`, `connection_kind_allowances`, `sample_listings` and `action_kind_terms`, which no policy opens to anyone. Only `select` policies exist, so the operator cannot change another
organization's rows by writing to them: the routes answer 404 for an update or delete and 403 for an insert. The one change the operator can make goes through
`operator_set_limits()`, below. Because
"every organization I can read" now means all of them for the operator, `listOrganizations` asks
`my_organizations()`, which goes by membership. See
`docs/adr/0004-the-operator-reads-through-policies.md`.

The operator's view is `/operator` in the web app, served by `GET /api/operator/overview` and
`GET /api/operator/organizations/:organizationId`, plus `GET /api/operator/accounts` and
`GET /api/operator/audits`, all 404 to anyone who is not the operator. It
reads through the request's store, never the secret key. `buildOperatorOverview` in
`packages/shared/src/operator.ts` decides what needs attention over the last seven days, and never
counts a test organization. One of its items, `action_untold`, is a line for each organization held
(see "Actions"). Reading through a customer's account (`/operator/o/:organizationId/...`)
reuses the Locations and location pages with every control that changes something hidden.

**The operator changes limits through one function.** `PUT /api/operator/organizations/:organizationId/limits`
calls `operator_set_limits()`, a security-definer function that returns a row only while
`is_operator()` is true and the organization exists (the route answers 404 otherwise). It locks the organization,
changes `max_locations`, `max_queries_per_location`, `max_manual_scans_per_month`,
`scan_every_days` and `allowances` and nothing else, and records the old and new values in
`operator_actions`. The route refuses a value outside `OrganizationLimitsSchema` with 422 (an
allowance of a kind this build does not list included), and the columns' own checks, and the
allowances' trigger, bound each value whatever calls the function. The route puts back any kind of
allowance this build does not know, so saving cannot drop one (see "Wire types"). A call that
leaves out the last argument leaves the allowances as they are. `operator_actions` has no write
grant for any API role; the operator has a `select` policy on it. The page is `/operator/o/:organizationId/plan`.
See `docs/adr/0005-the-operator-changes-limits-through-one-function.md`.

**The operator changes a plan the same way.** `GET /api/operator/plans` lists every plan with who is
on it (`buildOperatorPlans`, test organizations left out), `POST /api/operator/plans/:key/impact`
says how many organizations a lower prompt limit would reach without changing anything (`planImpact`),
and `PUT /api/operator/plans/:key` calls `operator_set_plan()`. That function answers only the
operator, changes a plan's name, on-sale flag, limits, allowances and emailed report (not its prices
or included locations), records it in `operator_actions` with no organization, and in the same
transaction re-applies the plan through `apply_plan()` to every organization on it, each keeping
its own `max_locations`. That reaches every organization at once for a raise, and for any change on
a plan nobody pays for. On a plan with subscribers it refuses to lower anything, an allowance taken
away or made smaller included, and holds the fields an open announcement lowers where they are, an
allowance kind by kind (see "Reductions in limits"); a cut to the free plan also
writes an already completed `limit_changes` row. An organization with no `plan_key` is untouched. It refuses to take the free plan
off sale, because `create_organization()` puts every new organization on it: the API answers 409
`limit_reached` with the reason.

**The operator sets a plan's prices through another function.** Stripe cannot edit a price, so
`PUT /api/operator/plans/:key/prices` first makes two new prices there, then calls
`operator_set_plan_prices()`. That function answers only the operator, refuses the free plan, records
the change in `operator_actions`, adds the pair to `plan_prices` and puts it on the plan's row. It
touches no subscription and no organization. `plan_prices` is readable by anyone signed in and
written by no API role. Moving current subscribers is a separate act (below). The Plans section's
monthly total uses present prices, so it is off for subscribers on an older one.

**Price changes.** `operator_announce_price_change()` and `operator_call_off_price_change()` follow
the same shape: operator only, recorded in `operator_actions`. `price_changes` (readable by anyone
signed in) and `price_change_notices` (readable by the operator) have no API role that writes them;
the Worker writes notices. While an announcement is open `operator_set_plan_prices()` refuses. A
queue message per organization per step (announce, remind, call off, move) is handled by
`runPriceChangeStep`, the one place that changes what a running subscription is billed, and it moves a
subscription to a higher price only when its owners were sent the announcement at least thirty days
before. See `docs/adr/0008-a-price-change-reaches-subscribers-by-announcement.md`.

**Reductions in limits.** On a plan with subscribers, `PUT /api/operator/plans/:key` saves the raises,
the name and the on-sale flag at once and announces what goes down for `reduce_on`, at least thirty
days out, through `operator_announce_limit_change()`. `operator_call_off_limit_change()` calls it off.
Both answer only the operator and record the change in `operator_actions`. `limit_changes` (readable by
anyone signed in) and `limit_change_notices` (readable by the operator) have no API role that writes
them; the Worker writes notices. A queue message per organization per step (announce, remind, call
off) is handled by `runLimitChangeStep`, which emails the owners. On the day `advanceLimitChanges`
calls `apply_limit_change()`, which answers only the worker and lowers the plan and every
organization on it together, told or not. Allowances are part of it. `plan_reductions()` finds them with
`allowance_reductions()`, and `limit_changes.lowered` holds them under `allowances`, by kind, each
with its `from` and `to` (`false` for a kind taken away). On the day a kind taken away leaves the
plan's set and a smaller number replaces the larger. A kind added or raised is not a reduction.
An organization whose email failed is shown to the operator
by name. Without `RESEND_API_KEY` a reduction on a paid plan cannot be announced. See
`docs/adr/0009-a-reduction-is-announced-like-a-price-rise.md`.

**The operator makes an audit the same way.** `POST /api/operator/audits` checks the body against
`AuditInputSchema`, refuses with 409 where scans return sample data, and calls
`operator_create_audit()`, which inserts the row for the operator alone and records it in
`operator_actions`. The route then puts one message per prompt on the scan queue, as
`npm run audit:create` does. The `audits` table still grants no API role a write. If queueing
fails, the request fails and the scheduled sweep marks the audit failed.

Accounts come from `operator_accounts()`, a security-definer function that returns each account's
email, creation and last sign-in time from `auth.users` and rows only while `is_operator()` is true;
it is executable by `authenticated` and not `anon`. `auth.users` itself stays unreadable to every
API role, the operator included. `buildAccounts` in `packages/shared/src/operator.ts` places each
account on the funnel and never counts a test account.

**Platform roles** (`platform_roles`) say what an account is to the product, apart from any
organization. A signed-in user can read their own row and nothing else (the operator reads all);
rows are written only with the secret key. `create_organization()` marks an organization made by a `test` account
`is_test`, with roomy limits and a daily cadence. A test organization's scans run on generated
sample data even on a live deployment: the runner uses the mock providers, records
`sample_data`, skips the on-page fetch, is not stopped by the default-tuning check, and sends no
report email. `GET /api/locations/:id` then reads the generated window and lists every surface.
See `docs/adr/0003-platform-roles-and-test-accounts.md`.

## Wire types

`packages/shared/src/schemas.ts` is the single definition of every payload. The API validates
input against it and parses database rows through it; the web client parses every response
through it. Field names stay snake_case from Postgres to React so there is no mapping layer to
drift.

Input checks live there too (`packages/shared/src/inputs.ts`): a phone number is stored in E.164
form, read in the location's own country; a website gets `https://` if typed without a scheme and
must be a public web address; the postal code is exact for US and CA and loosely shaped elsewhere.
The web app runs the same checks beside each field. Stored rows are not rewritten, so one that no
longer validates is corrected the next time its Settings are saved.

A plan's and an organization's allowances are a record by kind (`AllowancesSchema`). The kinds
this build knows are listed, with the words the pages use, in `ALLOWANCE_KINDS`
(`packages/shared/src/allowances.ts`); the database lists the same keys in `allowance_kinds`, and
a test in `packages/db` holds the two equal. A kind is added to both in one change, and the
migration is applied before the Worker that knows the kind is deployed, so for a while the Worker
knows fewer kinds than the database. Such a Worker keeps the kind it does not know. The schema
keeps it as it came, the operator's forms neither show nor send it, and
`PUT /api/operator/plans/:key` and `PUT /api/operator/organizations/:organizationId/limits` put it
back from the stored set (`unknownAllowances`) before saving. Without that, the next save would
drop it.

## Limits to design around

- **Each provider call is a subrequest**, and a scan makes (queries x surfaces) of them in one
  invocation, plus up to fifteen site requests (the page twice and `robots.txt`, each with up
  to four redirects) unless it serves sample data. Workers cap subrequests and CPU time per
  invocation,
  and the caps differ by plan. Check the current numbers before raising the queries allowed per
  location. If a scan outgrows one invocation, queue one message per check instead of one per
  scan.
- **Queue delivery is at-least-once.** `runScan` is written to be safe to repeat.
- **The cron queues at most 100 locations per run** (one `sendBatch`). They sort oldest-first, so
  none starve, but a daily cron cannot keep up with more than 100 daily locations. Run it more
  often or page through the due list before that matters.

## Known gaps

- A manual scan whose queue send fails leaves a `queued` row with no message behind it. The
  sweep fails it within about 45 minutes, and until then the location cannot be scanned again.
  A signed-in user cannot update a scan, so the request that hit the failure cannot clear it.
- On a Supabase project that still signs tokens with a legacy shared secret, `getClaims` asks the
  Auth server on every request. Use asymmetric signing keys.
- Allowances limit almost nothing yet. No kind of allowance exists (`ALLOWANCE_KINDS` and
  `allowance_kinds` are empty) and no kind of connection or of action names one, so a number would
  be stored, shown and lowered by announcement, but no work would stop at it or be counted against
  it. What an allowance can stop is a kind of connection that needs it (see "Connections") and a
  kind of action that takes from it (see "Actions"), and none does ([#133](https://github.com/jwh3times/Nearcited/issues/133)).
- Nothing seals the sign-ins again under a new `CONNECTIONS_KEY`. Changing or losing the key makes
  every sign-in kept unreadable and its owner has to connect again; a sync of one changes nothing,
  and a removal still finishes but cannot take the access back at the outside service (see
  "Connections").
- A match whose choice a later sync no longer finds is kept as it was: the account may have lost
  the thing, or its access to it. The Connections page names it "no longer found" so its owner can
  choose again. Only the sample kind of action acts through a match, and it does not check that
  the choice is still there; a real kind will have to.
- There is no real kind of action yet (see "Actions"). So no action takes from an allowance, none
  does a task's work, and the only limit on keeping what one replaced is the sample kind's 30 days,
  which is there so that dropping can be seen. The only notices sent are about sample actions, by a
  deployment on sample data that has email set up.

## Open product questions

These are not engineering tasks, and the code cannot answer them.

1. **Does anything the product recommends move the number?** Partly answered: every rule now
   states what a later scan must show for it to have worked, and clears itself when that happens
   (see "Where the answers come from"). Still open: whether acting on one makes it clear more
   often than doing nothing, which only real locations over time can show, and whether a higher
   score means more calls or visits. The score stays a description of visibility.
2. **What is one sample worth?** Partly answered: results are now rates over the last seven
   scans (see "Rates over a window of scans"), which costs nothing extra per scan. Whether seven
   is enough is still open. Assistant answers vary run to run and by location. One call per
   check is an anecdote. Sampling enough to be credible multiplies cost per location.
3. **What does a location cost to serve?** Map pack data is bought per keyword, per location, per
   run. Price the plan from that number, not the other way round.
4. **Who buys?** Single-location owners churn and are expensive to reach. Agencies managing many
   locations are the more plausible first customer, and they will want white-label reports.
5. **The score weights are a guess** (the defaults in `packages/shared/src/tuning.ts`). Nothing ties a rank on
   any surface to calls or visits yet.
