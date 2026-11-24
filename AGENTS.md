# Nearcited

The engineering contract for every coding agent in this repository. `CLAUDE.md` imports this file;
Codex reads it directly. Project rules live here and in the area files its Rules section points
to, and nowhere else.

Local-visibility tracker: two Cloudflare Workers, the main one (Hono API, cron, queue consumer)
with the React app it serves as static assets and the Pages Worker (`apps/pages`) that serves
hosted pages on businesses' answer subdomains, and Supabase for Postgres and auth. Read
`docs/architecture.md` before changing how scans run or how data is accessed.

## Commands

- `pnpm check`: lint, typecheck, test, build. Must pass before a change is done.
- `pnpm format`: apply Biome fixes.
- `pnpm --filter @nearcited/<api|web|shared|pages|db> test`: one package's tests.
- `pnpm dev`: Worker on 8787, Vite on 5173.
- `pnpm e2e`: browser tests; needs `pnpm exec supabase start` and the env files. `pnpm check`
  skips them.
- `pnpm smoke`: the smoke test against a deployment; needs `E2E_*` and `TEST_ACCOUNT_*` set.
- `pnpm billing:check`: ask Stripe and the deployment whether billing is set up as the app
  expects. Reads only; needs `STRIPE_SECRET_KEY` and `SUPABASE_SECRET_KEY` in the environment.
- `pnpm test-account:create`: make the deployment's test account (needs the Supabase secret key).
- `pnpm local:env`: write `apps/api/.dev.vars`, `apps/web/.env.local` and `apps/pages/.dev.vars`
  from `supabase status`.
- `npm run bootstrap:private`: clone the private companion into `private/` (maintainers only).
- `npm run sync:main`: fast-forward `main` here and in `private/`. Refuses a dirty tree.
- `pnpm sync:agents`: regenerate `.claude/skills` from `.agents/skills` (and `.codex/agents` from
  any `.claude/agents`), and the shared blocks in this file, after installing or changing a skill.
- `pnpm lint:agents`: check that the agent and skill sources read correctly from their generated
  copies.
- `pnpm changelog:check`: check the branch's `changelog.d/` fragment, and that it changed no
  `CHANGELOG.md` section (`Version` stamps them after the merge).
- `pnpm migrations:check`: fail if the branch changes a migration already on `main`.

## Development flow

<!-- shared:development-flow -->

The flow skills are this repository's binding process for changing code. Read
`.agents/skills/open-pr/settings/dev-flow.md` (the routing, exemptions and issue linking) and
`docs/agents/dev-flow.md` (what this repository adds) before the first edit of a change, and whenever
no ready issue exists. `/ask-matt` maps the flow itself.

- **The gate.** Every code edit starts from a ready issue: an open `ready-for-agent` issue whose body
  is a `/to-spec` spec or a `/to-tickets` ticket or that carries a `/triage` brief, or a `bug` issue
  worked through `/diagnosing-bugs`, which needs the number and no spec. With none, stop before the
  first edit and route the user. Reading code, running tests and answering questions need no issue.
- **Private work.** A ready issue in the private tracker counts. Its number stays out of the branch,
  the PR, commits and public issues, and it is closed by hand after the merge.
- **The human starts every phase.** `/wayfinder`, `/grill-with-docs`, `/to-spec`, `/to-tickets`,
  `/implement` and `/triage` stay user-invoked. At a phase boundary, name the next command, say in
  one line why, and wait. Inside a phase, use `/tdd`, `/code-review`, `/diagnosing-bugs`,
  `/domain-modeling`, `/codebase-design`, `/prototype` and `/research` whenever they fit.
- **Exempt from the gate:** dependency bumps, changes touching only docs and agent config, release
  prep, and an explicit user waiver recorded in the PR body as `Flow waived by the user: <reason>`.
- **Linking.** Branches are `<type>/<issue#>-<slug>`; the PR body opens with `Closes #N` or
  `Part of #N`.
