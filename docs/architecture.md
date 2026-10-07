# Architecture

## One Worker, three entry points

`apps/api/src/index.ts` exports a single Worker with three handlers:

- **`fetch`**: the HTTP API, a Hono app mounted at `/api`. Only `/api/*` reaches the Worker.
  Every other path is served from the web app's build output, with unknown paths falling back to
  `index.html` so client-side routes work. That routing lives in `wrangler.jsonc` under `assets`.
- **`scheduled`**: a daily Cron Trigger. It asks Postgres which locations are due
  (`locations_due_for_scan`), creates a `scheduled` scan row for each, and puts the scan IDs on
  the queue.
- **`queue`**: the consumer. For each scan ID it runs the scan and, for scheduled scans, emails
  the organization's owners.

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
     listRecentResults(): the last six successful scans of the same kind
                       |
     windowScore() + deriveRecommendations(), over this scan and those six
                       |
     complete_scan() in Postgres: results, score, last_scanned_at and
     recommendations, in one transaction
```

A provider only fetches. Whether the business was named is decided by `analyzeObservation` in
`packages/shared`, so every surface is judged by the same rules and those rules are tested without
network access.

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
model is a tuning value (`chatgpt.model`). The provider logs each response's usage as
`chatgpt usage ...`, so the average can be read from the Worker's logs once real scans run.

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
  scan does not fail on a safety classifier. The usage log records which model answered.

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
The provider logs each check as `claude usage ...`.

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
- **The newest scan decides which cells exist.** A removed prompt, or a surface no longer
  checked, drops out of the rate at once.
- **The window counts scans, not days.** It works unchanged for a location scanned weekly, daily
  or several times a day. Scan frequency is expected to become a plan setting.
- **Sample scans and real scans never share a window.** Each scan records `sample_data` when the
  worker starts it, and a window holds scans of one kind only.
- **A scan's `visibility_score` is the score over the window that scan closed**, so the history
  of scores is already a rolling figure.

A new location has one scan in its window and reads "named" or "not named" until more arrive.

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

## Tenancy

Every row belongs to an organization, and a user reaches a row only through a membership.

The API does not check ownership in application code. For each request it builds a Supabase
client that carries the caller's own access token (`createUserClient`), so Postgres evaluates the
row-level security policies as that user. A location in someone else's organization simply reads
as missing, which is why those routes return 404 and not 403.

Two rules follow, and breaking either one is a data leak:

1. **Never construct the admin client on a request path.** `createAdminClient` uses the secret
   key, which bypasses row-level security. It belongs in `scheduled` and `queue` only.
2. **A new table needs policies and explicit grants in the same migration**, and a test in
   `packages/db` that tries to read and write it as a non-member.

Users can insert exactly one kind of scan row: a queued, manual scan in their own name for a
location they can see. Results, scores and recommendations are written only by the worker.
Organizations are created only through `create_organization()`, which makes the caller the owner.

## Wire types

`packages/shared/src/schemas.ts` is the single definition of every payload. The API validates
input against it and parses database rows through it; the web client parses every response
through it. Field names stay snake_case from Postgres to React so there is no mapping layer to
drift.

## Limits to design around

- **Each provider call is a subrequest**, and a scan makes (queries x surfaces) of them in one
  invocation. Workers cap subrequests and CPU time per invocation, and the caps differ by plan.
  Check the current numbers before raising the queries allowed per location. If a scan outgrows
  one invocation, queue one message per check instead of one per scan.
- **Queue delivery is at-least-once.** `runScan` is written to be safe to repeat.
- **The cron queues at most 100 locations per run** (one `sendBatch`). They sort oldest-first, so
  none starve, but a daily cron cannot keep up with more than 100 daily locations. Run it more
  often or page through the due list before that matters.

## Known gaps

- A manual scan whose queue send fails leaves a `queued` row with no message behind it. Nothing
  sweeps stale scans.
- The scan-in-progress check on `POST /scans` is a read followed by a write, so two simultaneous
  requests can both pass it.
- On a Supabase project that still signs tokens with a legacy shared secret, `getClaims` asks the
  Auth server on every request. Use asymmetric signing keys.

## Open product questions

These are not engineering tasks, and the code cannot answer them.

1. **Does anything the product recommends move the number?** The recommendation rules are things
   that are checkable, not things shown to work. A tracker that cannot demonstrate improvement
   is a report people cancel.
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
