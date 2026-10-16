# Architecture

## One Worker, three entry points

`apps/api/src/index.ts` exports a single Worker with three handlers. It is one of two Workers: the
other, the Pages Worker in `apps/pages`, serves hosted pages and nothing else (see "Hosted pages").
Everything below is the main one.

- **`fetch`**: the HTTP API, a Hono app mounted at `/api`. Only `/api/*` reaches the Worker.
  Every other path is served from the web app's build output, with unknown paths falling back to
  `index.html` so client-side routes work. That routing lives in `wrangler.jsonc` under `assets`.
  The build output includes `third-party-licenses.md`, the licences of the packages the web app
  bundles, which is therefore public at `/third-party-licenses.md` with no sign-in. It is a static
  asset and no route, and a missing one would be answered with `index.html` like any unknown path
  (see the README's "License"). So is `line.js`, the script a business pastes into its own site,
  which `apps/web/public/_headers` gives a one-hour cache and `Cross-Origin-Resource-Policy:
  cross-origin`; a site that loads it does not run the Worker. The reports it sends come back to
  the Worker at `POST /api/visits` (see "Visits from assistants").
- **`scheduled`**: two Cron Triggers. Every 15 minutes it fails scans that have been queued or
  running for more than 30 minutes, so an abandoned scan cannot block its location for long. It
  also fails audits still `queued` after 30 minutes (see "Shareable audits"), and queues again
  the removal of any connection asked for more than 15 minutes ago and not finished, the first
  sync of any connection made in the last day that still has none (see "Connections"), and any
  approved action nobody is carrying out (`requeueStalledActions`; see "Actions") and any draft
  asked for that nobody is writing (`requeueStalledDrafts`; see "Drafts"), and checks again each
  answer subdomain still waiting for its record or its certificate that was last checked more than
  ten minutes ago (`requeueAnswerSubdomainChecks`; see "Connections").
  Once a day it also asks Postgres which locations are due (`locations_due_for_scan`), creates a
  `scheduled` scan row for each, and puts the scan IDs on the queue. It also queues a sync for each
  connection that is due (`enqueueDueSyncs`). It also lapses the proposals that waited fourteen
  days (`lapse_actions()`), drops what an action replaced once it may be kept no longer
  (`drop_expired_seen()`) and tells each organization's owners what was done and what is newly
  waiting (`sendActionNotices`; see "Actions"). It also starts the removal of each connection that
  has been paused for thirty days, an answer subdomain for 120 (`expirePausedConnections`) and reminds, once, the owners and
  admins of each they were told a week ago had broken and that still is
  (`remindBrokenConnections`), and tells those of any broken one nobody could be told of at the
  time (`tellBrokenConnections`; see "Connections"). It also starts the removal of each answer
  subdomain whose record has not appeared in thirty days (`expireUnclaimedAnswerSubdomains`), and
  tells the owners of each answer subdomain just paused when its pages stop being served as they
  are and when it will be removed (`tellPausedAnswerSubdomains`). It also calls `advancePriceChanges`, which queues the reminders a week before an
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
  `{ action_id, step }` carries out one approved action (see "Actions"). A message shaped
  `{ draft_id, step }` writes one draft a member asked for (see "Drafts"). The consumer is handed
  up to five messages at a time and works through them one after another. A lone message waits
  at most a second for others to join it (`max_batch_timeout` in `wrangler.jsonc`), because
  somebody is usually watching the page for it; a message that lands in a batch behind scans
  still waits for those to finish.

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
        analyzeObservation() -> Finding       (was the business named, where, who else, and the
                                                phone numbers the answer gave for it)
                       |
     fetchSite() + analyzeSite() -> SiteCheck  (home page, kept in scans.site_check;
                                                 skipped on sample data)
                       |
     listRecentResults(): the last six successful scans of the same kind
                       |
     windowScore() + deriveRecommendations(), over this scan and those six
                       |
     listAlerts() + deriveAlerts(): the alerts that window ends, and the ones it raises
        listSeenBefore() first, only if hasNewcomers(): the latest scans hold something
        that might be a first sighting, so the record before the window is read
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
network access. The same goes for which phone numbers a written answer gave for the business. A
result keeps only an excerpt of an answer, 280 characters, so those numbers are read while the
whole answer is in hand and kept with the result as `scan_results.phones` (see "Alerts"). A
provider also reports what each call it is charged for used (`onUsage`); the scan and audit
runners add those up and store them in `provider_usage`, and so does the worker that writes a
draft (see "Drafts"), whose rows name the draft and no surface. A failure to store them is logged
and does not change the outcome. What a row cost is `usageCost` in `packages/shared`,
from the tuning's `rates`: one entry per model, which a public clone leaves empty, so a model
without an entry has no cost and is never priced as another.

The operator's spend figures (`GET /api/operator/spend`) are the only reader. The database adds
the rows up by calendar month in UTC (`usage_by_month()`, which runs as the caller, so it counts
everything for the operator and nothing for a member), and `buildSpend` prices the sums when they
are read: per organization, audits on their own line, and what deleted organizations had spent. A
draft's use is in its organization's line, since its rows carry the organization and the sum is by
month, organization and model. A rate corrected later therefore corrects past months too. A test organization is never counted, and
usage on a model with no rate is named and left out of the total, not guessed at. Only dollars
leave the server; the rates do not.

## Tuning

Prompt wording, score weights and what writes a draft (its model, effort, length and the
instructions for each kind of draft) are values, defined by `TuningSchema` in
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
                  writeDraft({ writer })           (the writer holds the draft settings)
fetch handler  -> Deployment.draft_kinds            (what the draft route refuses on, and what a task is offered)
```

`runScan` and the scoring functions take the tuning as arguments, so they are tested without the
bundled file. Only `apps/api/src/index.ts` imports the resolved tuning.

The draft settings, `drafts`, are optional: a private file from before drafts existed still loads,
and a build whose file has none writes no draft on real data. `liveDraftKinds`
(`apps/api/src/drafts/claude.ts`) is the kinds of draft a build can write there: those the private
file has instructions for, and none on the default tuning, whose `drafts` is a placeholder that
lets the code run and is never used on real data, for the reason live scans refuse the default
tuning. A kind with no instructions is not written, and nothing falls back to a placeholder.

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

**What a ChatGPT check is billed for.** OpenAI bills the pages a search reads as input tokens at
the model's rate, and each search at a flat rate that is the same on every model. So what a check
costs follows the model's rate and how much its searches read, with a fee for each search on top.
OpenAI's published rates for `gpt-6.1-sol`, the default model, were $2 per million input tokens,
$10 per million output and reasoning tokens and $10 per 1,000 searches on 2026-10-06. The model
and how hard it reasons are tuning values (`chatgpt.model`, `chatgpt.effort`). The provider
reports each call's usage as it makes it, and the runner stores it in `provider_usage` (see "How
a scan runs"), so what a deployment's checks cost can be read from that table.

**Claude** (`apps/api/src/providers/claude.ts`) calls Anthropic's Messages API through its SDK
with the `web_search` tool, located in the location's city, and asks for the answer, the
businesses it named and the pages it relied on as JSON. Three things about it are deliberate:

- **Sources come from the answer, checked against the search.** With a JSON output format Claude
  attaches no citations to its text, so the provider asks for the URLs it relied on and keeps
  only those the search really returned.
- **Searches are called directly and capped.** The tool's default filters results through code
  execution, which a trial showed takes more time and tokens for a similar answer. The cap is a
  tuning value and is the main cost control.
- **A declined prompt is re-run on Anthropic's fallback model** (`fallbacks: "default"`), so a
  scan does not fail on a safety classifier. The usage rows record which model answered.

**What a Claude check is billed for.** Anthropic bills search results as input tokens, with a
flat fee for each search on top, and on a turn with several searches the earlier results are read
again each time. So each further search costs more than the one before it, which is why the cap
is the main cost control. Anthropic's published rates for `claude-sonnet-5-5`, the default model,
were $2 per million input tokens, $10 per million output and thinking tokens and $10 per 1,000
searches on 2026-10-06. The model, the effort and the cap are tuning values (`claude.model`,
`claude.effort`, `claude.max_searches`). The provider reports each call's usage the same way,
including a call whose answer was then refused or unusable.

**What a check was measured to cost is not recorded here.** A provider's published rates are
public and this section may quote them. What a call really used and what it came to, and how
models and settings compared on cost, is the owner's research and is kept in the private
companion with the pricing (see "Private companion" in `AGENTS.md`). The rates a deployment
turns recorded usage into spend with are the tuning's `rates`.

**Gemini is not built on Google's API, on purpose.** Google's terms for Grounding with Google
Search do not allow grounded results to be stored, analysed or collected into a database, and a
scan does all three. One trial call on 2026-10-06 worked; the result was not kept. Gemini results
would have to come from a data vendor.

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
  alerts, or the record a first sighting is checked against, fails the scan like any other error.
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

Two recommendation rules read it (`packages/shared/src/recommendations.ts`), and a third, `page:<prompt>`, is described under "Tasks":

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
| `structured_data` | A JSON-LD block has a `name` that is this business's, matched the way answers are matched, and an `address`. A block for somebody else on the page, such as the agency that built the site, does not count. What else the block says is not compared with what is on file. The name is the location's, or the audit's business name. |

Each failed check becomes a `site:<check>` recommendation, which clears when a later scan's fetch
passes it. A site that will not load never fails the scan. One that leads nowhere is the finding;
one that merely failed to answer is shown as tried and not checked, and an earlier
`site:reachable` recommendation clears. With no
`inspectSite` given to the runner (a deployment on sample data, or a test), no claim is made
about the site and no site rule fires. A scan keeps its whole `SiteCheck` in
`scans.site_check` (see "The action plan"), and an audit keeps it in its first prompt's part; both
pages show it as a checklist.

A page that fails `structured_data` is offered the block that would pass it. `buildBusinessBlock`
(`packages/shared/src/structured-details.ts`) composes it by rule from the location's own details
and nothing else: the name, the website, the phone number and the address, as schema.org JSON-LD
inside a script element ready to paste. It is always typed `LocalBusiness`, because a location's
category is typed freely and a narrower type guessed from it would state something nobody said. A
detail not on file is left out, never filled in, and the block says which of street address, postal
code and phone number are missing so the page can lead to Settings. Every `<` in a detail is
written as `\u003c`, so no detail can close the script element. No model writes any of it.

The block itself is not stored. The web app builds it from the location it already holds, so it
always says what the details say now, and there is no route or table for it.
`needsBusinessBlock` decides when it is offered: the page was read and `structured_data` failed,
and not when the page could not be loaded, since nothing is known about it then. The Website tab
shows it under the failed check and the action plan shows it on its website step. An operator
reading through an account sees it without the link to Settings, and a shareable audit's checklist
offers none, because an audit has no location to build it from. It promises nothing: whether it
changes what an assistant answers is not known, and the card says so.

**Marking it as pasted.** The card lets a member say the block is on the page. That is the
`site:structured_data` recommendation (`DETAILS_RULE`) marked the way a task is:
`PATCH /api/recommendations/:id` with `{ "acted": true }` sets `acted_at` and `false` clears it
(see "Tasks"), so there is no new route, column or table. Any member of the organization may; the
operator reading through sees the mark and the counts and has no button. `buildDetailsFix` turns
that recommendation into `details_fix` on `GET /api/locations/:id`. It is null while the check has
never found the details missing, and when the recommendation was dismissed. The mark stays once the
page passes the check: the recommendation clears, `acted_at` does not, and the Website tab keeps
the line and the counts under the passed check.

- **The next scan confirms it, or not.** `checked_since` is true once a successful scan has been
  made since the mark. Until then the card says the next scan will look for it, and claims nothing
  about the page. After that it says whether the scan since found the details on the page or did
  not, from the latest on-page check.
- **The answers before the mark are set beside those since.** The route reads them the way it does
  for a task (`Store.listResultsAround`: the `SCAN_WINDOW` scans before the mark, every scan since up
  to `MAX_SCANS_SINCE`), and `citedCount` counts, over each side, how many written answers
  (`CITING_SURFACES`) cited the business's own website, matched as sources are everywhere else. Both
  counts are null until it is marked. With fewer than `MIN_ANSWERS_SINCE` answers since, the card
  says it is too early to say. The counts are set side by side, as for a task, and nothing says
  the block caused a change.

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
covers (`source:*`, `site:*`, `own_site_uncited`) out of its list, and `page:*` too, which the Website tab shows as page tasks (see "Tasks").

The block from "The on-page check" is shown on the `fix_website` step while `structured_data`
fails, with its mark done. The location page puts it there; `buildActionPlan` does not carry it,
and an audit's plan shows none.

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
  The mark on the structured details uses the same read (see "The on-page check").
- **A page task is a `page:<tracked_query_id>` recommendation** (`packages/shared/src/pages.ts`),
  raised by `deriveRecommendations` through `promptsLeftOut`: an active assistant prompt (not a
  Google one) with at least `MIN_ANSWERS_FOR_PAGE` (4) assistant answers in the scan window, none of
  which named the business, for a location with a website to put the page on. The runner passes it
  the location's queries. It clears, as any recommendation does, when an answer to that prompt names
  the business. It is not a task about a source, so `buildTasks` does not carry it and the Overview
  list leaves it out. `buildPageTasks` makes it `page_tasks` on `GET /api/locations/:id`
  (`PageTaskSchema`), which the Website tab shows as "Pages that answer your prompts": the prompt, the
  count of answers and how many named the business, a mark done (the same `PATCH
  /api/recommendations/:id`) and its draft. A task marked done is kept in view while its prompt has
  since been named, as the other tasks are. For a marked task it sets side by side how many answers to
  the prompt named the business over the scans before the mark and over those since (`before` and
  `since`, a `PromptCount`, read by `Store.listResultsAround`); nothing says the page caused the
  change. Once a member says where the page is, `since.cited` also counts the answers that cited it
  (`citesPage`, which ignores `www.`, case, a trailing slash and anything after `?` or `#`).
- **Where the page is.** `PUT` and `DELETE /api/locations/:locationId/tasks/:taskId/page`
  (`apps/api/src/routes/pages.ts`) keep or take away the address in `prompt_pages`, one row for a task
  (`recommendation_id` is unique). Only the form is checked, by `readPageAddress`: https, on the
  location's own website or a subdomain of it, not its home page, at most `PAGE_URL_MAX` (500)
  characters, without the part after `#`; a failure is 422. Nothing opens the address. Only a
  member writes it, through `set_prompt_page()` and `remove_prompt_page()`, which are security-definer
  functions that answer a member of the location's organization and only for a `page:` task: to
  anyone else, the operator included, and for any other task, the route answers 404.
  `prompt_pages` has a `select` policy for whoever can read the location and one for the operator, and
  no write grant for any API role. It is deleted with its task and with its location.
- A dismissed recommendation has no task. Ticks on action-plan steps are still kept in the browser
  only. The operator's read-only view hides the buttons.
- A task about a page somebody wrote (`editorial`) can have a draft, the note to its author, and
  so can one about a directory or a review site that does not let a business ask for reviews
  (`directory`, `reviews_unasked`), whose draft is the description its listing asks for. One about
  asking customers for reviews (`reviews`) or about a site nobody knows (`unknown`) has none (the
  request to send and the code to print such a task hands over are not drafts; see below). The
  route returns `draft_kind` for a task that is still to do and whose draft can be written here, and
  `draft` once one has been asked for (see "Drafts"). The task's own wording is unchanged, and still
  composed by rule.
- **A task about asking for reviews carries the business's listing.** Such a task hands over the page
  an assistant read, which is often a list or somebody else's page, and sending a customer to where a
  review is written takes the business's own page on the site. A member gives its address once
  (`PUT /api/locations/:locationId/listings/:site`, and `DELETE` takes it away) and it is kept for the
  location and the site, not for the task (`listings`, one row for each; the term is in
  `GLOSSARY.md`), so a task that comes back finds it, and a task marked done still carries it.
  `listingSite` (`packages/shared/src/listings.ts`) names the sites that have one: those on the
  `reviews` list, Google included. What Google is asked for is not the address of a page but the
  review link Google gives a business (`asksForReviewLink`, true for google.com only; the term is
  in `GLOSSARY.md`), which its owner copies from the business's Google profile. It is kept in
  `listings` as any other is, and nothing is made from it or from the place ID a location holds. A
  site that forbids asking, a directory, a page somebody wrote or a site nobody knows has none, and
  the route answers 404 for it. `taskListing` puts `{ site, url, review_url }` on a task as
  `listing`, with `url` null until a member gives it, and null for every other task.
  `GET /api/locations/:id` reads the location's listings for it. `currentTasks`, which a draft is asked for and written
  against, carries none: a draft is written from nothing a listing holds.
- **Only the form of an address is checked, and nothing is opened.** `readListing` takes it as a
  browser would: `http://` becomes https, an address pasted without its start is given one, and what
  follows `#` is dropped. It refuses an address that is not on the site (the site or a subdomain of
  it), the site's front page, an address with a user name or password in it, and one longer than 500
  characters; the route answers 422 `validation_failed` with the sentence it returns. For google.com
  it takes an address on `g.page` or on `google.com` (or a subdomain of either) and refuses one on
  any other name, a front page, a Google search address (the path `/search`, which is what an owner
  managing a profile has in the address bar) and anything on `business.google.com` (pages only the
  owner can open), with one sentence that says where the link is. Google's help does not show what
  the link looks like, so `g.page` is taken because every account of it that could be found puts it
  there. The table holds to the same form (https, 500 characters, a site name in lower case) and to at most 50
  listings for a location (`NC015`, a `limit` error, so 409 `limit_reached`), since the site is
  whatever the caller names. The product never looks for a listing, so a member who gives a wrong
  address, or a link that is not Google's review link but is on one of its names, is believed.
- **Who reads and writes.** `listings` has a `select` policy for whoever can read the location and
  one for the operator, and no write grant for any API role. A request writes only through
  `set_listing()` and `remove_listing()`, security-definer functions that answer a member of the
  location's organization and no one else, the operator and the worker included (no row for a
  set, false for a removal). Setting one a second time replaces the first, keeping the row.