- **The flow ends at `/open-pr`.** `/implement` stops at a commit; `/open-pr` refreshes the docs,
  writes the changelog and the PR body, and opens the PR (Claude Code's built-in `/ship` is a
  different command, outside this flow). When the user says to merge it, `/land` merges it
  and confirms its release. `/dependabot` reviews the open Dependabot PRs and hands the ones the
  user names to `/land`; nothing merges a Dependabot PR on its own. `/ask-matt` also routes to
  `/pr`, `/retro` and `/implement-spec`, which are not installed here.
- **Tests are proven, reds are read.** Before `/implement` commits a change that adds or changes
  tests, and in `/code-review`, run `/test-prover`: in a scratch worktree it reverts the fix and
  breaks its guards, and every new test must go red. `/open-pr` runs it too. `/land` and
  `/dependabot` read a red check with `/ci-triage`, which never re-runs anything.
  `/records-audit` checks the board, the trackers, the follow-up wiki and the changelog against
  each other; run it weekly, and `/what-next` says when it is due.
- **`/handoff` is the shared skill.** It parks the session for another machine or harness, closes it
  out with `/end-session`, and `/lets-go` resumes it. It does not write the portable file `/ask-matt`
  describes, so a `/prototype` detour stays in the session or uses a branch.
- **A wizard is not the record.** A step only a human can take follows the `## Procedure` in
  `.agents/skills/open-pr/settings/human-follow-up.md`, whose instructions stand without the script.
- **Research goes where it is safe to keep.** `/research` findings that would expose private material
  go to the private companion, where there is one, never to an ignored folder with no repository
  behind it. Details of an unpublished vulnerability are a draft advisory, never a research file.

<!-- /shared:development-flow -->

## Private companion

`private/` is gitignored here and is a separate, confidential repository for authorized
maintainers. A public clone does not have it, and everything in this repository must install,
pass `pnpm check` and run in mock mode without it.

- **What lives there:** provider prompt text, sampling and score weights; pricing, vendor quotes
  and what anything the product does was measured to cost; anything naming a real customer or
  prospect; security review findings; deployment runbooks. `private/README.md` is its index and
  says what each file owns. Read it before working there.
- **A provider's published rate is public; what was measured is not.** A document here may quote
  what a vendor charges for a model or a search. It never says what a check, a draft or any other
  piece of work was measured to use or to cost, or how models and settings compared on cost, and
  a recorded response in a test carries made-up usage numbers, not the call's own.
- **Nothing from `private/` is copied into this repository**, including into issues, pull
  requests, commit messages and docs. A public document may say a private one exists.
- **This repository never names the private one.** Its locator lives in 1Password and
  `scripts/bootstrap-private.mjs` reads it at run time. Keep it out of every tracked file.
