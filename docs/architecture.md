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
     visibilityScore() + deriveRecommendations()
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

**Gemini** (`apps/api/src/providers/gemini.ts`) calls Google's Interactions API with the
`google_search` tool, and asks for the answer and the businesses it named as JSON. Cited URLs come
from the answer's citation annotations. This is Gemini through the API with search grounding, not
the consumer app: same models and index, different system prompt.

**Cost of one Gemini check: not measured yet.** Google bills each search query the model runs
(one prompt can run several) plus input and output tokens. The provider logs each response's
usage block as `gemini usage ...`; read the real figure from the Worker's logs after the first
live scans and write it here.

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
- `listOwnerEmails` and the report email have unit coverage for the email body only. The lookup
  uses the Supabase Auth admin API and has not been run against a real project.
- Sign-in by emailed link has not been exercised end to end; the API's token verification has.
- On a Supabase project that still signs tokens with a legacy shared secret, `getClaims` asks the
  Auth server on every request. Use asymmetric signing keys.

## Open product questions

These are not engineering tasks, and the code cannot answer them.

1. **Does anything the product recommends move the number?** The recommendation rules are things
   that are checkable, not things shown to work. A tracker that cannot demonstrate improvement
   is a report people cancel.
2. **What is one sample worth?** Assistant answers vary run to run and by location. One call per
   check is an anecdote. Sampling enough to be credible multiplies cost per location.
3. **What does a location cost to serve?** Map pack data is bought per keyword, per location, per
   run. Price the plan from that number, not the other way round.
4. **Who buys?** Single-location owners churn and are expensive to reach. Agencies managing many
   locations are the more plausible first customer, and they will want white-label reports.
5. **The score weights are a guess** (the defaults in `packages/shared/src/tuning.ts`). Nothing ties a rank on
   any surface to calls or visits yet.