- **A link straight to the review form, only where the site showed its address.** `reviewForm`
  (`packages/shared/src/listings.ts`) makes the address of a site's review form from a listing's
  address, and the task carries it as `review_url`. `REVIEW_FORMS` has an entry for a site only
  when its own pages showed the address, with what was read and the day: a guessed address would
  send a business's customers to a page that is not there. Today that is bbb.org (a profile's
  address with `/leave-a-review` after it) and trustpilot.com (`/evaluate/<name>` for the company
  at `/review/<name>`), both read on 2026-10-13. A listing whose address is not of the shape that
  was read gets none, and so does every other site: the task then gives the listing, from which a
  customer finds the form. google.com is left out on purpose: what a member gives there is already
  the link to the form, so there is nothing to make. Nor is one built from a place ID. The address
  in common use for its form answered by asking for a sign-in, and no page of Google's that could be
  read says it is the form's address.
- **The task asks for the listing and shows the link.** `TaskListing`
  (`apps/web/src/components/TaskListing.tsx`) puts a field on a task that has a `listing` with no
  `url`, and checks what is pasted with `readListing` before anything is sent. Once one is kept it
  shows the link to send customers, to copy: `review_url` where there is one, with the listing it
  was made from beside it, and the listing where there is not. The listing can be changed or
  removed. The operator, reading a customer's account, is shown a listing that is kept and asked
  for none (`listingView`).
- **The task says where an owner finds Google's link.** The wording is in `askWords` and
  `keptWords` (`apps/web/src/lib/listings.ts`). An owner is assumed not to know the link exists. For
  Google the field is "Your review link from Google" and the button "Save the link", and above it
  are three numbered steps taken from Google's own help (support.google.com/business/answer/16816815,
  read on 2026-10-13): go to business.google.com signed in as the account that manages the
  business; on the Business Profile choose Read Reviews, then Get more reviews; choose Copy and
  paste it. A link to that page goes with them. Once the link is kept it is shown as Google's
  review link, with no listing beside it, since it was made from none. For every other site the field
  is still "Your listing on" and the site's name, and its hint says how to get the address: find the
  business on the site, open its page and copy the address from the top of the browser.
- **A task that holds the link also hands over a request to send.** `TaskAsking`
  (`apps/web/src/components/TaskAsking.tsx`) shows, under the link, a short message with a "Copy the
  request" button, which the owner sends to their customers themselves, by text or by email, from
  their own address or phone (the term is in `GLOSSARY.md`). `requestToSend`
  (`packages/shared/src/asking.ts`) composes it by rule from three things: the location's `name`,
  the site's name (`siteName`) and the link the task already shows (`sentLink`,
  `apps/web/src/lib/listings.ts`: the review form where its address is known, else the listing, and
  on Google the review link the owner pasted). No model writes it. It reads "Thank you for choosing
  <business>. Would you leave a review on <site>? Say what you honestly thought, good or bad: it
  helps other people decide." and then the link on a line of its own, so whatever it is sent with
  makes it one to tap. The business's name is tidied (the spaces round it and between its words) and
  the sentence is closed with a full stop unless the name brought its own. It asks every customer
  alike for what they honestly thought and never for a good review, and offers nothing in return.
  Beside it the owner is told the same of how to send it: to every customer and not only the happy
  ones, and with nothing offered in return, which is what a site that lets a business ask lets it
  ask for. `siteName` gives the name a customer knows each of the ten sites on the `reviews` list by
  (Google, BBB, Trustpilot and so on), and a site with no name on that table goes by its address;
  `sitesOfKind` (`packages/shared/src/source-kinds.ts`) lists the sites of a kind, and a test holds
  the name table to the `reviews` list.
- **The request is shown only where a link is kept, and is not a draft.** `asking`
  (`apps/web/src/lib/asking.ts`) makes nothing until the task's `listing` has a link to send, so
  there is none on a task for a site that forbids asking or whose kind is not known (those carry no
  `listing`), and none until a member gives the listing; taking the listing away takes the request
  with it. The operator, reading a customer's account, sees it too, beside a listing it cannot
  change. Nothing is sent from the page and nothing is stored: no route, no wire type and no table
  carry the request, it is worked out again from the task and the location each time the page is
  drawn, and copying it does not mark the task done. It is not a draft (see "Drafts"): no worker
  writes it, no allowance is taken from, nothing is recorded for it, and a task about asking
  customers for reviews still has no `draft_kind`.
- **The same task hands over a code to print.** `TaskAsking` shows, in a second block under the
  request, the link the task shows (`sentLink`) as a QR code, with "Print a card" and "Download the
  code" (the term is "code to print" in `GLOSSARY.md`; the screen says "QR code"). `ReviewCode` and
  `DownloadCode` (`apps/web/src/components/ReviewCode.tsx`) draw it in the browser with
  `qrcode.react` (ISC, which bundles Project Nayuki's QR Code generator, MIT): `ReviewCode` is an
  SVG, for the screen and the card, and `DownloadCode` keeps a 1,024-pixel canvas out of sight and
  saves it as a PNG, named by `codeFileName` from the business and the site, such as
  `joes-pizza-google-review-code.png`. The code holds the site's own address, the same link the task
  shows, and nothing of the product's: no forwarding address, nothing counted, nothing stored,
  nothing sent. It opens that address for as long as that page is there, so a card printed before a
  link was changed opens the old one. How it is drawn is one set of values, `CODE`
  (`apps/web/src/lib/asking.ts`): error correction level M (about a seventh of the code can be lost
  to a crease or a smudge and still read), four squares of clear space round it, and black on white
  whatever the theme, since a reader may not manage a light code on a dark ground.
- **The card is a page of the web app, not a route of the API.** `ReviewCard`
  (`apps/web/src/pages/ReviewCard.tsx`) is at `locations/:id/review-card/:site`, and under
  `/operator/o/:organizationId/` for the operator (`cardPath` builds the address inside whichever
  account is being shown). It reads the location the location page already loads
  (`GET /api/locations/:id`) and finds the task for the site (`cardFor`), so it has nothing of its
  own to fetch, keep or send. It shows a card four inches by six, sized in inches and points so that
  the size on the screen is the size on paper, and shrunk to fit a screen narrower than that: the
  business's name, "How did we do? Leave a review on Google." (the site's own name where the task is
  for another), the code, and "Point your phone's camera at the code." (`cardWords`,
  `packages/shared/src/asking.ts`, which like the request asks every customer alike and offers
  nothing). Above it the owner is told to print the card, cut it out, hand one to every customer or
  leave it where they pay, and to offer nothing in return for a review. "Print the card" calls
  `window.print()`, and the print stylesheet (the `@media print` block of `apps/web/src/styles.css`)
  leaves only the card on the sheet. "Download the code" is here too. For a site with no link kept,
  or one no task asks for a listing on, `cardFor` finds nothing, so the page says there is no card to
  print and shows none.
