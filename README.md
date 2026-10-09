# Nearcited

[![CI](https://github.com/jwh3times/Nearcited/actions/workflows/ci.yml/badge.svg)](https://github.com/jwh3times/Nearcited/actions/workflows/ci.yml)

Tracks whether a local business gets named when people ask an AI assistant or search Google for
what it sells, and who gets named instead.

**Status: early.** Two real providers exist: ChatGPT, through OpenAI's API with web search, and
Claude, through Anthropic's. The other five surfaces are not built, and local development runs
on generated sample data. See [What is not built](#what-is-not-built).

## Contents

- [How it works](#how-it-works)
- [Stack](#stack)
- [Layout](#layout)
- [Run it locally](#run-it-locally)
- [Configuration](#configuration)
- [Commands](#commands)
- [API](#api)
- [Data model](#data-model)
- [Tests](#tests)
- [Deploy](#deploy)
- [Repository automation](#repository-automation)
- [Private companion](#private-companion)
- [Working with coding agents](#working-with-coding-agents)
- [What is not built](#what-is-not-built)
- [Contributing and security](#contributing-and-security)
- [License](#license)

## How it works

A user signs in, creates an organization, and adds a **location**: a business at an address. For
each location they list the **queries** to track. A query is either a prompt someone would give
an AI assistant ("best emergency plumber in Asheville") or a keyword they would type into Google.

A **scan** runs every active query on every **surface** that kind of query applies to. The
surfaces are ChatGPT, Gemini, Perplexity, Claude, Google AI Overview, the Google local pack and
Google organic results. For each one, a provider fetches what the surface returned, and shared
code decides whether the business was named, at what position, and who was named instead. The
scan then stores a 0 to 100 visibility score and a list of recommendations.

An assistant can answer the same prompt differently each time, so one answer is a sample and not
a measurement. Results are therefore shown as "named in x of y", counted over a location's last
seven successful scans, and the score and recommendations are worked out over the same window.

An assistant with web search lists the pages it read before answering. Nearcited counts those
sites over the same window: how many answers cited each one, and how many of those answers named
the business. A site that is read often in answers that never name the business becomes a
recommendation, and so does a business website that no answer cites. Each recommendation clears
by itself when a later scan shows the thing it pointed at has changed. The location page and the
shareable audit both show the table.

Each scan also reads the business's own home page the way an assistant's crawler would, without
running scripts: does it load, does `robots.txt` let the assistants' search crawlers in, is it
free of `noindex`, does it have text, does that text state the business name and city, and does
it carry structured business details. Each failed check is a recommendation that clears when a
later scan finds it fixed. The shareable audit shows the whole checklist. The fetch identifies
itself as `NearcitedBot`, with a link to the public `/bot` page, and is skipped while the deployment serves sample data.

The operator has one more screen, `/operator`: what needs attention (a failed scan, a scan stuck or
overdue, a website that cannot be read, a failed audit, a location with no active prompts, an
location that has used every prompt it is allowed), every organization, every account with how far it got (signed up, made an organization, added a location, had a scan succeed, scanned in the last week), every shareable audit, and what the deployment runs. From there the operator
can read through a customer's pages, with everything that changes something hidden, and change the
organization's limits (locations, prompts per location, manual scans a month, days between scans) on
its plan page.

The location page and the audit turn all of that into an action plan, "What to do next": fix
what keeps the website from being read, get listed on the sites the assistants read without
naming the business, keep the listings that did lead to its name accurate, and see who is
recommended instead. Every step is composed by rule from the counts and checks above and says
which; none is written by a model.
How often a location is scanned, and on which assistants, are settings on its organization.

The location page charts the score over time, and each cell of the results grid carries a strip
of dots, one per recent scan, showing how that prompt has moved on that assistant.

The app has a sidebar listing every location and a light or dark theme, kept in the browser. The
locations page is a table of score, change, rate per assistant, top competitor and next step,
built from each location's own endpoints. The location page has tabs (Overview, Prompts, Sources,
Website, Answers, Settings); ticking a step of the action plan is remembered in the browser only.
An Account settings page, linked from the sidebar, renames the organization and shows what its
plan allows, read-only. A new user is walked through four steps, and nothing is created until the
last. The privacy policy (`/privacy`), the terms of service (`/terms`) and a page describing the
crawler (`/bot`) are static pages readable without signing in.

Scans start from the "Run scan" button or from a daily schedule, and run on a queue. A scheduled
scan emails its result to the organization's owners.

### Shareable audits

An **audit** is a one-off report for a business that has not signed up: up to five prompts, each
asked several times (five by default) on every assistant that is set up. The page shows a score,
how often the business was named, who was named instead, and the sources the assistants cited. It
is read at `/audit/<token>`, with no sign-in; holding the link is the permission. A link stops
working 30 days after it is made, or when it is revoked.

Only the owner of the deployment can make one, from the command line (see
[Commands](#commands)). There is deliberately no endpoint, public or signed-in, that creates an
audit. It costs real money, prompts x samples x assistants answers, and refuses to run on sample
data or on the default tuning.

[docs/architecture.md](docs/architecture.md) covers the scan flow, how an audit runs, the tenancy model, the limits a
Worker imposes, and the known gaps.

## Stack

| Layer | Choice |
| --- | --- |
| Web | React 19, Vite, TypeScript, React Router, TanStack Query |
| API and jobs | One Cloudflare Worker: Hono for HTTP, a Cron Trigger to schedule scans, a Queue to run them |
| Assistants | OpenAI's Responses API and Anthropic's Messages API (through its SDK), both with web search |
| Data and auth | Supabase (Postgres with row-level security, email sign-in) |
| Email | Resend |
| Tooling | pnpm workspaces, Biome, Vitest |

## Layout

```
apps/
  api/          The Worker. src/index.ts exports fetch, scheduled and queue.
  web/          The React app. Its build output is served by the Worker as static assets.
  e2e/          Playwright tests that drive the app and Worker in a browser, in mock mode.
packages/
  shared/       Zod schemas for every wire type, plus the logic that decides whether a business
                was named, the visibility score, the rule-based recommendations, the audit,
                cited-source and on-page check logic, the action plan, and the checks on what a form accepts
                (phone, website, postal code, country).
  db/           Tests that run the migrations in in-process Postgres and attack the policies.
supabase/
  migrations/   Schema, row-level security, and the SQL functions the Worker calls.
scripts/        integration-db.sh prepares a plain Postgres for the store integration test.
                create-audit.mjs creates and revokes shareable audits.
                bootstrap-private.mjs and sync-main.mjs manage the private companion checkout.
                prepare-tuning.mjs writes the tuning file the Worker bundles.
                local-env.mjs writes the two local env files from `supabase status`.
private/        The private companion, when checked out. Ignored here; its own repository.
docs/           architecture.md: how a scan flows, the tenancy model, and known gaps.
                adr/: decisions that are hard to reverse, and why they were made.
                agents/: where the agent skills find the issue tracker, labels and domain docs.
.agents/skills/ Agent skills, as installed. Codex reads these.
.claude/skills/ The same skills, generated for Claude Code. Do not edit.
.claude/agents/ Specialist agents. .codex/agents/ is the generated copy for Codex.
.github/        CI and deploy workflows, Dependabot config, pull request template.
AGENTS.md       The rules a change has to follow. CLAUDE.md imports it.
```

## Run it locally

Needs Node 26, pnpm 10, and Docker (for the local Supabase stack).

```sh
pnpm install

# 1. Start Supabase. This applies supabase/migrations and prints the URL and keys.
pnpm dlx supabase start

# 2. Write both apps' env files from the example files and the keys `supabase status` reports.
pnpm local:env

# 3. Build the web app once. The Worker's config points at apps/web/dist.
pnpm build

# 4. Run the Worker (port 8787) and Vite (port 5173) together.
pnpm dev
```

Open http://localhost:5173 and sign in with any email address. Locally the sign-in link is not
sent anywhere; read it in the mail catcher at http://127.0.0.1:54324.

With `PROVIDER_MODE=mock` (or in a test organization), "Run scan" returns generated results within about ten seconds and the
app shows a banner saying so. To fire the daily schedule by hand:

```sh
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

## Configuration

The Worker reads its settings from `vars` in `apps/api/wrangler.jsonc`. Locally,
`apps/api/.dev.vars` overrides them; in production, secrets are set with `wrangler secret put`.

| Name | Secret | What it is |
| --- | --- | --- |
| `SUPABASE_URL` | no | The Supabase project URL. |
| `SUPABASE_PUBLISHABLE_KEY` | no | Used with the caller's own token, so row-level security applies. |
| `SUPABASE_SECRET_KEY` | yes | Bypasses row-level security. Only the scheduler and the scan worker use it. |
| `PROVIDER_MODE` | no | Exactly `mock` serves generated data. Any other value is live. |
| `APP_URL` | no | Where the web app is served. |
| `COMMIT` | no | Optional. The commit a deployment was built from, shown in the operator's view. The deploy workflow sets it. |
| `EMAIL_FROM` | no | The sender of scan reports. |
| `EMAIL_REPLY_TO` | no | Optional. Where a reply to a scan report goes. Without it, replies go to `EMAIL_FROM`. |
| `OPENAI_API_KEY` | yes | Optional. In live mode, scans check ChatGPT when it is set and skip that surface when it is not. |
| `ANTHROPIC_API_KEY` | yes | Optional. The same, for Claude. |
| `RESEND_API_KEY` | yes | Optional. Without it, scheduled scans finish without sending a report. |

The web app reads two values at build time, from `apps/web/.env.local` or the environment. Both
are safe to ship to the browser.

| Name | What it is |
| --- | --- |
| `VITE_SUPABASE_URL` | The same project URL. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | The same publishable key. |

Neither file is committed. `apps/api/.dev.vars.example` and `apps/web/.env.example` are the
templates.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Worker and web app with reload |
| `pnpm check` | Lint, typecheck, test and build. Run before pushing. |
| `pnpm lint` / `pnpm format` | Biome check / fix |
| `pnpm typecheck` | `tsc` in every package |
| `pnpm test` | Every unit test, including the row-level security tests |
| `pnpm build` | Build the web app |
| `pnpm e2e` | End-to-end tests in a browser (needs `supabase start` and the env files; `pnpm check` does not run them) |
| `pnpm smoke` | Smoke test against a deployment (`E2E_APP_URL`, `E2E_SUPABASE_URL`, `E2E_SUPABASE_PUBLISHABLE_KEY`, `TEST_ACCOUNT_EMAIL`, `TEST_ACCOUNT_PASSWORD`) |
| `pnpm test-account:create` | Make the deployment's test account and grant it the `test` platform role; safe to run again (needs `SUPABASE_SECRET_KEY`, `TEST_ACCOUNT_EMAIL`, `TEST_ACCOUNT_PASSWORD`) |
| `pnpm local:env` | Write `apps/api/.dev.vars` and `apps/web/.env.local` from the examples and `supabase status` (`--force` replaces existing files) |
| `pnpm cf:deploy` | Build, then `wrangler deploy` |
| `pnpm db:types` | Generate TypeScript types from the local Supabase database |
| `pnpm --filter @nearcited/api test` | One package's tests (`api`, `web`, `shared` or `db`) |
| `npm run bootstrap:private` | Clone the private companion into `private/` (maintainers) |
| `npm run sync:main` | Fast-forward `main` here and in `private/` |
| `npm run audit:create -- --name ... --city ... --prompt ...` | Create a shareable audit and queue it (owner only; see below) |
| `npm run audit:revoke -- <link or token>` | Make an audit's link stop working |
| `pnpm test:scripts` | Tests for the scripts in `scripts/` |
| `pnpm sync:agents` | Regenerate `.claude/skills` and `.codex/agents` from their sources |
| `pnpm sync:agents:check` | Fail if a generated copy is stale |

`audit:create` takes `--name` and `--city` (required), `--region`, `--country` (default `US`),
`--website`, `--samples` (1 to 5, default 5) and `--prompt` once for each of 1 to 5 prompts. It
prints the link. It needs `SUPABASE_SECRET_KEY`, `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in the environment, and reads the Supabase URL, the app URL and the queue
name from `apps/api/wrangler.jsonc`. Keep the values out of files in this repository; for
example, run it under `op run` with an env file of 1Password references. The operator can make the
same audit from the Audits section of the operator page, with no keys to hand.

## API

Every route is under `/api`. All except `/api/health` and `/api/audits/:token` need a Supabase
access token in the `Authorization: Bearer` header. Requests run in Postgres as that user, so a row in someone else's
organization reads as missing and returns 404. Payloads are defined in
`packages/shared/src/schemas.ts`.

| Method and path | What it does |
| --- | --- |
| `GET /api/health` | Liveness check. No sign-in needed. |
| `GET /api/audits/:token` | A shareable audit, for anyone holding its token. 404 if the token is unknown, revoked or past its 30 days. Never cached and not indexed. |
| `GET /api/plans` | The price list: every plan on sale, cheapest first, with its prices in US cents and its limits. Needs no sign-in. A signed-in member also gets the plan their organization is on if it has been taken off sale. |
| `GET /api/me` | The signed-in user, their platform role (`operator`, `test` or none) and their organizations. |
| `GET /api/operator/overview` | The operator's view: totals, what needs attention, every organization (test ones apart) and what the deployment runs. 404 to anyone who is not the operator. |
| `GET /api/operator/spend` | What the providers were paid in this calendar month (UTC) and the two before: a total, each organization, audits, and deleted organizations, in US dollars, with any model that has no rate named and left out. 404 to anyone who is not the operator. |
| `GET /api/operator/accounts` | A funnel of how far accounts got, and every account with its stage; test accounts are listed and not counted. 404 to anyone who is not the operator. |
| `GET /api/operator/audits` | Every shareable audit, with its link only while it is neither revoked nor expired. 404 to anyone who is not the operator. |
| `POST /api/operator/audits` | Makes a shareable audit and queues one message per prompt. Takes `business_name`, `city`, `prompts` (1 to 5) and optionally `website`, `region`, `country_code`, `samples` (1 to 5). 404 to anyone who is not the operator, 409 where scans return sample data, 422 for a bad value. |
| `GET /api/operator/organizations/:organizationId` | One organization, for the operator to read through its pages. 404 to anyone who is not the operator. |
| `PUT /api/operator/organizations/:organizationId/limits` | Sets an organization's four limits (locations, prompts per location, manual scans a month, days between scans) and records the change. 404 to anyone who is not the operator, 422 for a value out of range. |
| `POST /api/organizations` | Create an organization; the caller becomes its owner. The name needs a letter. 409 when the account already has one. |
| `PATCH /api/organizations/:organizationId` | Rename an organization. Owners and admins only; anyone else reads it as missing and gets 404. The name needs a letter. |
| `PUT /api/organizations/:organizationId/assistants` | Sets which assistants the organization is checked on, from ChatGPT and Claude, as many as its plan covers. Owner only: 404 to anyone else. 409 with the reason when the choice is not one the plan allows. |
| `GET /api/organizations/:organizationId/locations` | List an organization's locations. |
| `POST /api/organizations/:organizationId/locations` | Add a location. The phone is stored as E.164 in the location's country, the website with `https://`, and the postal code, country, place ID, name and city are checked; a bad value answers 422. |
| `GET /api/locations/:id` | One location with its queries, latest scan, rates over recent scans, the sites those answers cited, the surfaces being checked, recommendations, the latest website check and the action plan. |
| `PATCH /api/locations/:id` | Replace a location's details with a whole location body, as when adding one; a field left out goes back to blank or its default. The same checks as adding. |
| `POST /api/locations/:id/activate` | Brings a location the plan paused back into use. Takes `instead_of`, the location in use that is paused in its place, when the plan has no room; 409 with the reason without one. 404 to a non-member. |
| `DELETE /api/locations/:id` | Delete a location and its history. |
| `POST /api/locations/:id/queries` | Add a prompt or keyword to track; the text needs letters (three for a prompt). Adding one that was retired restores it. |
| `PATCH /api/queries/:id` | Retire a tracked query, or restore it. Its results are kept. |
| `PATCH /api/recommendations/:id` | Mark a recommendation open, done or dismissed. |
| `GET /api/locations/:id/scans` | The last 30 scans for a location. |
| `POST /api/locations/:id/scans` | Queue a manual scan. 409 if one is already under way, which the database enforces. |
| `GET /api/scans/:id` | One scan with its results. |

## Data model

The migrations in `supabase/migrations/` define everything.

| Table | Holds |
| --- | --- |
| `organizations` | The tenant. Every other row belongs to one. Holds its usage limits (locations, active prompts per location, manual scans a calendar month) and its plan settings (which plan it is on, whether a report is emailed, how many days apart it is scanned, and on which surfaces). |
| `platform_roles` | What an account is to the product as a whole (`operator` or `test`). A user reads only their own row, the operator reads all; rows are written with the secret key. An organization made by a `test` account is flagged `is_test` and scans on generated data. |
| `memberships` | Which users belong to an organization, as `owner`, `admin` or `member`. |
| `locations` | A business at an address. Its `scan_frequency` can pause it (`off`) or ask for less than the organization's cadence (`weekly`), never more. |
| `tracked_queries` | The prompts and keywords checked for a location. A retired one is kept, with its results, but not scanned. |
| `scans` | One run for a location: its trigger, status, whether it ran on sample data, the score over the window it closed, and the check of the location's website it made. |
| `scan_results` | One row per query and surface: named or not, position, and who else was named. |
| `recommendations` | What a scan suggested, and whether the user has dealt with it. |
| `audits` | A shareable audit: the business, its prompts, the results as each prompt finishes, and its token, expiry and revocation. Belongs to no organization; only the operator can read it through the API. |
| `operator_actions` | What the operator changed or made, one row per action, with who and what: an organization's limits before and after, or the audit made. Written only by the function that does it; only the operator can read it through the API. |
| `plans` | What is on sale: a monthly price for the locations a plan includes, a price for each extra location, and its limits. Read by everyone; written by no API role. An organization's `plan_key` names its plan, or is null when its limits were set by hand. |
| `provider_usage` | What the providers used for a scan or audit prompt, per surface and model: calls, input, cached input and output tokens, searches. Outlives the scan, audit or organization it describes. Written only by the Worker; only the operator can read it through the API. Not priced or shown anywhere yet. |

Usage limits are enforced by database triggers, so they hold for the API and for anyone calling
the database directly. Going over one returns 409 `limit_reached` with a message that names the
limit and its value.

Row-level security policies on every table are the authorization layer. Signed-in users can
insert one kind of scan row, a queued manual scan for a location they can see; results, scores
and recommendations are written only by the worker, through `complete_scan()`.

`audits` is the exception to "every row belongs to an organization". Its table is closed to
signed-in and anonymous users alike, except that the operator can read it; the Worker and the owner's script use the secret key, and a
reader gets one audit only by its token, through the `get_audit()` function.

## Tests

- **`packages/shared`**: name matching, mention detection, scoring, recommendation rules, input
  validation, the tuning schema, its defaults and prompt rendering, audits, cited sources, the
  on-page check and the action plan.
- **`packages/db`**: applies the real migrations to in-process Postgres (PGlite) and checks, as
  different users, that one organization cannot read or write another's rows, that users cannot
  forge scan results or grant themselves a platform role, that worker-only functions and the `audits` and `provider_usage` tables are closed to them, and that the operator reads every organization and changes only an organization's limits, through one function that records it. No Docker needed. It
  also checks `private/tuning.json` against the tuning schema where that file exists.
- **`apps/api`**: every route against an in-memory store, the scan runner (success, retry,
  permanent failure, reporting, scoring with given weights, refusing live scans on default tuning),
  the ChatGPT and Claude providers against responses in the shape the real APIs return, the
  scheduler, the audit runner, the site fetch (what it refuses and how it follows redirects), and
  the mock providers.
- **`apps/web`**: the logic that lays results out as a grid, the logic behind the chart of the
  score over time, the logic behind the audit page, the logic that fills the location edit form,
  the locations table's summary figures, the onboarding suggestions, and the location page's tabs.
- **`apps/e2e`**: `pnpm e2e` drives the real web app and Worker in Chromium against the local
  Supabase stack, in mock mode: sign-in by the emailed link, onboarding through the first scan, the
  location page, account settings, the operator's view and reading through an account, the public pages and one phone-sized run. It starts the Worker
  and web app itself, or reuses them if `pnpm dev` is up. `pnpm smoke` is a separate run against a
  real deployment: it signs in as the test account, refuses to go on unless that account's
  organization is a test one, then adds a location and a prompt, runs a scan (generated data), reads
  the results and deletes the location.
- **`scripts`**: `pnpm test:scripts` runs the tests for the private-companion, tuning,
  local-env, audit-creation, test-account and branch-sync scripts.

### Integration tests

`apps/api/test/supabase-store.integration.test.ts` runs the real Supabase store against Postgres
and PostgREST, which is what a Supabase project is underneath. It is skipped unless
`POSTGREST_URL` is set. CI runs it; to run it yourself, start Postgres and PostgREST, then:

```sh
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres scripts/integration-db.sh
POSTGREST_URL=http://127.0.0.1:3000 POSTGREST_JWT_SECRET=<the secret PostgREST was started with> \
  pnpm --filter @nearcited/api exec vitest run test/supabase-store.integration.test.ts
```

PostgREST must connect as `authenticator` (password `postgres`) with `anon` as its anonymous role.
The `integration` job in `.github/workflows/ci.yml` is a working example.

## Deploy

1. Create a Supabase project and apply the migrations: `pnpm dlx supabase link`, then
   `pnpm dlx supabase db push`. Both need a Supabase access token (`SUPABASE_ACCESS_TOKEN`) and
   the project's database password (`SUPABASE_DB_PASSWORD`). Under Authentication, URL
   Configuration, set the site URL to your deployed URL and add `<that URL>/**` to the redirect
   URLs, or the emailed sign-in link will not return to the app.
2. Create the queues:
   ```sh
   cd apps/api
   pnpm exec wrangler queues create nearcited-scans
   pnpm exec wrangler queues create nearcited-scans-dlq
   ```
3. In `apps/api/wrangler.jsonc`, set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `APP_URL` and
   `EMAIL_FROM`. To serve it on your own domain, set `routes` to that domain with
   `custom_domain`; the domain's DNS has to be on the same Cloudflare account. `EMAIL_FROM`
   has to be an address on a domain verified with Resend.
4. Deploy. From the repo root, with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` set in
   the environment: `pnpm cf:deploy`. The Cloudflare API token needs permission to edit Workers
   and Queues.
5. Set the secrets on the Worker the deploy created, from `apps/api`:
   ```sh
   pnpm exec wrangler secret put SUPABASE_SECRET_KEY
   pnpm exec wrangler secret put RESEND_API_KEY   # optional: scheduled-scan reports
   pnpm exec wrangler secret put OPENAI_API_KEY   # optional: live ChatGPT checks
   pnpm exec wrangler secret put ANTHROPIC_API_KEY   # optional: live Claude checks
   ```
   Until `SUPABASE_SECRET_KEY` is set, the app serves and sign-in works, but no scan can run.

`.github/workflows/deploy.yml` does step 4 on demand. It reads its credentials from the 1Password
`Nearcited` vault at run time, so GitHub holds one secret, `OP_SERVICE_ACCOUNT_TOKEN`, for a
service account that can read only that vault. The vault items it expects are named at the top
of that file.

The same workflow can smoke-test what it deployed. To set that up: add a 1Password item `Smoke test`
to the vault with the test account's `username` (an email) and `password`; run
`pnpm test-account:create` with `SUPABASE_SECRET_KEY`, `TEST_ACCOUNT_EMAIL` and
`TEST_ACCOUNT_PASSWORD` in the environment; then set the repository variable `SMOKE_TEST` to `on`.

`PROVIDER_MODE` in `apps/api/wrangler.jsonc` is `live`, so the deployed Worker runs real checks.
Exactly `mock` serves generated data instead, which is what `.dev.vars.example` sets for local
development. Any other value means live. A live build needs the private
tuning file, so the deploy has to run where `private/` is checked out, which the workflow does.
Without the file, live scans fail with a message saying so. With it, a live scan checks each
surface whose key is set (ChatGPT with `OPENAI_API_KEY`, Claude with `ANTHROPIC_API_KEY`) and skips the rest; with
no key set at all, scans fail with "No data provider is configured".

## Repository automation

- **CI** (`.github/workflows/ci.yml`) runs on every pull request and on `main`. Its four jobs are
  the required checks: `Lint, typecheck, test, build`, `Store against Postgres and PostgREST`,
  `Verify generated agent config`, and `End-to-end in a browser`, which runs `pnpm e2e` against a
  local Supabase stack.
- **`main` is protected by a ruleset.** Changes arrive by pull request with the required checks
  passing on an up-to-date branch and review threads resolved. Force pushes and deleting the
  branch are blocked. CodeQL alerts block the merge, and Copilot reviews each push.
- **Dependabot** (`.github/dependabot.yml`) checks npm and GitHub Actions versions every day at
  05:00 US Eastern. Minor and patch updates arrive as one pull request per ecosystem; majors
  arrive separately. Dependabot alerts and security updates are on.
- **Secret scanning with push protection** and **private vulnerability reporting** are on. See
  [SECURITY.md](SECURITY.md) for how to report a problem.
- **Deploy** (`.github/workflows/deploy.yml`) is manual. When the repository variable `SMOKE_TEST`
  is `on`, a second job, `Smoke test the deployment`, runs `pnpm smoke` against the result.

## Private companion

Some of the product is kept out of this repository: provider prompts, sampling and scoring
values, pricing, and anything about a real customer. It lives in a separate private repository
that maintainers check out at `private/`, which this repository ignores.

Nothing here needs it. A public clone installs, passes `pnpm check` and runs on sample data
without it.

The one thing the build takes from it is `private/tuning.json`: prompt wording and score weights,
as data. All the code that uses those values is here, with placeholder defaults in
`packages/shared/src/tuning.ts`. Wrangler runs `scripts/prepare-tuning.mjs` before every dev
session and deploy, which bundles the private file when it is present and the defaults when it is
not. Live scans refuse to run on the defaults, so a build without the private file cannot store
placeholder results as measurements. The reasoning is in
[docs/adr/0001-private-tuning-as-data.md](docs/adr/0001-private-tuning-as-data.md).

Maintainers with access restore it with one command, which reads the repository's location from
1Password (the `op` CLI, signed in) and clones it with the GitHub CLI:

```sh
npm run bootstrap:private
npm run sync:main        # fast-forward main in both checkouts; refuses a dirty tree
```

`npm run bootstrap:private -- --url <owner/name or GitHub URL>` skips 1Password.

## Working with coding agents

The repository is set up for Claude Code and Codex.

- [`AGENTS.md`](AGENTS.md) holds the rules a change has to follow. Codex reads it directly, and
  [`CLAUDE.md`](CLAUDE.md) imports it for Claude Code.
- The agent skills are from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT; see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)) and are pinned in `skills-lock.json`. Among
  them: `/triage`, `/to-spec`, `/to-tickets`, `/implement`, `/tdd`, `/diagnosing-bugs`,
  `/code-review`, `/grill-me` and `/improve-codebase-architecture`. `/ask-matt` picks one for you.
- Four more skills are written for this repository: `/ship` checks a branch against the rules in
  `AGENTS.md`, refreshes the docs and opens the pull request; `/end-session` records what a
  session learned and cleans up; `/handoff` and `/lets-go` pass a session between machines.
- `.agents/skills/` is the installed source. `.claude/skills/` is generated from it by
  `pnpm sync:agents`, and CI fails if the two differ.
- `docs-updater` (`.claude/agents/docs-updater.md`, generated for Codex in `.codex/agents/`) keeps
  these documents true to the code. `/ship` and `/end-session` both run it.
- `docs/agents/` tells the skills where issues live (GitHub Issues and a project board), which
  triage labels to use, and where the glossary and decision records go.

To add or update a skill:

```sh
npx skills add mattpocock/skills -a codex -s <name> --copy -y   # or: npx skills update -p -y
pnpm sync:agents
```

## What is not built

- **Most real data providers.** ChatGPT and Claude are implemented (`chatgpt.ts` and
  `claude.ts` in `apps/api/src/providers/`). Perplexity, Gemini and the three Google surfaces
  are not;
  `apps/api/src/providers/live.ts` has notes on what each needs.
- **Billing.** Each organization has limits, a scan cadence and a list of surfaces, but nothing
  sets them by plan or takes payment. They are changed by hand in the database, and the Account
  settings page shows them without editing them.
- **Inviting teammates.** The schema and policies support members and roles; there is no API or
  screen for it.
- **Switching organizations.** A user in several organizations always sees the first.

More detail, and the open product questions, in [docs/architecture.md](docs/architecture.md).
What is planned, in order, is in [Build order](https://github.com/jwh3times/Nearcited/issues/15).

## Contributing and security

Issues are welcome; outside pull requests are not being accepted yet. See
[CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately, as described in
[SECURITY.md](SECURITY.md).

## License

Copyright (C) 2026 Jerry Holland.

Nearcited is free software: you may use, modify and share it under the terms of the
[GNU Affero General Public License, version 3](LICENSE). If you let other people use a modified
version over a network, that license requires you to offer them its source. It comes with no
warranty.