- **Commit and push the two repositories independently.**
- If `private/` is absent and the task needs it (writing a provider's prompts, pricing a plan),
  stop and ask the user to run `npm run bootstrap:private`.
- **The only thing the build takes from it is `private/tuning.json`**, a data file of prompt
  wording and score weights (`docs/adr/0001-private-tuning-as-data.md`). All code stays here.
  No source file imports from `private/`.

## Rules

The rules below hold for every change. Each area's own rules are in a file of their own, listed
under [Area rules](#area-rules), and bind the same way: read an area's file before changing
anything in it.

- **Row-level security is the authorization layer.** Request handlers use the store from
  `c.get("store")`, which acts as the signed-in user. Never call `createAdminClient` on a request
  path; it bypasses the policies. The one exception is the payment provider's webhook, on the
  terms in `docs/adr/0007-the-payment-webhook-acts-as-the-worker.md`: do not add a second.
- **The operator can read every row** (`docs/adr/0004-the-operator-reads-through-policies.md`), so
  a query must filter by what it means, never by what the caller happens to see. "This user's
  organizations" is `my_organizations()`, not `select` from `organizations`. The operator gets
  `select` policies only: do not add one that writes. What the operator changes goes through a
  function that answers only the operator, changes only what it names and records the change in
  `operator_actions` (`docs/adr/0005-the-operator-changes-limits-through-one-function.md`).
- **New table: policies, explicit grants and a non-member test in `packages/db`, in the same
  change.** Supabase grants everything in `public` to every API role by default, so a table
  without a `revoke` is open.
- **Migrations are append-only.** Add a new file in `supabase/migrations`; do not edit one that
  has been applied anywhere. CI fails a pull request that edits, renames or deletes one already on
  `main` (`pnpm migrations:check`).
- **A migration leaves the running Worker working.** Every merge to `main` is released: its
  migrations are applied, then its Workers deployed (README "Deploy"). So the Worker from before
  it must still work against the database after it. Add a new column first and drop the old one
  later, once no deployed code reads it. Dropping something code has just stopped using takes two
  merges: the code first, the migration in a later pull request, which says so.
- **`packages/shared/src/schemas.ts` defines every wire type.** Change the schema first, then the
  API and the client. Field names stay snake_case end to end.
- **All database access goes through the `Store` interface** (`apps/api/src/store/types.ts`). A
  new method needs the Supabase implementation, the in-memory one in `apps/api/test`, and a line in
  the integration test. The Pages Worker's two calls, to `hosted_page()` and
  `record_page_fetch()`, are the only access outside it.
- **A list that reaches across organizations is read a page at a time.** The database's API
  answers a request with at most 1,000 rows and says nothing when it leaves the rest out, so a
  list read in one request is right until it is long and then short without an error. In the
  Supabase store such a read goes through `every` (`readEvery`, `apps/api/src/store/paging.ts`),
  asked for in an order no two rows share, and oldest first where the rows have a time they were
  made, so a row made meanwhile lands past the end. A list that belongs to one organization
  or one location is bounded by its plan and needs none, except a location's visits, which no plan
  bounds: they are read added up, by `location_visits()`, and never row by row. A work list the
  schedule reads again at its next run, and takes only the first of, may stay as it is.
- **Providers only fetch.** They return an `Observation`; `analyzeObservation` in the shared
  package decides what it means. Do not put matching logic in a provider. That holds for a Google
  check (`apps/api/src/providers/dataforseo.ts`) as for an assistant's.
- **Tuning is data, and its real values are private.** A new prompt, weight or sampling value
  starts as a field and a placeholder default in `TuningSchema` (`packages/shared/src/tuning.ts`);
  the real value goes in `private/tuning.json`. Code takes the tuning as an argument. Only the
  Worker entry point imports `apps/api/src/tuning.ts`, and the web app imports nothing from the
  tuning module but types, because its bundle is public.
- **Mock data must never pass as real.** `PROVIDER_MODE` is mock only when it is exactly `"mock"`,
  and the UI shows a banner while it is. Keep both. For the same reason live scans refuse to run on
  the default tuning (`liveScansUnavailable`); keep that too. A test organization's scans are
  generated in any deployment (`docs/adr/0003-platform-roles-and-test-accounts.md`): they are
  recorded as `sample_data` and shown under the same banner, so code that asks "is this sample
  data?" asks about the organization as well as the deployment.
- **Platform roles are set only with the secret key.** `platform_roles` and
  `organizations.is_test` have no write path from a request. Do not add one.
- **The code is AGPL-3.0-only and the repo is public.** A new dependency must be under a license
  that can be combined with it; MIT, ISC, BSD, Apache-2.0 and MPL-2.0 are fine, anything else
  needs checking first. Outside pull requests are not merged (see `CONTRIBUTING.md`).
- No secrets in the repo. Local values go in `apps/api/.dev.vars` and `apps/web/.env.local`, both
  gitignored.

### Area rules

- Before touching billing, `subscriptions` or the payment webhook, a price, a plan's limits or
  allowances, or stronger models and tiers (`stronger_surfaces`, `cellKey`), read
  `docs/agents/billing.md`.
- Before touching members or invitations, or closing or exporting an account (`memberships`,
  `invitations`, `closings`, `export_organization()`, `apps/api/src/closing.ts`), read
  `docs/agents/accounts.md`.
- Before touching connections or what the worker reads through them (`connection_secrets`,
  `apps/api/src/connections/`, a business's Cloudflare zone, Google Analytics), read
  `docs/agents/connections.md`.
- Before touching actions, standing permission or drafts (`apps/api/src/actions/`, `drafts`,
  `apps/api/src/drafts/`), read `docs/agents/actions-and-drafts.md`.
- Before touching alerts, Google results or a location's point, or NearcitedBot and the cited-page
  check (`alerts`, `google_results`, `apps/api/src/site/fetch.ts`, `robots.txt` handling), read
  `docs/agents/scan-results.md`.
- Before touching the line on a business's site, hosted pages, the list of fetchers or the
  structured details (`visits`, `apps/web/public/line.js`, `apps/pages`, `hosted_page()`,
  `PAGE_FETCHERS`, `packages/shared/src/structured-details.ts`), read
  `docs/agents/sites-and-pages.md`.
- Before touching receipts, customer contacts, review requests, opt-outs or found answers
  (`customer_contacts`, the Worker's `email` handler, `/api/opt-out`, `/api/resend/webhook`, `/r`,
  `found_answers`), read `docs/agents/review-requests.md`.

## MCP servers

`.mcp.json` (Claude Code) and `.codex/config.toml` (Codex) give every agent here the same two:
Context7, for a library's or tool's current documentation, and Cloudflare's documentation server.
Both read public documentation and need no sign-in. Claude Code asks once to approve a project's
servers; Codex reads its project file only once the checkout is a trusted project.

- **Change both files and this section together**, so the two harnesses share one set.
- **A shared server reads public documentation.** One that reaches a production service (the
  hosted Supabase project, Cloudflare's API, Stripe, Resend) stays out of both files: production
  steps are the owner's, and Supabase's server reads as an administrator, customers' addresses
  included, which only the worker may read. The owner may keep Cloudflare's API server in their
  own config, with read-only access.
- **A secret reaches a process, never the conversation.** No MCP server reads 1Password or any
  other secret store: a command that needs a secret runs under `op run` with an env file of
  references.
- **Personal servers stay in your own config.** Mail, calendars and git clients are yours; agents
  here reach Git and GitHub through `git` and `gh`.

## Agent skills

The skills in `.agents/skills/` are installed from two sources and pinned in `skills-lock.json`:
the flow skills from [mattpocock/skills](https://github.com/mattpocock/skills), and the ones the
`shared-skills` block below lists from
[jwh3times/skills](https://github.com/jwh3times/skills). Both are MIT; see
`THIRD_PARTY_NOTICES.md`.

- **`.agents/skills/` is the source.** The skills installer writes there and Codex reads it.
  `.claude/skills/` is a generated copy for Claude Code; each generated `SKILL.md` says so on its
  second line. Never edit `.claude/skills/` by hand.
- **After installing, updating or editing a skill, run `pnpm sync:agents` and commit the result.**
  CI runs `pnpm sync:agents:check` and fails if the copy is stale, and `pnpm lint:agents`, which
  fails on a source that reads wrongly from its copy.
- **Both sets install and update with the commands under Shared skills below**, so the lock file
  stays right, then regenerate the copy.

- When a project rule, a required check or a
  document's job changes, update the setting that names it (`ship.md` `## Rule triggers` and
  `Fast checks`, the `Doc map` in `docs.md`).
- `ship` checks a branch against `## Rule triggers`, refreshes the docs, runs the fast checks and
  opens the pull request; `end-session` records what a session learned, files new work and human
  follow-ups as issues, and cleans up; `handoff` and `lets-go` pass a session to another machine
  (the machine's own setup is in `~/.config/handoffs/config`, which `handoff` proposes on its first
  run). `docs-updater` keeps the documents true to the code, by the `Doc map` in
  `docs/agents/docs.md`: `/ship` and `/end-session` run it, and run it yourself whenever a
  change touches a route, table, environment variable, command, scan behaviour, CI check or project
  rule. `what-next` ranks the open issues and pull requests by `## Priority order` in
  `docs/agents/issue-tracker.md` and recommends what to pick up next; it changes nothing, so an
  agent may run it unasked. `land` merges a pull request the user has named, by
  `docs/agents/merging.md`, and confirms its release, its deploy and the issues it closed;
  `dependabot` reviews the open Dependabot pull requests by `docs/agents/dependabot.md` and hands
  the ones the user names to `land`, and nothing merges a Dependabot pull request on its own.

### Shared skills

<!-- shared:shared-skills -->

`end-session`, `handoff`, `lets-go`, `open-pr`, `land`, `dependabot`, `docs-updater`, `what-next`,
`test-prover`, `ci-triage` and `records-audit` install from `jwh3times/skills`, and are never
edited here: reinstalling overwrites a local edit.
A fix goes upstream, and what they need to know about this repository goes in the settings files
under `docs/agents/`, which each skill proposes on first run.

The other shared skills come from one `mattpocock/skills` snapshot (v1.3.2, pinned by commit), the
same in every repository, and are never edited here either: what they need to know goes in this
file or `docs/agents/`. Moving to a newer snapshot is a change in `jwh3times/skills`. Keep
`.agents/skills/` out of every formatter: `scripts/check-skills.mjs` fails when an installed copy
differs from `skills-lock.json`, or the lock from these commands.

Re-running the install is the update; never run `npx skills update`, which leaves `.claude/skills/`
linked to its source instead of copied:

```bash
npx skills add jwh3times/skills -s end-session -s handoff -s lets-go -s open-pr -s land -s dependabot -s docs-updater -s what-next -s test-prover -s ci-triage -s records-audit -a codex --copy -y
npx skills add mattpocock/skills#d1478fcb140db0b93c0c8df17bcfd311844749d0 \
  -s ask-matt -s code-review -s codebase-design -s diagnosing-bugs -s domain-modeling -s grill-me \
  -s grill-with-docs -s grilling -s implement -s improve-codebase-architecture -s prototype \
  -s research -s setup-matt-pocock-skills -s tdd -s teach -s to-questionnaire -s to-spec \
  -s to-tickets -s triage -s wait-what -s wayfinder -s wizard -s writing-for-agents \
  -a codex --copy -y
node scripts/sync-agents.mjs
```

`scripts/sync-agents.mjs`, `lint-agent-neutrality.mjs`, `check-docs.mjs`, `check-skills.mjs`,
`guard.mjs`, and `sync-main.mjs`, `next-version.mjs`, `check-changelog.mjs` and
`stamp-changelog.mjs` where this repository carries them, are canonical in `jwh3times/skills` with
their tests: fix them there, then copy them here.
`sync-agents.mjs` also writes the marked blocks in this file: change them in `jwh3times/skills`, not
here. It registers `guard.mjs` in `.claude/settings.json`, which stops the commands and edits these
rules forbid; this repository's own additions go in `docs/agents/guard.md`.

<!-- /shared:shared-skills -->

### Issue tracker

Issues live in GitHub Issues, through the `gh` CLI: public work in `jwh3times/Nearcited`,
confidential work in the private companion's tracker. Every open issue from both is on the
Nearcited project board (project 10), whose `Stage`, `Gate` and `Priority` fields carry the
sequencing, with the items kept in `Priority` order. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`), plus `blocked` beside them while an issue has an open blocker or an outside wait, all of
which exist in both trackers. See `docs/agents/triage-labels.md`.

### Development flow

See [Development flow](#development-flow) above, `.agents/skills/ship/settings/dev-flow.md` for the whole flow, and
`docs/agents/dev-flow.md` for what this repository adds. Past `/ship`, `docs/agents/merging.md`
takes an open pull request through the merge and the deploy: read it before merging, catching up a
Dependabot pull request or running anything against the hosted project. `docs/agents/local-runs.md`
holds the development machine's traps: read it before stopping a Worker or a container, or
screenshotting the app.

### Domain docs

Single-context: `docs/adr/` at the repo root holds the decision records and one `GLOSSARY.md`
at the root holds the settled terms. See `docs/agents/domain.md`.