- **The code is offered where the request is, and marks nothing.** `asking` makes nothing until the
  task's `listing` has a link, so there is no code for a site that forbids asking or whose kind is
  not known. The operator, reading a customer's account, sees the code and the card. Neither
  printing nor saving marks the task done. As with the request, no route, wire type or table carries
  the code or the card, and it is not a draft: no worker writes it, no allowance is taken from and
  nothing is recorded for it.
- Not built: a review-form link on any site but those two (Google's is the link its owner pastes,
  and none is made from a place ID), and anything the product does outside itself for real beyond
  the business details on a WordPress home page and a page task's copy published to a WordPress
  site. Approvals and actions exist (see "Actions"); the real kinds add those details to the home
  page of a connected WordPress site and publish a page there, and a sample kind stands in where the data is generated.

## Alerts

An alert says that something measured has changed at a location in a way its owner would want to
know (`alerts`; the term is in `GLOSSARY.md`, the decision in
`docs/adr/0015-an-alert-is-kept-not-worked-out-again.md`). There are four kinds: a drop, a
business named for the first time (`competitor`) and a site read for the first time (`site`), the
last two being first sightings, and a phone number the answers give for the business that is not
the one on file (`phone`). The rule, the sentences and the grouping are in
`packages/shared/src/alerts.ts` (`deriveAlerts`, `hasNewcomers`, `alertTitle`, `alertDetail`,
`groupAlerts`). Everything is composed by rule from counts the product holds, says what was seen
and never what to do, and no model writes one.

- **A drop is a prompt on one surface that named the business and has stopped.** It is raised when
  the latest `DROP_MISSES` (3) checks of the cell did not name the business and at least
  `DROP_NAMED_BEFORE` (3) of the `DROP_CHECKS_BEFORE` (4) before them did. It needs all seven
  checks in the cell, a full `SCAN_WINDOW`, so a new location or a new prompt is quiet until
  its seventh scan. The thresholds are public constants, not tuning. The row keeps the counts it
  rests on (`facts`: the prompt as asked, how many checks in a row missed, how many came before
  and how many of those named the business) and when the run of misses began (`since`). A drop
  that could not be raised at its third miss (the cell's window was not yet full, or alerts did
  not exist yet) counts the whole run it can see, up to four.
- **A first sighting is a business, or a site, the written answers have begun to name or cite.**
  It is raised when the written answers of the latest `FIRST_SEEN_SCANS` (3) scans name the
  business, or cite the site, in at least `FIRST_SEEN_ANSWERS` (3) answers across at least
  `FIRST_SEEN_IN_SCANS` (2) of those scans, and no written answer of any earlier scan on record
  did. Written answers are those of `CITING_SURFACES`, the assistants and AI Overview. A results
  list (the map pack, organic lists) names ten businesses every time and its tail changes daily,
  so it is not counted. A site counts once per answer, however many of its pages the answer cited.
  Names are matched with `namesMatch` and sites with `hostsMatch`, as everywhere else, so a longer
  name that contains a known one is the same business (a new branch of a known business is not
  said) and a subdomain is the same site. A site that looks like a named competitor's own
  (`belongsTo`) is not said as a site: naming the competitor says it. The business's own website
  counts, and is worded apart (`facts.own`). Nothing is raised until the location has
  `FIRST_SEEN_BASELINE` scans, a full `SCAN_WINDOW`, because its first scans name everyone for the
  first time. The thresholds are public constants, not tuning. The row keeps what it rests on
  (`facts`: the business as the answers most often wrote it, or the site's host; how many answers
  and how many of the latest scans it was counted over; for a business, the first three prompts it
  was named for with their surfaces and how many prompts in all; for a site, how many of its
  answers named the business, whether it is the business's own, and the page cited most) and when
  the oldest of those scans asked (`since`). It is about no one prompt, so `tracked_query_id` and
  `surface` are null.
- **A phone number is one the written answers give for the business that is not the one on
  file.** `analyzeObservation` reads the numbers (`phonesGivenFor`, in
  `packages/shared/src/analysis.ts`), in international form and in the location's country, which
  is how a number written without its country is read. An answer goes through the businesses it
  names one after another with each one's details after its name, so a number is the business's
  when the name written nearest before it in the answer is the business's (`namesMatch`), and one
  written before any name is nobody's. That reads where a number stands and not what the sentence
  says, so it can be wrong about a number that follows the business's name and belongs to
  something the answer did not name. That is why one scan is not enough: it takes the same number
  in at least `PHONE_IN_SCANS` (2) scans of the window. A results list gives no numbers, and at
  most five are kept for an answer. Nothing is raised for a location with no phone on file, as
  there is nothing to differ from. There is no baseline to wait for, so it can be raised at a
  location's second scan. The threshold is a public constant, not tuning. A scan keeps 280
  characters of an answer and discards the rest, so the numbers are kept with the result
  (`scan_results.phones`), and the rule counts them over the window like anything else. A result
  sent without them, as the Worker deployed before the migration sends it, is kept with none, and
  so are the results made before numbers were read. The row keeps what it rests on (`facts`: the number and the one on file, and the country both are written out in; how
  many answers and how many scans of the window it was counted over; the first three prompts it
  was given for with their surfaces, and how many prompts in all) and when the oldest of those
  scans asked (`since`). It is about no one prompt, so `tracked_query_id` and `surface` are null.
  The address an answer gives is not read (see the end of this section).
- **"For the first time" is said of the whole record, not of the window.** Seven scans cannot say
  "first". The rest of the window is in hand and rules out nearly every candidate, the businesses
  and sites the answers name week after week. `hasNewcomers` is what is left, and only when
  something is does `runScan` call `listSeenBefore(location, sampleData, FIRST_SEEN_SCANS - 1)`,
  which calls `seen_before()` in Postgres. That returns every business as it was written and every
  cited page's address up to its path, from the written answers of the location's finished scans
  of that kind other than the newest two (the scan that just ran is not yet finished, so those two
  and it are the latest three). It decides nothing: `deriveAlerts` compares the names and sites
  itself, by the rules above. `seen_before()` is granted to the service role alone, so only the
  worker reads it. Where it was not read (`seen` is null) no first sighting is raised. It covers
  every result the location has on those surfaces, so it costs more as the history grows, which
  the window in hand keeps rare.
- **What raises one and what clears one are different conditions.** After seven scans that did not
  name the business the window holds nothing that says it ever was, so a rule that looked only
  there would stop firing and clear an alert that had not ended. `runScan` gives `deriveAlerts`
  the window and the location's alerts that are not cleared (`listAlerts`). A drop is cleared as
  `named_again` when a check from a scan after the one that raised it names the business (any
  scan in the window, once the one that raised it has left), and as `not_tracked` when the newest
  scan has no cell for it: its prompt is retired or its surface is no longer checked. A drop is
  never cleared by age. A phone number is cleared as `no_longer_given` when no answer in the
  window gives it (one answer is enough to keep it, though two scans were needed to raise it), as
  `now_on_file` when it has become the number on file, and as `not_tracked` when the location has
  no number on file any more.
- **A first sighting is news, not a state.** Nothing ends it, so it is cleared as `old_news` when
  the scan that raised it has left the window, seven scans on. It is said once for a business or a
  site: afterwards the record holds it, so it is not raised again.
- **A dismissed alert is still current.** Dismissing takes it off the page and nothing else. The
  rule can go on firing, and a unique index allows one alert that is not cleared for a location,
  kind, subject (for a drop the prompt and surface, for a business its name as normalised, for a
  site its host, for a phone number the number) and kind of data, so the same thing is not raised
  again until the worker has cleared it and it begins afresh. A dismissed first sighting stays
  current until it is old news. A dismissed phone number stays current for good: dismissing it
  says the number is the business's own, so nothing clears it and it is never raised again,
  whatever the answers give or the number on file becomes. `complete_scan()` raises with
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
  dismissed and, for a drop, not about a prompt retired since the last scan, newest first. The next
  scan clears a drop on a retired prompt; one on a surface that is no longer checked shows until
  it does. The Overview tab lists them under "Alerts", above "What to do next". The drops one scan
  raised on one surface are one card (`groupAlerts`), because a surface that stops naming the
  business does so for every prompt at once; a first sighting and a phone number each stand alone.
  Each says what was counted and since when, links to where its evidence is (a drop to the Prompts
  tab, a business or a phone number to the Answers tab, a site to the Sources tab, and a site also
  to the page that was cited), and has a Dismiss that dismisses the whole card. On a phone number
  the button reads "This number is ours", since that is what dismissing it says. The locations
  table shows the count beside the location. The operator reading through an account sees alerts
  and has no Dismiss.
- **The owners are told in the scan report, once.** A scheduled scan's report already goes to the
  organization's owners where the deployment has a Resend key, the plan emails a report
  (`emails_report`) and the organization is not a test one, so an alert goes in that report and
  has no message of its own. Before sending, `runScan` asks `listAlertsToTell` what is still to
  say, for the kind of data the scan ran on (`AlertsToTell`, in `packages/shared/src/alerts.ts`):
  `raised`, the alerts not cleared, not dismissed and not yet told (`told_at` is null), and
  `named_again`, the drops the owners were told of that ended as `named_again`, were not
  dismissed, and whose ending is not yet told (`cleared_told_at` is null). They go on the report
  as `alerts`. `buildScanReportEmail` puts new alerts first, in the subject and at the head of the
  message. One group of them gives the subject `<location>: <the group's title>`: `No longer named
  for "<prompt>" on <surface>`, or `No longer named for N prompts on <surface>` when a group of
  drops is several (keywords on a Google surface); `<business> is named for the first time`;
  `<host> is read for the first time`, or `Your website is read for the first time` for the
  business's own; `The answers give a different phone number: <the number>`, written as the
  location's country writes one. Several groups give `<location>: N new alerts`, N counting
  alerts. Then comes one line for each drop that ended (`alertEnded`), then the report as it was.
  With nothing new, the subject and the message are what they were.
- **An alert is marked told only when the report went to someone.** `notify` answers whether it
  did (false, when the organization has no owner with an address), and only then does `runScan` call
  `markAlertsTold`, which sets `told_at` for the new alerts and `cleared_told_at` for the endings.
  A report that fails, or goes to nobody, leaves them untold for the next one (see "How a scan
  runs"). A manual scan sends no report, so what it raised goes in the next scheduled one if it is
  still open. An organization whose plan sends no report, or a deployment with no Resend key, tells
  no one of an alert, and the alerts still open go in its first report once it can send one.
- **What is not told.** An alert a member dismissed before it was sent. That a dismissed alert
  ended, even one the owners had been told of. That a drop ended because its prompt was retired
  or its surface is no longer checked (`not_tracked`), that a first sighting is old news
  (`old_news`), or that a phone number is no longer given or is now the one on file
  (`no_longer_given`, `now_on_file`, `not_tracked`). A drop that began and ended between two
  reports. Anything for a test organization. Telling changes nothing the page shows.
- Not built, and not planned: an alert about the address an answer gives. An answer gives part of
  an address, abbreviated differently each time, and no comparison of that is reliable enough to
  tell an owner theirs is wrong
  ([ADR 0015](adr/0015-an-alert-is-kept-not-worked-out-again.md)).

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

## Visits from assistants

An owner can paste one line into their own site so that the site reports the visits that arrive
from an AI assistant (`visit_lines`, `visits`; the terms are in `GLOSSARY.md`, the decision in
`docs/adr/0017-a-visit-is-counted-for-whoever-holds-the-site-key.md`). What exists is the line,
the route that receives what it sends, the database function that counts it, the function and
route that read the counts added up, and a card on a location's page that shows the last thirty
days of them, hands the line to its owner, lets them check that it answers from their site and
lets an owner or admin replace its key.

```
a visitor lands on the business's own site
        |
line.js, in the visitor's browser: did this arrive from a listed assistant?
        |  no: nothing is sent
        |  yes: POST /api/visits { key, referrer, tag, path }, with the site as Origin
        v
Worker: readVisit(), assistantOf() -> Store.recordVisit()    (publishable key, no sign-in)
        |
record_visit() in Postgres: the key's location, counts_visits(), the day's ceilings
        |
visits: one more for that location, day (UTC), assistant and page
        |
204 with no body, whatever became of the visit
```

- **The line decides in the visitor's browser, and sends nothing for any other visit.**
  `apps/web/public/line.js` reports a visit when the browser names a listed assistant's site as
  where the visitor came from (a subdomain counts), or, where it names no site at all, when the
  address carries an assistant's own `utm_source` tag, which is how a visit out of an assistant's
  app arrives. A tag is not believed over a site: a tagged link somebody posted elsewhere arrives
  from elsewhere. It sends the key from its tag's `data-site`, the host the visitor came from (or
  the tag, when that decided), and the page's path, never the address the visitor came from, which
  can hold what they asked, nor what follows a question mark. It sets no cookie and keeps nothing
  in the browser. It sends the post with `credentials: "omit"` and `referrerPolicy: "origin"`, so
  the request names the site and no page of it. It does nothing for a reload or a step back to the
  page, inside a frame, a second time on a page, or without a key.
- **The assistants are listed in three places.** `VISIT_ASSISTANTS`
  (`packages/shared/src/schemas.ts`) names them and `ASSISTANT_REFERRERS`
  (`packages/shared/src/visits.ts`) holds the hosts and tags each carries. `line.js` has its own
  copy, since it is a plain script, and `apps/web/test/line.test.ts` holds it to the shared one.
  The database names them too, twice: the check on `visits.assistant` and `record_visit()`'s own
  list, and the test in `packages/db` holds both to `VISIT_ASSISTANTS`. An assistant is listed only
  when its visits can be told from a search: Google's AI Overviews and AI Mode arrive from
  google.com as a search does, and Copilot's answers inside Bing from bing.com, so neither is
  counted.
- **The route** is registered before the sign-in middleware and builds its store from the
  publishable key, as `GET /api/audits/:token` does (`publicStore`). It ignores a body longer than
  4,096 characters (`LONGEST_VISIT`; one whose `Content-Length` says so is not read at all),
  checks what is left against `VisitSentSchema` (a visit, or a check), and takes the site from the
  `Origin` header, never from the body. It works out the assistant itself with `assistantOf`,
  where the site named decides and a tag counts only where none is named, and the line does not
  send it. It answers 204 with no body for a visit counted, one that was not, a body that is not
  what the line sends and a request with no `Origin`, so asking tells nobody whether a key is
  somebody's.
- **`record_visit()` trusts nothing it is told**, because the key is in the site's source and
  anyone can read it. It is a security-definer function granted to `anon`, `authenticated` and
  `service_role`, and returns whether it counted. It finds the location by its key and locks the
  line's row, so a location's visits are counted one at a time. `counts_visits()` then asks
  whether the location is not `paused_by_plan`, its organization's allowances include `visits`,
  and the host the post came from is the host of the location's `website` or a subdomain of it,
  compared in lower case without `www.` (`site_host()`), so a line copied onto somebody else's site
  counts nothing. The assistant must be one of the five. The page is cut at `?` and `#` and at 200
  characters (`LONGEST_PATH`) and must start with a slash. The day is the function's own clock in
  UTC, never the caller's. A location counts at most 1,000 visits a day (`MOST_VISITS_A_DAY`), and
  once 50 pages (`MOST_PAGES_A_DAY`) have been counted that day the visits to a page not among them
  are counted together under an empty path. The shared package holds the same numbers; the tests
  hold the function to them.
- **A check is not a visit.** When the address ends in `#nearcited-check` (`LINE_CHECK`) the line
  sends `{ key, check: true }` and no visit, even if the visit arrived from an assistant.
  `check_visit_line()` sets `visit_lines.checked_on` to today (UTC) when `counts_visits()` accepts
  the key and host, and counts nothing. The card on the location's page reads `checked_on` (see
  "The line is handed out by two signed-in routes") and says the day the line last answered.
