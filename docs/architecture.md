# Architecture

## One Worker, three entry points

`apps/api/src/index.ts` exports a single Worker with three handlers:

- **`fetch`**: the HTTP API, a Hono app mounted at `/api`. Only `/api/*` reaches the Worker.
  Every other path is served from the web app's build output, with unknown paths falling back to
  `index.html` so client-side routes work. That routing lives in `wrangler.jsonc` under `assets`.
- **`scheduled`**: two Cron Triggers. Every 15 minutes it fails scans that have been queued or
  running for more than 30 minutes, so an abandoned scan cannot block its location for long. It
  also fails audits still `queued` after 30 minutes (see "Shareable audits").
  Once a day it also asks Postgres which locations are due (`locations_due_for_scan`), creates a
  `scheduled` scan row for each, and puts the scan IDs on the queue.
- **`queue`**: the consumer. For each scan ID it runs the scan and, for scheduled scans, emails
  the organization's owners. A message shaped `{ audit_id, prompt_index }` is one prompt of a
  shareable audit instead (see "Shareable audits").

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
     complete_scan() in Postgres: results, score, last_scanned_at and
     recommendations, in one transaction
                       |
     recordUsage(): what the providers used, by surface and model (also on failure;
                    nothing on sample data)
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
model is a tuning value (`chatgpt.model`). The provider reports each call's usage as it makes it,
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
  answer that cited it named the business. At most three, most cited first.
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

`buildActionPlan` (`packages/shared/src/actions.ts`) turns the evidence into an ordered list of
at most four steps. The location route calls it over the scan window and `toPublicAudit` calls it
over an audit's samples, so both pages show the same plan from the same code.

| Step | Shown when | Evidence it carries |
| --- | --- | --- |
| `fix_website` | The on-page check failed something, at any answer count; or every check passed (or none was made, or the page could not be loaded) and no answer cited the site, of at least four. | The failed checks, as the reasons, each with its fix. |
| `get_listed` | A site was cited in at least two answers and none of them named the business. | Up to five such sites, with the page that was read. |
| `keep_listings` | A site was cited in answers that did name the business. | Up to five, most often first. |
| `competitors` | The answers named other businesses. | The three named most, linked to their own site when it was one of the pages read. Among businesses named equally often, one with such a link comes first. |

Steps are composed by rule, never by a model, and each states the observation it rests on. For
`fix_website` on a site no answer cited, the title and summary depend on whether a failed check
blocks reading (`BLOCKS_READING`: `reachable`, `crawlers_allowed`, `text_content`).
A site whose address contains a named competitor's name run together is treated as that
competitor's own, so nobody is told to get listed on a rival's website; that match is a guess and
is used for nothing else.

A location's on-page check is kept in `scans.site_check`, written by the worker just before it
completes the scan, so the page can show the whole checklist and the plan can give reasons. The
recommendations a scan stores are unchanged; the location page leaves the ones the plan already
covers (`source:*`, `site:*`, `own_site_uncited`) out of its list.

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
- **No endpoint creates an audit.** A public one would let anyone spend the provider budget, and
  a signed-in one would have to decide whose budget it was. The owner creates audits with the
  secret key, from `scripts/create-audit.mjs`.

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

## Tenancy

Every row belongs to an organization, and a user reaches a row only through a membership. The
exceptions are `audits`, described above, and `provider_usage`, which keeps its rows after the
organization, scan or audit they describe is deleted. No API role can write either table, and
the only account that can read them is the operator's; the Worker's secret key writes them.

The API does not check ownership in application code. For each request it builds a Supabase
client that carries the caller's own access token (`createUserClient`), so Postgres evaluates the
row-level security policies as that user. A location in someone else's organization simply reads
as missing, which is why those routes return 404 and not 403.

Two rules follow, and breaking either one is a data leak:

1. **Never construct the admin client on a request path.** `createAdminClient` uses the secret
   key, which bypasses row-level security. It belongs in `scheduled` and `queue` only.
2. **A new table needs policies and explicit grants in the same migration**, and a test in
   `packages/db` that tries to read and write it as a non-member.

**Plans are rows** (`docs/adr/0006-plans-are-rows.md`). `plans` holds what is on sale, and
`GET /api/plans` serves it without a sign-in. An organization's `plan_key` names its plan, or is
null when its limits were set by hand, as for every organization made before plans and any the
operator's limits editor has touched. `apply_plan()` puts an organization on a plan and copies the
plan's values onto it: its limits, its cadence, whether a report is emailed, and its assistants
(a plan with one keeps the one the organization already had, and otherwise starts on ChatGPT).
Only the worker may call it. `create_organization()` uses it to start every new organization on
the free plan; a test account's organization is still set by hand. Where a plan covers fewer
assistants than are offered, the organization's owner picks which through `choose_assistants()`
(`PUT /api/organizations/:organizationId/assistants`), which checks the pick against the plan;
`surfaces` is still not a column a member can write. Nothing charges yet. The
limit columns below are what is enforced.

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

**Plan settings live beside the caps**, protected the same way:

- `scan_every_days` is how many days apart the organization's locations are scanned.
  `locations_due_for_scan` uses it. A location's own `scan_frequency` can pause it or ask for
  weekly, which only ever slows it down. Cadences shorter than a day are not possible while the
  schedule fires once a day.
- `surfaces` is which surfaces its scans check; null means every one that is set up. The runner
  never calls a provider outside the list, so a plan is not charged for an assistant it does
  not include, and the results grid shows the same list.

Each trigger raises its own error code with a message written for the user, which the store
passes through as a `limit` error and the API returns as 409 `limit_reached`. The scheduled scans
are not counted against the manual-scan limit.

Users can insert exactly one kind of scan row: a queued, manual scan in their own name for a
location they can see. Results, scores and recommendations are written only by the worker.
Organizations are created only through `create_organization()`, which makes the caller the owner.

**The operator reads every row, through policies.** `is_operator()` is true for an account with the
`operator` platform role, and each table, including `audits` and `provider_usage`, has a `select`
policy that answers it. Only `select` policies exist, so the operator cannot change another
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
counts a test organization. Reading through a customer's account (`/operator/o/:organizationId/...`)
reuses the Locations and location pages with every control that changes something hidden.

**The operator changes limits through one function.** `PUT /api/operator/organizations/:organizationId/limits`
calls `operator_set_limits()`, a security-definer function that returns a row only while
`is_operator()` is true and the organization exists (the route answers 404 otherwise). It locks the organization,
changes `max_locations`, `max_queries_per_location`, `max_manual_scans_per_month` and
`scan_every_days` and nothing else, and records the old and new values in `operator_actions`. The
route refuses a value outside `OrganizationLimitsSchema` with 422, and the columns' own checks
bound each value whatever calls the function. `operator_actions` has no write grant for any
API role; the operator has a `select` policy on it. The page is `/operator/o/:organizationId/plan`.
See `docs/adr/0005-the-operator-changes-limits-through-one-function.md`.

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