- **What is kept is a count.** `visits` has one row for a location, a day (UTC), an assistant and a
  path, with how many. No row is a visit, and there is no time of day and nothing about the
  visitor. `visit_lines` has one row for a location, made by a trigger when the location is (the
  migration gave one to each location that existed): the `key`, 32 characters of hex from
  `gen_random_uuid()`, when it was made (`key_made_at`: with the location, or when an owner or
  admin last replaced it) and `checked_on`.
- **Who reads and writes.** Both tables have a `select` policy for whoever can read the location
  (`can_access_location`) and one for the operator, and no write grant for any API role. A caller
  who is not signed in has no grant on either. Only `record_visit()`, `check_visit_line()` and
  `replace_site_key()` write. The first two answer anyone holding a key; `replace_site_key()`
  answers only an owner or an admin of the location's organization (`has_org_role`), and gives a
  plain member, the operator and the worker no row and changes nothing. `anon` and `authenticated`
  can call none of `new_site_key()`, `site_host()`, `counts_visits()` and
  `give_location_a_line()`, and `anon` cannot call `replace_site_key()`. Apart from the payment
  webhook, which is signed, counting a visit or noting a check is the one write a caller who is
  not signed in can cause, and no route uses the admin client. Both tables go with their location,
  and the counts already kept stay readable when a plan stops including visits.
- **The line is handed out by two signed-in routes** (`apps/api/src/routes/visits.ts`), both
  through the caller's own store, so row-level security decides who sees a location.
  `GET /api/locations/:locationId/line` answers anyone who can read the location, the operator
  included, with `{ line, html, can_replace }`: the `visit_lines` row, the line to paste, and
  whether the caller may replace the key (`managesConnections`: an owner or an admin). The line
  to paste is built from `APP_URL` and the key (`lineToPaste`), so it loads the script from where
  the product is served. `POST /api/locations/:locationId/line/key` calls `replace_site_key()`
  and answers the new line with `can_replace` true; to anyone but an owner or an admin of the
  location's organization it is a 404, a plain member and the operator included. A new key has
  `key_made_at` set to now and `checked_on` cleared, since it has answered no check. The old key
  then belongs to nobody: the line still on the site counts nothing, and its checks note nothing,
  until the new line is pasted in its place. What was counted stays, since a count is kept for the
  location and not for the key.
- **The counts are read added up, by `location_visits(location, over_days)`.** It is a plain SQL
  function that runs as the caller, not a security-definer one, granted to `authenticated` and
  `service_role` and not to `anon`, so row-level security decides what is added up: a member's own
  location, or everything for the operator. For anyone else it returns the same shape with nothing
  in it. It counts back from today (UTC, today included) over `over_days` days, at least 1 and at
  most 366, and returns JSON: `since`, the first day added up; `days`, the count for each day and
  assistant that had any, oldest first; `pages`, the ten paths with the most (`PAGES_SHOWN`),
  equal counts in the order of their names; and `other_pages`, the visits kept under the empty
  path, which are the visits to pages past the fiftieth of their day. It adds up in the database
  because a location can hold up to 255 rows a day (five assistants, each on fifty pages, and the
  rest counted together), which over thirty days is past the 1,000 rows the database's API answers
  a request with and would be cut without an error (see "Limits to design around"). A location's
  `visits` are read this way and never row by row.
- **The counts are served by a third signed-in route**, `GET /api/locations/:locationId/visits`
  (`apps/api/src/routes/visits.ts`), through the caller's own store. `Store.getLocationVisits`
  calls the function for the last thirty days (`VISITS_SHOWN_DAYS`) and parses the answer with
  `LocationVisitsSchema`, which does not hold an assistant to the list, so a build that does not
  know one yet still shows it. It answers anyone who can read the location, the operator
  included; to anyone else the location reads as missing, a 404. Nothing is generated: on sample
  data and for a test organization the route returns what the site really reported, so the card
  has nothing to show there until a line really reports a visit.
- **The card shows the counts first.** `apps/web/src/components/VisitCounts.tsx` heads the card,
  above the line. It begins with one sentence holding the total over the last thirty days ("Your
  site reported 7 visits from assistants in the last 30 days.", or "Your site has reported no visit
  from an assistant in the last 30 days."). Where there are visits it then shows three native
  tables. By assistant, the one with the most first. By day, newest first, with which assistants a
  day's visits came from, and a note on a day that reached 1,000 (`MOST_VISITS_A_DAY`), the most
  counted in a day, which may therefore have had more. By page landed on, the ten with the most,
  and an "Other pages" row for the visits to pages past the fiftieth of their day. Under them it
  always makes two statements. The first is what the count leaves out, so that it is read as at
  least this many: Google's AI Overviews and AI Mode, and Copilot inside Bing, arrive as a search
  does; an assistant's app may say nothing of where a visitor came from; and a browser may block
  the line. The second is that anyone who reads the key can send made-up visits, so nothing else
  is worked out from the count, and that a day is a day in UTC. The adding-up for the page and its
  wording are in `apps/web/src/lib/visits.ts` (`visitsShown`, `COUNT_WORDS`, `assistantName`).
- **The card is `apps/web/src/components/VisitLine.tsx`**, titled "Visits from assistants", on
  the location page's Website tab. It is shown where the organization's allowances include
  `visits` (`visitsOffer`, `apps/web/src/lib/visits.ts`). Where they do not, it says "Your plan
  does not count visits from assistants." only if some plan on sale includes visits, which it
  reads from `GET /api/plans`, and gives the owner a link to the plans; where no plan does, it
  shows nothing. Every paid plan includes visits, so the sentence is what an organization on the
  free plan, or one moved down to it, sees. Such a card shows no line and counts nothing more. It
  still shows the last thirty days of what was counted while a plan counted it, and where nothing
  was counted it says nothing of counts, so nobody is told that a site reported no visit when
  nothing was listening. A test organization has the allowance and so sees the card with the
  line. Under the counts the card says what the line collects and what it does not, offers "Copy
  the line" and the line itself, says in plain words that it goes in the site's header code, and
  says where that is in WordPress, Wix, Squarespace and Shopify (`BUILDERS`). "Check the line"
  opens the website on file with `#nearcited-check` on the end (`checkAddress`) in a new tab; from
  then the page asks the route every three seconds (`LOOKING_MS`) for up to two minutes
  (`LOOKING_FOR_MS`) whether the line has answered, stops when it has, and says the day, in UTC, it
  last did. For an owner or admin there is also "Replace the key", behind a confirm that says the
  line on the site stops counting until the new one is pasted. A location with no website on file
  is asked for it first, because a visit counts only on that website, and a location paused by its
  plan is told its visits are not counted. The operator reading a customer's account sees the counts, the line and
  the check, and no way to replace the key.
- **`visits` is an allowance that is included or not.** It is in `allowance_kinds` (not counted)
  and `ALLOWANCE_KINDS`, and `VISITS_ALLOWANCE` is its key. Every paid plan includes it and the
  free plan does not (see "Tenancy"). Counting a visit takes nothing from a month.
- **Nothing rests on the count.** Anyone who reads the key can post made-up visits from a client
  that names the site, so the count can be padded, and the ceilings only bound how much one key
  can write. No score, alert, task or bill is worked out from it, and the card says so beside the
  counts ([ADR 0017](adr/0017-a-visit-is-counted-for-whoever-holds-the-site-key.md)).
- **The privacy policy says what the line collects**
  (`apps/web/src/pages/legal/Privacy.tsx`).

## Connections

A connection is an organization's standing sign-in to an outside account (`connections`; the term
is in `GLOSSARY.md`, the decision in `docs/adr/0013-a-sign-in-is-sealed-by-the-worker.md`). What
exists is making one, listing them, reading what one reaches, saying which of those is each
location's, breaking one that stops working, pausing one the plan stops including, and removing
one. There are three kinds, `sample`, `wordpress` (see "A WordPress site" below) and `hosted_pages`
(see "An answer subdomain" below). Nothing reads
anything from an account beyond what it reaches, and the only thing done through one is the
`sample` kind's action (see "Actions"). The `sample` kind never fails and needs no allowance, so
only a WordPress connection or an answer subdomain can break or pause in practice.

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
  `sample` kind has none to take back. A `wordpress` one deletes its application password at the
  site (below).
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
  which allowance a kind needs, and a kind not listed needs none: `sample` needs none and
  `wordpress` needs the `wordpress` allowance. `CONNECTION_KIND_ALLOWANCES` (`packages/shared/src/schemas.ts`) is the same list, and a test
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
  thirty days `removing` (an answer subdomain 120 days, once its pages have sent visitors on for
  ninety; see "Hosted pages"), with `removal_reason` `plan`, and queues the `remove` step for each, which
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
  and leaves out a kind the organization's allowances do not include. It makes up a sign-in and
  calls the account "Sample account", so the path runs with no outside account. On live data it
  offers `wordpress` to an organization that is not a test one and whose allowances include it.
  It never offers `hosted_pages` here, which is set up from a location (below). The page leaves
  both out of its connect buttons.
- **A WordPress site is connected from its location.** The generic
  `POST /api/organizations/:organizationId/connections` refuses the kind with 422
  `connect_from_location`. `apps/api/src/routes/wordpress.ts` has two routes for an owner or an
  admin of the location's organization (404 to anyone else, the operator included).
  `POST /api/locations/:locationId/wordpress/check` asks the location's website, with no sign-in,
  whether it is a WordPress whose REST index advertises an application-passwords authorization
  endpoint, and answers `ready`, `not_wordpress`, `passwords_off`, `unreachable` or `no_website`.
  The browser then sends the owner to that endpoint on their own site, with the app name
  Nearcited, a fixed app id and return addresses at `/wordpress/return`. WordPress hands back the
  site, a user name and a new application password on that address. `main.tsx` takes them off the
  address with `history.replaceState` before the app draws, believes them only with the state the
  tab kept in `sessionStorage`, and posts them once; `apps/web/public/_headers` gives that path
  `Referrer-Policy: no-referrer`. `POST /api/locations/:locationId/wordpress` signs in with them,
  checks the site is the location's website and the account has `publish_pages`, reads the
  password's uuid, seals `{ site, api, user, password, uuid }`, creates the connection through
  `create_connection()` with `from_location`, and queues the first sync. It never returns the
  password. It answers 422 `not_this_site`, `refused` or `cannot_publish`, 502 `unreachable`, 409
  `already_connected`, 503 `connections_unavailable` and 422 `connection_unavailable`.
- **A WordPress request is held to the site.** `apps/api/src/connections/wordpress.ts` finds the
  REST root from the home page's `Link: rel="https://api.w.org/"` header, or `/wp-json/` beside it,
  or `?rest_route=` on a site without pretty links. Every request without a sign-in goes through
  `safeSiteUrl` and each redirect is checked again. A signed request (`signedIn`) goes only over
  https to the site's own host (`www.` ignored) and never follows a redirect, so the password
  cannot be sent anywhere else. `WORDPRESS_LOCAL_ORIGIN` lets one origin on a developer's machine
  be reached over http and is never set on a deployment. A 401 or 403 throws `WordPressRefused`,
  which breaks the connection as `refused`. A sync reads the one site as the one choice, its home
  address with the label "name (host)". Removal deletes the application password by its uuid; if
  the site cannot be asked, the connection is still removed and the product's copy is deleted, and
  the failure is logged.
- **The first sync matches the location it was made from.** `connections.for_location` holds the
  location a connection was made from. `record_connection_sync()` matches it on the first sync
  when the account reaches exactly one thing, that location has no account of that kind and the
  thing is no other location's, then clears `for_location` either way. `create_connection()`
  takes `from_location` and returns no row when it is not a location of the same organization.
  The `wordpress` allowance is included or not, with no number. Pro and Enterprise include it,
  the migration `20261014110000_wordpress_connections.sql` put it on them and on each
  organization already on them except a test organization, and the Website tab's card appears only
  where the plan includes it.
- **An answer subdomain is set up from its location, and has no sign-in.**
  `POST /api/locations/:locationId/hosted-pages` (`apps/api/src/routes/hosted-pages.ts`) is for an
  owner or admin and answers 404 to anyone else; `GET` on the same path is for anyone who can read
  the location. The generic connect route refuses the kind with 422 `connect_from_location`, and
  `create_connection()` refuses it too. `create_answer_subdomain()` makes the connection, its match
  to the location and its `answer_subdomains` row in one step: the name is the owner's one word in
  front of the website's domain (`website_domain()`; `answerHostname` in the shared package works
  out the same), and the connection gets a random target of its own, `<12 characters>.pages.nearcited.com`.
  It refuses a test organization, a plan without the `hosted_pages` allowance, a location without a
  website, and a location that already publishes somewhere (an answer subdomain or a WordPress
  connection, each of which refuses the other: `hosted_pages_connected` on the WordPress routes,
  `wordpress_connected` here). The route also refuses a name that already resolves to anything
  (`in_use`), so a subdomain in use is not broken, and a name another live connection holds (`taken`;
  a unique index holds a hostname to one connection until its removal finishes). A deployment with no
  `CLOUDFLARE_HOSTNAMES_TOKEN` and `CLOUDFLARE_ZONE_ID` offers none, except on sample data
  (`hosted_pages_unavailable`; `barred` says why on the `GET`). The match routes refuse an answer
  subdomain (`not_matched_by_hand`), since it belongs to the location it was made for, and deleting
  the location removes it.
- **A name is registered only once its record points at the connection's own target.** The first
  check is queued when it is made; `syncConnection` runs `checkAnswerSubdomain`
  (`apps/api/src/connections/index.ts`) for the kind. The worker looks the name up over
  DNS-over-HTTPS (`cloudflare-dns.com`) and records what it found: `missing`, `ours`, `proxied` (a
  Cloudflare proxy hides where it points) or `elsewhere`. Only `ours`, a CNAME to this connection's
  target, has it registered at Cloudflare as a custom hostname (`registered_at`). That is what stops
  an account that made the subdomain first from putting its pages on someone else's domain. Once
  Cloudflare reports the hostname and its certificate active, the name is `live_at`; the worker
  then reads the business's home page for a link to it (`home_links`) and, once, emails the
  owners and admins that it works (`live_told_at`, set only when the email went). A check that
  throws counts as a failed sync of any connection. On sample data, or where nothing is
  configured, nothing is looked up or registered, and the check only records that it ran. A live
  name is served by the Pages Worker (see "Hosted pages").
- **The schedule keeps waiting names moving.** Every run (every 15 minutes) queues a check of each
  answer subdomain still working, not yet live and connected in the last thirty days, that has not
  been checked for ten minutes (`answer_subdomains_to_check()`, at most 100 a run), so an owner who has just added the record
  sees it work within minutes. The daily run calls `expire_unclaimed_answer_subdomains()`
  (`expireUnclaimedAnswerSubdomains`, worker only), which starts the removal of each not live
  thirty days after it was made (`RECORD_WAIT_DAYS`: its record never pointed at its target, or its
  certificate was never issued) with `removal_reason` `unclaimed`, and queues its removal. A
  location's deletion starts the removal of its answer subdomain (`removal_reason` `location`),
  which the sweep of stalled removals finishes within half an hour.
- **Removing one deletes the custom hostname and tells the owners.** `removeConnection` takes the
  hostname off Cloudflare where it was registered, calls `finish_connection_removal()`, which lets
  the name go, and emails the owners to delete their record, saying why (asked, plan, unclaimed or
  location). The card then says which name was removed and why, until another is set up.
- **A name is checked before it is taken.** The request refuses a name that already resolves, so
  nothing using it breaks, unless it is a CNAME to one of Nearcited's own targets, left from an
  attempt that was let go. A website at a site builder's own address (`BUILDER_DOMAINS`, such as
  `wixsite.com`) has no domain of its owner's, so the card offers nothing there
  (`no_own_domain`). The card warns when the website has moved to another registered domain
  (`underWebsite`); a move within the same one, such as to `shop.`, still matches.
- **Hosted pages are an allowance, included or not.** `hosted_pages` has no number. Migration
  `20261016100000_hosted_pages_kind.sql` added the kind of connection and
  `20261016110000_answer_subdomains.sql` the table, the functions, the allowance's entry in
  `connection_kind_allowances` and its turning on for Pro and Enterprise (see "Tenancy"). The
  members of the organization and the operator read an answer subdomain, but not `cloudflare_id` or
  `live_told_at`; no API role writes the table.
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
somebody removed it or its plan had not included it for thirty days (120 for an answer subdomain).
While a removal is waiting, or
a new account has not been read yet, the page asks again every couple of seconds.

## Hosted pages

A business's answer subdomain is a custom hostname on the `nearcited.com` zone (Cloudflare for
SaaS), so its requests reach that zone's routes under the business's own name. They are answered by
a second Worker, `nearcited-pages` in `apps/pages`, which serves hosted pages and nothing else
(`docs/adr/0019-hosted-pages-are-served-by-a-worker-of-their-own.md`). Registering a subdomain
stays the main Worker's (see "Connections"); the Pages Worker only serves what is registered.

- **It holds no secret and reads through one function.** Its settings are `SUPABASE_URL` and the
  publishable key, both in `apps/pages/wrangler.jsonc`. For a request it calls the database function
  `hosted_page(host, path)` over PostgREST with that key. The function (`security definer`, granted
  to `anon`, `authenticated` and `service_role`) answers only for a live answer subdomain: `live_at`
  set, not released, and its connection working, broken or paused. Its answer has a `kind` of
  `list`, `page`, `gone` or `missing`, with the business's name, website, address and phone; for any
  other host it answers null. A trailing slash is the same address. The Worker parses the answer
  with `HostedAnswerSchema`. The table behind it, `hosted_pages`, is read by no caller who is not
  signed in; the location's members and the operator read it through policies, and no API role
  writes it.
- **What it serves.** The list of live pages at `/`, a page at `/<slug>`, 410 for a page that was
  taken back, 404 for an address with none, `robots.txt` (everyone allowed, the sitemap named),
  `sitemap.xml`, and the IndexNow key file at `/<INDEXNOW_KEY>.txt` (the constant is in
  `packages/shared/src/hosted-pages.ts`). A host that is not a live answer subdomain gets a bare 404
  "Not found" whatever it asks. Only GET and HEAD are answered; anything else is 405. A request over
  http is sent to https with a 301. A certificate authority's checks, under
  `/.well-known/acme-challenge/` and `/.well-known/pki-validation/`, are handed on untouched over
  either, before anything else, since Cloudflare answers them for a custom hostname and the
  certificate is never issued otherwise.
  Every answer carries `Cache-Control: public, max-age=300` and a policy that forbids scripts,
  images and everything else a page could fetch. A page taken back can therefore still be read for
  up to five minutes.
- **A page is plain HTML.** The business's name links to its own site; the stored copy is rendered
  as headings and paragraphs, every word as text; the closing line is composed by rule from the
  location as it is when the page is served (`pageClosing`); the structured details
  (`buildBusinessBlock`) are the one script, as JSON-LD; and a generator tag is all of Nearcited's
  on it.
- **When the database cannot be read** it answers 503 with `Retry-After: 300`, not cached, so a
  crawler comes back and does not take the page for gone.
- **It hands the zone's own names on.** A route runs before a custom domain on the same zone, so the
  `*/*` route the Pages Worker needs would catch `nearcited.com`. The setup
  (`scripts/hosted-pages-setup.sh`, run once by the owner after a deploy) first puts a route with no
  Worker on `nearcited.com/*`, so the app is not routed through the Pages Worker at all, and the
  Pages Worker passes any request for `nearcited.com` or a subdomain of it straight on
  (`fetch(request)`) in case it is reached for one. Its `wrangler.jsonc` declares no routes
  (`workers_dev` is off), so deploying it changes no traffic. The setup also makes the fallback
  origin record, turns on custom hostnames, adds the wildcard record the owners' records point at,
  and makes the token the main Worker registers hostnames with (`CLOUDFLARE_HOSTNAMES_TOKEN`).
- **Pages are published by an action.** The `hosted_page` kind (see "Actions") writes `hosted_pages`
  through `publish_hosted_page()` and `take_back_hosted_page()`, which only the worker calls; no
  API role writes the table. A taken-back page stays as a row so its address answers 410.
- **A pause winds an answer subdomain down in three steps.** When a plan stops including
  `hosted_pages`, `fit_connections_to_plan()` pauses the connection. For `SERVED_AFTER_PAUSE_DAYS`
  (30) the pages are served as they were, and nothing new is published. From then,
  `hosted_page()` answers `redirect` with the location's website for every address, and the Pages
  Worker sends a 301 to it (a location with no website answers `gone`), for `REDIRECTED_FOR_DAYS`
  (90 more). Then `expire_paused_connections()` removes the connection, 120 days into the pause
  where every other kind is removed at 30. If the plan comes back before then, the connection is
  restored and the pages are served again. The owners are emailed once for a pause, when it begins,
  with both days (`tellPausedAnswerSubdomains`, from `answer_subdomains_paused_untold()`, worker
  only; `pause_told_at` marks it, and a pause nobody could be told of is tried again the next day).
  Taking back a hosted page is still carried out while the connection is paused, and nothing else
  is (`carryOutAction`), so an owner can still remove a page. The card and the Connections page say
  the two days.
- **A fetch by a known fetcher is counted, and the count proves nothing.** After it answers a
  live page (not the list, `robots.txt`, the sitemap, a page that is gone or an address with none),
  the Pages Worker looks at the user agent for one of `PAGE_FETCHERS`
  (`packages/shared/src/hosted-pages.ts`): ten fetchers, eight of assistants (GPTBot,
  OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, Claude-User, PerplexityBot,
  Perplexity-User) and two of search engines (Googlebot, Bingbot), each known by a word in its user
  agent (`fetcherOf`). It then calls `record_page_fetch(host, path, fetcher)` through
  `ctx.waitUntil`, after the answer is made, so the visitor waits for nothing; a count that fails
  is only logged. The function is granted to `anon` like `hosted_page()` and trusts nothing it is
  told: the day is its own (UTC), the page must be live on a live answer subdomain, the fetcher
  must be one the table's check names (the same list as `PAGE_FETCHERS`; add one in both), and a
  page's count for a day and a fetcher stops at `MOST_FETCHES_A_DAY` (1,000). It tells the caller
  nothing either way. `hosted_page_fetches` keeps only a count for a page, a day and a fetcher.
  `GET /api/locations/:id` reads it through `location_page_fetches()` (as the caller) for the last
  `FETCHES_SHOWN_DAYS` (30) days, added up per page task and fetcher with the last day
  (`listLocationPageFetches`), and each page task carries it as `fetches`, most first. The task
  shows a line naming the assistants' fetchers and the search engines apart (`fetchesLine`), and
  says that anyone can claim to be one. Nothing is scored, alerted or billed from it.
- **How it bills.** Every request to every answer subdomain runs the Pages Worker, which Cloudflare
  bills as Worker requests on the account's plan, and Cloudflare for SaaS bills custom hostnames
  past those its plan includes. What a hosted page costs in practice is not recorded here.

## Actions

An action is one thing the product does outside itself for a location, once a member says yes
(`actions`; the terms are in `GLOSSARY.md`, the decision in
`docs/adr/0014-only-the-worker-carries-out-an-action.md`). It is `proposed`, then `approved` and
`done` or `failed`; a proposed one can instead be `declined` or `lapsed`. There are four kinds.
`sample` sets the opening line of one of the sample account's listings, rows in `sample_listings`
that stand in for an outside service, so nothing leaves the product. `wordpress_details` adds the
business's details to the home page of a connected WordPress site, or changes them there (below). It
takes from the `wordpress` allowance, which is included with no number, so it counts nothing.
`wordpress_page` publishes a page task's copy as a new page on that site, on the same terms (below).
`hosted_page` serves the same copy on the location's answer subdomain, from `hosted_pages`, on the
`hosted_pages` allowance (below, and "Hosted pages").
A decision about what the product may change on a business's site is in
`docs/adr/0018-on-a-business-site-the-product-changes-only-what-it-made.md`.

- **Only the worker proposes.** After a sync that read a connection (`syncConnection` answers
  `synced`), the queue consumer calls `proposeAfterSync`. For each location matched to a working
  `sample` connection it composes an opening line by rule from the location's name and city
  (`sampleOpeningLine`) and, when the listing does not already say that, calls `propose_action()`,
  which only the worker may call. The proposal keeps what the listing said (`seen`), the text, and
  that a rule wrote it. Matching a location queues a sync (see "Connections"), so a proposal
  appears without waiting for the daily run. No request proposes. For a working `wordpress`
  connection it calls `proposeDetails` for each matched location. The site's front page must be a
  page (`show_on_front` is `page`, and `page_on_front` comes from the REST index; `readFrontPage`),
  and the account must be allowed to add scripts (`unfiltered_html`; `mayAddScripts`), since the
  block carries JSON-LD. The block is `buildBusinessBlock(location).html`. Nothing is proposed when
  the product's marked block on the page (`detailsOnPage`) already equals it. Otherwise "Add your
  business details to your home page" is proposed only while the `site:structured_data`
  recommendation is open, and is that task's action; "Update the business details on your home
  page" is proposed when the product's own block is there and differs. The subject is
  `details:<page id>` and `seen.text` is the product's block as it stands on the page, or null.
  A site that cannot be read while proposing is logged and skipped.
- **A page is proposed once its copy is written.** After `proposeDetails`, `proposePages` goes
  through the location's open page tasks (`page:` recommendations; `pagesToOffer`, which the hosted kind shares) that have no `prompt_pages` row,
  whose draft is of kind `page` with text, and where no page is at the address the copy's title
  makes (`pageSlug(pageParts(text).title)`, read with `readPageAt`). A page that is pending, a
  draft, private or scheduled counts as there; one in the trash does not. The subject is
  `page:<task id>`, the basis and `proposed_text` are the copy, the summary is "Publish the page
  “<title>” on your site", `seen` is null and the task is the action's. The queue consumer, after
  it writes a page draft for a location with a WordPress connection (`connectionToPublishWith`),
  queues that connection's sync, so the proposal comes without waiting for the daily run.
  For a working `hosted_pages` connection, which has no sign-in, `proposeHostedPages` offers
  `hosted_page` for the same page tasks (open, copy written, no address a member gave) while the
  location's answer subdomain is live and still under its website (`underWebsite`), and where no
  page is served at the address the title makes (`getHostedPage`). The subject is `page:<task id>`
  and the summary is "Publish the page “<title>” at <hostname>". `connectionToPublishWith` also
  returns a location's `hosted_pages` connection, so a written page draft queues a check that
  proposes at once.
- **One open action for a thing, and a no is remembered.** `subject` (what it is about) and `basis`
  (what the proposal rests on; here, the proposed text) are the worker's bookkeeping, and no route
  sends them. A partial unique index allows one `proposed` or `approved` action for a location, kind
  and subject. `propose_action()` makes none, and returns no row, while one is open, or while a
  declined one rests on the same `basis`. A lapsed one does not stop a new proposal.
- **Each kind is held to terms.** `action_kind_terms` has a row for a kind: the allowance it takes
  from (null for none) and how many days what it replaced may be kept (null for no limit). A kind
  with no row is held to nothing. No API role reads or writes it. The `sample` kind takes from no
  allowance and is given 30 days, though nothing limits how long a made-up listing may be held, so
  that dropping can be seen where the data is generated. `wordpress_details` and `wordpress_page` name the
  `wordpress` allowance, which counts nothing, and have no limit on keeping what they replaced;
  `hosted_page` names `hosted_pages`, which is the same, with no limit either.
- **A request records the answer.** `approve_action()`, `decline_action()` and `retry_action()` are
  security-definer functions that return a row only to a member of the location's organization
  (`can_access_location`), so their routes answer 404 to anyone else, the operator included. An
  action that is no longer waiting, or whose kind has no room left this month, raises `NC013`, a
  `limit`, so 409 `limit_reached` with the reason. A member may change the text while approving: `approved_text` then keeps it beside
  `proposed_text`, and stays null when the text sent is what was proposed. Only a kind in
  `EDITABLE_ACTION_KINDS` (`sample`, `wordpress_page` and `hosted_page`, whose copy is written onto the page as text) can be changed: the approve route answers 422 `not_editable` to
  a `text` for any other, and `carryOutAction` fails one that has `approved_text` anyway. Who answered is kept as
  the address they had then. Approving and asking again queue `{ action_id, step: "carry_out" }`; if
  the send fails, the request still succeeds and logs it.
- **Asking again is a new action.** `retry_action()` takes a `failed` action and makes another,
  already `approved` by whoever asked, with `retry_of` pointing at the one that failed, so the
  record keeps who approved each try. It refuses an action that did not fail, and one that has
  another waiting or on its way (`NC013`). The new action is for the same task and keeps the first
  one's `seen_until`.
- **Taking back is a new action.** `take_back_action()` (`POST /api/actions/:actionId/take-back`,
  with `requireNotice`, 201) takes an action that is `done` and makes another, already approved by
  whoever asked, with `takes_back` pointing at it. Its `seen.text` is what the first put there and
  its `proposed_text` is what the first replaced, null meaning that the block is removed. It answers
  any member of the location's organization and no one else, the operator included. It raises
  `NC013` (409) for an action that is not done, one whose `seen` was dropped, one with another open
  for the same subject, and one a later `done` action on the same subject has changed.
  `finish_action()` records the take-back and clears `acted_at` and `acted_by_action` on the task
  the first had marked. `propose_action()` does not propose again for a subject whose `done` action
  with the same basis was taken back, as it does not after a decline.
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
  `finish_action()` records each end, and only the worker may call it. For `wordpress_details` the
  handler reads the current front page and compares only the product's marked block
  (`<!-- nearcited:details -->` to `<!-- /nearcited:details -->`, wrapped in `<!-- wp:html -->` on a
  block-editor page and bare on a classic one) with `seen`. It then saves the page with
  `withDetails(raw, text)` (`packages/shared/src/wordpress.ts`), which replaces or removes only the
  marked block and keeps everything else, through `writePageContent`, which posts the page's
  content. A take-back may carry a null text, which removes the block.
  For `wordpress_page`, `createPage` posts a new published page with the title, the slug and
  `pageBlocks(text, pageClosing(location))` (`packages/shared/src/pages.ts`): each heading and
  paragraph a block with every character escaped as text, the closing line with the location's
  details last, and the title not repeated in the content. Before it writes, `current` finds the
  page at the slug and counts it as the product's only while its words (`pageWords`, which strips
  comments, tags and entities) start with the copy's; another page there is out of date. After it
  is done the worker calls `keepPublishedPage` (`keep_published_page()`, worker only), which keeps
  the page's link in `prompt_pages` for the task with the action's id in `action_id`; a second
  delivery finds the page and keeps its address too. Taking it back trashes the page (`trashPage`,
  a DELETE without `force`, so its owner can restore it from WordPress's trash), and
  `finish_action()` deletes the `prompt_pages` row the taken-back action kept.
  For `hosted_page`, which needs no sign-in (`carryOutAction` does not ask for one), `current` is
  the live page at the slug, and counts as the product's only while its copy is the action's.
  Apply publishes through the store (`publish_hosted_page()`, worker only: an approved action of the
  kind, on its connection's live, unreleased answer subdomain for the action's location, which
  inserts the `hosted_pages` row and answers `https://<hostname>/<slug>`; a second live page at that
  address is a unique violation). The address is kept for the task as a published page's is, so the
  scans count the answers that cite it. A take-back, through the existing `take_back_action()`,
  calls `take_back_hosted_page()`, which marks the page taken back; its address then answers 410.
  Either way the worker tells IndexNow (`tellIndexNow`, `apps/api/src/connections/hosted.ts`): a POST
  to `https://api.indexnow.org/indexnow` with the host, the key, the key file's address and the
  page's. It is skipped on sample data, and a notice that fails is only logged.
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
  out-of-date action marks nothing. The sample kind does no task's work. A `wordpress_details`
  action marks the `site:structured_data` task it was proposed for, and a take-back of it clears
  the mark.
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
text it would put there and who wrote it (editable for a kind that allows it, where the button then reads "Approve as changed"; the details
block is shown as code, with no text box),
"Approve" and "Decline" with a reason of up to 200 characters, and below it the record, newest first
(at most 100 actions in all), with "Try again" on a failed one and "Take it back", behind a confirmation, on a done one. The record shows what an action replaced ("What it replaced", or
"What was there" for one that was not done), or "No longer kept" once it was dropped. While an action is approved the
page asks again every couple of seconds. When the organization is held, a notice above the lists says
so. The sidebar says how many are waiting at each location
(`GET /api/organizations/:organizationId/actions/waiting`, asked every 30 seconds). The operator
reading through an account sees the tab and has no buttons.

## Drafts

A draft is wording written for one of an owner's tasks, so that the owner has less to write: the
note to the author of a page, the description a directory or review site asks a business for, or
the copy for a page on the business's own site that answers one of its prompts (`drafts`; the terms are in `GLOSSARY.md`, the decision in
`docs/adr/0016-the-worker-writes-a-draft.md`). It is `asked`, then `written` or `failed`. The
product sends nothing: the owner copies it and changes it wherever it is going. On sample data the text is generated; on real data Claude writes it, from the
instructions the private tuning holds for its kind.

- **Which tasks have one.** `draftKindFor` (`packages/shared/src/drafts.ts`) names the kind of
  draft for a kind of site: `note` for `editorial`, and `listing` for `directory` and for
  `reviews_unasked`, a review site that does not let a business ask for reviews, whose listing is
  claimed and filled in. There is none for `reviews`, whose work is asking customers and which the
  product writes nothing to (the request to send that task hands over is composed by rule and the
  code to print is drawn, and neither is written; see "Tasks"), or for `unknown`. A page task
  (see "Tasks") has the third kind, `page`, and no site: `draftKindFor` is not asked about it. The three kinds are
  `DRAFT_KINDS` (`packages/shared/src/schemas.ts`), and the check on `drafts.kind` takes all three. A draft of any
  kind is asked for, written, checked, kept and counted the same way, against the one monthly
  number. `buildTasks` puts it on a task as `draft_kind` only while the task is still to do and only
  where a draft of that kind can be written, and puts the task's own `draft` beside it, kept after
  the task is marked done. There is one draft for a task (`recommendation_id` is unique).
- **A task is offered a draft only where one can be written.** `buildTasks` takes an optional
  `writes(kind)` (`packages/shared/src/tasks.ts`); left out, every kind can be written, and where it
  says a kind cannot, that task's `draft_kind` is null, as if it had no draft, and the page shows it
  no button. `GET /api/locations/:id` passes one that is true for every kind on sample data (a
  deployment in mock mode or a test organization) and, on real data, true only for a kind
  `writesRealDrafts` accepts, the test the draft route applies: instructions for the kind in the
  private tuning, and `ANTHROPIC_API_KEY`. So a task is never offered a draft that asking could only
  refuse with 503, and a build with neither offers none on real data. The plan is a separate matter:
  a task keeps its `draft_kind` on a plan with no drafts, and the card offers nothing there because
  the month's `allowed` is null (`draftsStanding`, below).
- **A member asks, and a request records it.** `POST /api/locations/:locationId/tasks/:taskId/draft`
  reads the location's tasks as they stand (`currentDraftSubjects`, `apps/api/src/tasks.ts`: the
  source tasks of `currentTasks`, the same pool the rates use, and the page tasks of `buildPageTasks`, each
  reduced to what its draft is written for, without the counts either side of a mark, and for the
  kind of data the page shows)
  and refuses what it can before anything is recorded (`draftRequest`): 409 `no_draft` for a task
  that is gone or has no wording to write, and 409 `what_we_do_missing` until the location has said
  what the business does (`locations.what_we_do`), because without it a draft would be a name and a
  city and whatever a writer made up. On real data it answers 503 `drafts_unavailable` where the
  build has no instructions for the draft's kind (`Deployment.draft_kinds`, from `liveDraftKinds`)
  or the deployment has no `ANTHROPIC_API_KEY` (`writesRealDrafts`); sample data is not refused
  for either. Before any of those it asks whose organization the location is (`listOrganizations`,
  which goes by membership and not by what the caller can read) and answers 404 to anyone who is
  not a member, the operator included, so a task that would be refused tells them no more than a
  stranger is told. Then `ask_draft()` records the ask. It is a security-definer function that
  returns a row only to a member of the location's organization (`can_access_location`), whoever
  the route let through. It raises `NC014`, a `limit`, so 409
  `limit_reached`, when the plan includes no drafts or the month's are used (`allowance_has_room()`).
  It locks the task, so two asks arrive one after the other, and an ask made while a draft is
  `asked` is that same ask. Asking after one has been written or has failed puts the row back to
  `asked` and keeps the text. It takes nothing from the month. The route then queues
  `{ draft_id, step: "write" }` and answers 202; if the send fails the request still succeeds and
  logs it. A task is not offered a draft where the 503 would be the answer, so only a request made
  by hand, or from a page loaded before a deploy, reaches it.
- **Only the worker writes.** The queue consumer calls `writeDraft` (`apps/api/src/drafts/index.ts`).
  `claim_draft()` takes the draft and counts the try, and answers zero, and the worker goes no further,
  unless the draft is `asked` and no worker has had it in the last ten minutes. The worker then reads
  the draft, the location and the organization, and the location's tasks, from what is on file, and
  works out again what the draft is written from, so nothing a request said decides it. If the task
  is gone, or no longer has wording to write (it was done, or the business's description was taken
  away) in the meantime, the ask is failed with the reason and what it took from the month is given
  back. Sample data is a deployment in mock mode, or a test organization. A deployment in mock mode
  hands the worker no model, whatever keys it holds; any other is handed `createLiveDraftWriter`'s,
  which is nothing without `ANTHROPIC_API_KEY` or without instructions for any kind. `writerFor`
  chooses `sampleWriter` for sample data and otherwise that writer, and only for a kind it has
  instructions for; where there is none (the key or the instructions went between the ask and the
  write) the ask is failed with "Drafts cannot be written here yet." and the month given back.
- **A draft is written from what is held, and nothing from the answers.** `DraftGiven` is the
  location's name, city, region, category and website, `what_we_do`, the site the task is about and
  the page of it the answers cited most, and, for a page, `prompt`, the prompt it answers as the
  location tracks it (null for the other kinds). For a page the site is the business's own, and
  the prompt counts as given, so the check below lets it be repeated. A detail not on file is null and is not filled in. What an
  assistant said about the business is the thing measured and is not given. A writer
  (`DraftWriter`) only writes: it names the kinds it writes, returns text, and reports what each
  call used (`onUsage`). Whether the text may be kept is decided here.
- **A rule checks every draft before it is kept.** `factsNobodyGave` lists the numbers, web
  addresses and email addresses in the text that are not in `DraftGiven`; a web address passes as one
  that was given or as the site of one, so a made-up page of the business's own site does not. A
  draft that names any is thrown away and written once more (`MOST_WRITES`, two in all), and if the
  second does too, or the text is empty, nothing is kept and the ask fails with that reason. What was
  said is not logged, only how many things nobody gave. The rule reads characters, not meaning: it
  catches an invented phone number, year, price, link or address to write to, and does not catch a
  boast. It runs on whatever wrote the text.
- **Sample text is nobody's writing.** For sample data, `sampleWriter` (`apps/api/src/drafts/sample.ts`)
  generates the text for the kind from `DraftGiven` (a note, one short paragraph for a listing, or a short titled page)
  and calls nothing. It goes through the same check and the same count, and is kept with
  `sample_data` true and no `model`. The page labels it as sample text that no model wrote, and a
  real draft as a model's.
- **A real draft is written by Claude, with no tools.** `createClaudeDraftWriter`
  (`apps/api/src/drafts/claude.ts`) calls Anthropic's Messages API through its SDK, with no web
  search and no other tool, so it cannot look up the business and bring back what it finds. The
  system prompt is the instructions for the draft's kind, from `drafts.instructions` in the
  tuning, so a build writes a kind on real data only if its private tuning has instructions for that
  kind (a build with them for a note and none for a listing writes notes and refuses to ask for
  listings); the user message is `setOut(given)`: `DraftGiven` one detail to a line, each with its
  name, and "not on file" for one that is null, the same way every time. For a page it ends with
  "The question the page answers" in place of the site and page lines. The model, its effort and
  the longest a draft may run (`max_tokens`) are the tuning's too. It makes one call per write,
  with a 60-second timeout and no retries, since a draft that fails is not counted and its reader
  asks again. It joins the text blocks of the answer and throws on a refusal or an answer that did
  not end (stopped at `max_tokens`), which fails the ask like any writer that throws. The
  instructions are the private part and the check is not: `factsNobodyGave` runs on whatever
  comes back. It needs `ANTHROPIC_API_KEY`, the one variable Claude scans use.
- **What the writing used is recorded after every write, kept or not.** `writeDraft` adds up what
  the writer reports (`usageTally`, with no surface) and, after each write, calls
  `recordUsage({ organization_id, draft_id }, rows)`. A draft the check threw away, and a call whose
  answer was refused or cut short, are recorded as much as a draft that was kept, because they were
  paid for even though the month is given back; a request that got no answer reports nothing.
  Sample text reports nothing and records nothing. Failing to record is logged and changes
  nothing about the draft. A row has a null `surface` and a `draft_id` that is set null if the
  draft goes with its task, so the row outlives it. `usage_by_month()` is unchanged, so the
  operator's spend counts a draft's use in its organization's month, priced by the tuning's rates
  like a scan's (see "How a scan runs").
- **A try that something gets in the way of is made again, three times in all.** A writer that throws
  fails the ask at once ("Nothing was counted."). Any other error, such as a failed read, lets go of
  the draft with `finish_draft()` saying `again`, and the queue consumer asks for the message again in
  a minute (`MOST_ATTEMPTS`, 3); the third fails it. A failed ask keeps the text from before.
- **The month is taken when the worker takes the draft, and given back when nothing was written.**
  `claim_draft()` calls `claim_allowance()` for `drafts`, once for all of an ask's tries, and keeps
  the month in `allowance_month`. When the month has no room (it ran out after the ask) the ask is
  failed there. `finish_draft()` calls `release_allowance()`, into the month it came from, when the
  ask ends `failed`, and keeps it when it ends `written` or `again`. Asking again takes one more.
  `draftsStanding` puts where the month stands on `GET /api/locations/:id` as `drafts`: the plan's
  number for each location the plan covers, how many are used, and the first of next month, when the
  count starts again; `allowed` is null for a plan that includes none.
- **A lost message is asked for again.** Every run of the schedule calls `requeueStalledDrafts`: each
  draft asked more than 15 minutes ago that no worker has, or that a worker took more than 15 minutes
  ago, goes on the queue again, at most 100 a run. That covers a message that was lost, a draft
  the worker let go of to be tried again, and a worker that died, whose hold lasts ten minutes.
- **Who reads and writes.** `drafts` has a `select` policy for whoever can read the location and one
  for the operator, and no write grant for any API role. A request writes only through `ask_draft()`;
  `claim_draft()` and `finish_draft()` answer the worker alone. `asked_by`, `writing_since`,
  `attempts`, `allowance_month` and `model` are the worker's bookkeeping, and no route sends them. A
  draft is deleted with its task and with its location.

- **Page copy is read by rule, and ends with a closing line the product composes.** The copy's
  first line that is not blank is its title, a block starting `## ` is a heading and any other is a
  paragraph (`pageParts`). The owner copies it whole with `pageToCopy`: the copy, then
  `pageClosing`, composed by rule from the location's name, address, region, postal code and its
  phone number formatted for its country, each only where on file; no model writes it. `pageSlug`
  makes an address from a title, for publishing (see "Actions").

On the Overview tab each task card shows its draft (`TaskDraft`). The Website tab's page tasks use
the same card, which for page copy shows it as a page, offers "Copy the page" and "Mark published"
(which marks the task done) and, once marked, asks "Where is the page?". While the site is connected
and the copy is written it says instead that Nearcited asks to publish the page, to be approved or
changed on the Actions tab, and a page the product published shows "Published by Nearcited at" its
link, with no Change or Remove. "Write a draft" asks for one; if the
location has not said what the business does, the card asks first, under "What we do", and saves
it to the location (`PATCH /api/locations/:id`) before asking. While a draft is `asked` the card says one
is being written and the location page asks again every two seconds. A written draft is shown with a
label saying who wrote it and a button that copies it; "Write it again" replaces it, says it counts as
one more, and leaves the first on the page until the second lands. A failed ask says why. When the
month's drafts are used the card says on what day more come, and the organization's owner is
pointed at the plans. Where the plan includes none, as the free plan does, no card offers a draft; a line
above the tasks says so, and links the owner to the plans, only where some task has a `draft_kind`
(so a build that writes none on real data shows neither a button nor the line) and some plan on
sale includes drafts. The operator reading through an account sees a draft and has no buttons.

## Tenancy

Every row belongs to an organization, and a user reaches a row only through a membership. The
exceptions are `audits`, described above, and `provider_usage`, which keeps its rows after the
organization, scan, audit or draft they describe is deleted. No API role can write either table, and
the only account that can read them is the operator's; the Worker's secret key writes them. Four
more, `connection_secrets`, `connection_kind_allowances`, `sample_listings` and `action_kind_terms`,
no API role can read or write at all (see "Connections" and "Actions").
`hosted_pages` is read by an organization's members and the operator and written by no API role, only by the worker's `publish_hosted_page()` and `take_back_hosted_page()`; a caller
who is not signed in reaches a live page only through `hosted_page()`, which answers for a live answer
subdomain alone and is, with `record_page_fetch()`, the only thing the Pages Worker calls (see "Hosted pages").
`hosted_page_fetches` is read by the location's members and the operator, with no policy or grant for
a caller who is not signed in, and written by no API role, only by `record_page_fetch()`.

A caller who is not signed in can read an audit by its token and the price list, and can write one
thing: count a visit to a location's own site, or note a check of the line on it, through two
functions that answer anyone holding the location's site key (see "Visits from assistants").
It can also read a live hosted page through `hosted_page()`, and count a fetch of one by a known
fetcher through `record_page_fetch()`, which needs no key and ignores anything it should not count
(see "Hosted pages").

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
- **A plan includes a kind when its row says so.** Every paid plan includes `drafts`, a number a
  month for each location it covers, and the free plan has none. The migration
  `20261012180000_drafts_on_plans.sql` set the numbers the plans started with, and the operator can
  change them like any other setting of a plan. The same migration gave an organization already on
  one of those plans its plan's number, as if the operator had set it, since a plan gaining
  something takes effect at once. It set only that one key, so the organization's other limits,
  including any the operator had set for it alone, stayed, and it left a test organization the
  number it was made with. Every paid plan includes `visits` and the free plan does not, so the
  price list shows the kind on the paid plans ("Visits from assistants counted"). The migration
  `20261013220000_visits_shown.sql` did for it what that one did for drafts: it put the kind on the
  paid plans and gave it to each organization already on one, except a test organization, which
  has had it since the kind was made, and touched no other limit.
  `wordpress` is included or not like `visits`: `20261014110000_wordpress_connections.sql` put it
  on Pro and Enterprise and on each organization already on them except a test organization.
  `hosted_pages` is the same: `20261016110000_answer_subdomains.sql` turned it on for them (the kind
  itself came in `20261016100000_hosted_pages_kind.sql`).
- **Use of a counted kind is kept in `allowance_use`**, one row for an organization, a kind and a
  calendar month in UTC. Its members read their own organization's rows and the operator reads
  all of them; no API role writes it, since a count a member could write is a count a member could
  clear. `claim_allowance()`, which only the worker may call, adds to the month while the
  organization's number for the kind, times its locations limit (extra locations included), has
  room, locking the organization row so two claims at once cannot both take the last one. It says
  whether it claimed, what the month allows and how much of it is used. `release_allowance()`,
  also worker only, gives back what was claimed for a month, for work that was then not done. A kind
  that is included without a number is not counted. Only the action functions and the draft
  functions call either. Two kinds exist. `drafts` is counted, by `claim_draft()` and
  `finish_draft()` (see "Drafts"). `visits` is included or not, so nothing is claimed for it:
  `counts_visits()` checks that the organization's allowances name it before a visit is counted
  (see "Visits from assistants"). No kind of action is counted yet (see "Actions" and "Known
  gaps").
- **A kind of connection can name the allowance it needs**, in `connection_kind_allowances`; see
  "Connections".

Users can insert exactly one kind of scan row: a queued, manual scan in their own name for a
location they can see. Results, scores, recommendations and alerts are written only by the worker;
a member can dismiss an alert and nothing more (see "Alerts"), can ask for a draft and nothing
more (see "Drafts"), and can give a location's listing on a site and take it away, and nothing more
of one (see "Tasks").
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
reads through the request's store, never the secret key. A list it reads across every
organization (the week's scans, say, or every location) is read a page at a time, because the
database's API answers with at most 1,000 rows and says nothing about the rest (see "Limits to
design around"). `buildOperatorOverview` in
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
- **The database's API answers a request with at most 1,000 rows and says nothing when it leaves
  the rest out** (`max_rows` in `supabase/config.toml`, and the hosted default). A list read in one
  request is right until it is long and then short, with no error. So every list in the Supabase
  store that reaches across organizations and is used whole goes through `every` (`readEvery` in
  `apps/api/src/store/paging.ts`). The first page asks for the exact count, each next page starts
  after the rows that actually came, so a server that answers with fewer than a page loses nothing,
  and it stops at the counted number or at an empty page. A page that fails fails the read: no part
  of a list is handed back as if it were the list. Each list is asked for in an order no two rows
  share, and oldest first wherever its rows have a time they were made, so a row made meanwhile
  lands past the end. The scans, audits and accounts are handed back newest first, so they are
  reversed after they are read. Two lists have no such time and are ordered by a key: the notices
  of an announcement, by organization, and the usage added up by month. The pages are separate
  requests, not one snapshot, so a row made meanwhile can be read twice there, and in any list a
  row that leaves it meanwhile (an action told, say) moves the rows after it up one, so one of them
  can be missed until the next read.
  Each page is also a subrequest of the invocation that reads it (see the first limit above).
  What is left in one request is a list of one organization or one location, which its plan
  bounds, and the work lists the schedule reads again at its next run (the stalled actions and
  drafts, the connections' lists): a cut there delays the rest to the next run, for as long as the
  work done leaves the list. One list of a location is not bounded under 1,000 by its plan: its
  visits, which can be 255 rows a day and are kept. They are never read row by row. They are added
  up in the database, by `location_visits()`, which answers a day's count for each assistant, ten
  pages and one more number, so what the API returns is short however many rows were added up (see
  "Visits from assistants").

## Known gaps

- A manual scan whose queue send fails leaves a `queued` row with no message behind it. The
  sweep fails it within about 45 minutes, and until then the location cannot be scanned again.
  A signed-in user cannot update a scan, so the request that hit the failure cannot clear it.
- On a Supabase project that still signs tokens with a legacy shared secret, `getClaims` asks the
  Auth server on every request. Use asymmetric signing keys.
- Allowances limit little yet. Four kinds of allowance exist (`ALLOWANCE_KINDS` and
  `allowance_kinds`): `drafts`, counted, and `visits`, `wordpress` and `hosted_pages`, included or not.
  Every paid plan includes `drafts` and `visits`, Pro and Enterprise include `wordpress` and
  `hosted_pages`, and the free plan includes none. A test organization is given every kind, so its
  drafts are counted and its visits and WordPress connection are included, but it is refused an
  answer subdomain, whose pages would go out under a real domain. Only the `wordpress` and
  `hosted_pages` kinds of connection name an allowance, and no kind of action does, so a number for another kind would be stored, shown and
  lowered by announcement, but no work would stop at it or be counted against it. What an allowance can stop is
  a kind of connection that needs it (see "Connections"), a kind of action that takes from it (see
  "Actions"), a draft (see "Drafts") and counting a visit (see "Visits from assistants"), and only
  the last two exist ([#133](https://github.com/jwh3times/Nearcited/issues/133)).
- A real draft is written only where the private tuning has instructions for its kind, and it
  needs them before a deployment writes one, or offers a task one (see "Tuning" and "Drafts"). What a real draft costs has
  been measured only in a trial, whose readings are kept privately: a draft's use is recorded, so
  the figure can be read from `provider_usage` once real drafts are written, and a month given back does not return what a failed write cost, so a
  writer that keeps failing the check is paid for twice an ask and shows only in the operator's
  spend. Three kinds of draft exist: the note to the author of a page, the description for a
  listing and the copy for a page on the business's own site. Only a connected WordPress site has
  that page published for it, on approval; the owner of any other does it and says where it is. The check on what a draft states
  reads characters and not meaning.
- A listing is kept as a member gave it, and only its form is checked: an address on the right
  site that leads to no page, or to another business's, is kept, because nothing opens it (see
  "Tasks"). A review-form link is made from the listing's address by a shape read once on the
  site's pages. If a site changes how its form is addressed the link breaks, and nothing notices
  until somebody reads the site again. The same is true of Google's link, which is believed as it is
  pasted, and of the steps an owner is shown for finding it: they name what Google's help names
  today (Business Profile, Read Reviews, Get more reviews, Copy), so if Google renames any of them
  the steps go stale until somebody reads its help again. Its help does not show what the link looks
  like, so what is taken for one is where accounts of it put it.
- Nothing seals the sign-ins again under a new `CONNECTIONS_KEY`. Changing or losing the key makes
  every sign-in kept unreadable and its owner has to connect again; a sync of one changes nothing,
  and a removal still finishes but cannot take the access back at the outside service (see
  "Connections").
- A match whose choice a later sync no longer finds is kept as it was: the account may have lost
  the thing, or its access to it. The Connections page names it "no longer found" so its owner can
  choose again. The sample kind of action acts through a match and does not check that the choice
  is still there; `wordpress_details` reads the site's front page afresh each time.
- A WordPress connection is read, and what is written through it is the business details block on
  a home page that is a page (`wordpress_details`) and a new page for a page task
  (`wordpress_page`); nothing else is published to the site. A page is proposed only where nothing
  is at its address, so a title whose address is taken gets no proposal until the copy changes or
  the page there is gone. A page stays the product's while its words start with the copy's, so what
  an owner adds after the copy does not make it theirs.
  A site whose front page shows the latest posts, or whose account cannot add scripts, is offered
  nothing. A page builder such as Elementor or a caching plugin may keep the block from showing,
  which the Website tab says when a scan since did not find it. The check that a site offers application passwords reads
  its REST index, so a site that hides the index or a firewall that blocks the Worker reads as
  `not_wordpress` or `unreachable`. A password the owner revokes in WordPress is found at the next
  sync, which breaks the connection as `refused`; there is no signing in again, so it is removed
  and made again. A site is matched only to the location it was connected from.
- The `structured_data` check passes for a block that names the business and gives an address, and
  compares nothing else in it, so a phone number or street address that differs from what is on
  file passes. Opening hours are not held, so the block has none.
- The real kinds of action, `wordpress_details`, `wordpress_page` and `hosted_page`, take from an allowance that
  counts nothing, and nothing limits how long what they replaced is kept. A kind that counts, or that has a limit, has not
  been made yet. A take-back is refused once a later action on the same subject has changed what
  the first left, and once the first's `seen` was dropped.
- Fetches of a hosted page are counted from the user agent alone. Anyone can send one, so the count
  can be padded; the ceiling in `record_page_fetch()` bounds what one page and fetcher can add in
  a day, and nothing is worked out from it. A fetcher that names itself with another word, or none,
  is not counted, and the list was read from the fetchers' published names, so one that is renamed
  counts nothing until the list is changed. The page task shows the last thirty days only.
- An answer subdomain whose plan stops including `hosted_pages` is paused, then redirected, then
  removed, and its owners are emailed once to delete the record when it is removed. A name whose record is proxied by Cloudflare
  hides where it points, so it is not registered until the owner turns the proxy off. The name is
  looked up through one resolver, `cloudflare-dns.com`.
- What each assistant's visits carry (`ASSISTANT_REFERRERS`) was read on 2026-10-13 from published
  accounts of what each assistant sends. Nobody followed a link out of each one to see, so a host
  or tag that is wrong counts nothing and says nothing.
- The count of visits leaves out what cannot be told from something else. Google's AI Overviews and
  AI Mode, and Copilot inside Bing, arrive as a search does and are not counted. Neither is a
  visit from an app that sends no site and no tag, or one from a browser that blocks the script.
  It is a floor, and the card says so under the counts (see "Visits from assistants").
- The count of visits can be padded by anyone who reads the site key, which is in the site's
  source. An owner or admin can replace the key (`replace_site_key()`), but only they decide to,
  and nothing notices a padded count. The ceilings in `record_visit()` bound what one key can
  write, and nothing is worked out from the count. The card says it can be padded, beside the
  counts.
- The card shows the last thirty days of visits and no more. Older counts are kept with their
  location and shown nowhere: the route asks `location_visits()` for thirty days
  (`VISITS_SHOWN_DAYS`), though the function takes up to 366, and no page asks for a longer run.
- The days in the counts are days in UTC, as the database keeps them, because a location holds no
  time zone. A visit late in a local evening may be counted on the next day, and the card says a
  day is a day in UTC.
- On sample data the card is empty until a line really reports. Nothing is generated for a
  deployment in mock mode or for a test organization, so the counts there are only what a line on
  a real site reports to that deployment.
- Where the line goes in WordPress, Wix, Squarespace and Shopify is given in each builder's own
  menu names (`BUILDERS`, `apps/web/src/lib/visits.ts`), read from each builder's help pages on
  2026-10-13. A builder that renames a menu makes its line wrong, and nothing notices until
  somebody reads its help again.
- The host's request logs see the request to `POST /api/visits`, and the one for `/line.js`, like
  any other, as the privacy policy says. Nothing from them is kept with a count.

## Open product questions

These are not engineering tasks, and the code cannot answer them.

1. **Does anything the product recommends move the number?** Partly answered: every rule now
   states what a later scan must show for it to have worked, and clears itself when that happens
   (see "Where the answers come from"). Still open: whether acting on one makes it clear more
   often than doing nothing, which only real locations over time can show, and whether a higher
   score means more calls or visits. The score stays a description of visibility. Visits from an
   assistant are now counted and shown for a location whose owner has pasted the line (see "Visits
   from assistants"), but nothing compares them with how often the business is named, and a count
   that is a floor and can be padded is weak evidence either way.
2. **What is one sample worth?** Partly answered: results are now rates over the last seven
   scans (see "Rates over a window of scans"), which costs nothing extra per scan. Whether seven
   is enough is still open. Assistant answers vary run to run and by location. One call per
   check is an anecdote. Sampling enough to be credible multiplies cost per location.
3. **What does a location cost to serve?** Map pack data is bought per keyword, per location, per
   run. Price the plan from that number, not the other way round.
4. **Who buys?** Single-location owners churn and are expensive to reach. Agencies managing many
   locations are the more plausible first customer, and they will want white-label reports.
5. **The score weights are a guess** (the defaults in `packages/shared/src/tuning.ts`). Nothing ties a rank on
   any surface to calls yet, or to visits: the visits a site reports are counted and shown on the
   Website tab, not worked out with the score, and the count is a floor that can be padded.
