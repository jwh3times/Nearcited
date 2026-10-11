# Nearcited

The engineering contract for every coding agent in this repository. `CLAUDE.md` imports this file;
Codex reads it directly. Project rules live here and nowhere else.

Local-visibility tracker: one Cloudflare Worker (Hono API, cron, queue consumer), a React app it
serves as static assets, Supabase for Postgres and auth. Read `docs/architecture.md` before
changing how scans run or how data is accessed.

## Commands

- `pnpm check`: lint, typecheck, test, build. Must pass before a change is done.
- `pnpm format`: apply Biome fixes.
- `pnpm --filter @nearcited/<api|web|shared|db> test`: one package's tests.
- `pnpm dev`: Worker on 8787, Vite on 5173.
- `pnpm e2e`: browser tests; needs `supabase start` and the env files. `pnpm check` skips them.
- `pnpm smoke`: the smoke test against a deployment; needs `E2E_*` and `TEST_ACCOUNT_*` set.
- `pnpm billing:check`: ask Stripe and the deployment whether billing is set up as the app
  expects. Reads only; needs `STRIPE_SECRET_KEY` and `SUPABASE_SECRET_KEY` in the environment.
- `pnpm test-account:create`: make the deployment's test account (needs the Supabase secret key).
- `pnpm local:env`: write `apps/api/.dev.vars` and `apps/web/.env.local` from `supabase status`.
- `npm run bootstrap:private`: clone the private companion into `private/` (maintainers only).
- `npm run sync:main`: fast-forward `main` here and in `private/`. Refuses a dirty tree.
- `pnpm sync:agents`: regenerate `.claude/skills` and `.codex/agents` after changing anything in
  `.agents/skills` or `.claude/agents`.

## Private companion

`private/` is gitignored here and is a separate, confidential repository for authorized
maintainers. A public clone does not have it, and everything in this repository must install,
pass `pnpm check` and run in mock mode without it.

- **What lives there:** provider prompt text, sampling and score weights; pricing, vendor quotes
  and measured costs by vendor; anything naming a real customer or prospect; security review
  findings; deployment runbooks. `private/README.md` is its index and says what each file owns.
  Read it before working there.
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

- **Row-level security is the authorization layer.** Request handlers use the store from
  `c.get("store")`, which acts as the signed-in user. Never call `createAdminClient` on a request
  path; it bypasses the policies. The one exception is the payment provider's webhook, on the
  terms in `docs/adr/0007-the-payment-webhook-acts-as-the-worker.md`: do not add a second.
- **A subscription changes a plan only through the webhook.** Checkout and the account pages are
  the provider's. An owner's request may start a checkout, or change the subscription at the
  provider (an upgrade now, a downgrade at the end of the paid period), and writes nothing here.
  The webhook verifies the signature, reads the subscription back from the provider and calls
  `applyPlan`. `subscriptions` has no write path from a request, and whether a change is an
  upgrade is worked out on the server from the prices, never taken from the request.
- **A subscriber's price goes up only after they were told.** Setting a plan's price changes it
  for new subscribers; current ones keep the price version they joined at until an announced
  change moves them (`docs/adr/0008-a-price-change-reaches-subscribers-by-announcement.md`).
  `runPriceChangeStep` moves a subscription to a higher price only when its owners were sent the
  announcement at least thirty days before, checked per organization. Do not add another path
  that changes what a running subscription is billed, and never edit a price in place.
- **What a paying subscriber gets goes down only after they were told.** On a plan with
  subscribers a lower limit is announced for a day at least thirty days out and made on that day
  by `apply_limit_change()`, which only the worker calls
  (`docs/adr/0009-a-reduction-is-announced-like-a-price-rise.md`). `operator_set_plan()` refuses
  to lower anything there on the spot. Raising a limit, and anything on a plan nobody pays for,
  still happens at once. Do not add a path that lowers a paid plan's limits without the
  announcement.
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
  has been applied anywhere.
- **A migration leaves the running Worker working.** It is applied before the deploy, so the
  Worker from before it must still work against the database after it. Add a new column first
  and drop the old one later, once no deployed code reads it. A change that drops something its
  own code has just stopped using says in the pull request that it is deployed first and
  migrated second.
- **An organization's limits come from its plan.** `apply_plan()`, which only the worker calls,
  copies them from the plan, and the operator's limits editor changes them through its function.
  Nothing on a request path writes a limit, `plan_key`, `paused_by_plan` or `set_aside_by_plan`.
  An account has one organization: `create_organization()` refuses a second.
- **`packages/shared/src/schemas.ts` defines every wire type.** Change the schema first, then the
  API and the client. Field names stay snake_case end to end.
- **All database access goes through the `Store` interface** (`apps/api/src/store/types.ts`). A
  new method needs the Supabase implementation, the in-memory one in `apps/api/test`, and a line in
  the integration test.
- **Providers only fetch.** They return an `Observation`; `analyzeObservation` in the shared
  package decides what it means. Do not put matching logic in a provider.
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

## Agent skills

The skills come from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, see
`THIRD_PARTY_NOTICES.md`) and are pinned in `skills-lock.json`.

- **`.agents/skills/` is the source.** The skills installer writes there and Codex reads it.
  `.claude/skills/` is a generated copy for Claude Code; each generated `SKILL.md` says so on its
  second line. Never edit `.claude/skills/` by hand.
- **After installing, updating or editing a skill, run `pnpm sync:agents` and commit the result.**
  CI runs `pnpm sync:agents:check` and fails if the copy is stale.
- **Install or update with the installer**, so the lock file stays right:
  `npx skills add mattpocock/skills -a codex -s <name> --copy -y`, or `npx skills update -p -y`.
- **Four skills are this repository's own** and are not in the lock file: `ship` (rule check, doc
  refresh, `pnpm check`, PR), `end-session` (record what a session learned, then clean up),
  and `handoff` with `lets-go` (pass a session to another machine through the Proton Drive
  Handoffs folder). Edit them in `.agents/skills/`. When a project rule, a required check or a
  document's job changes, update `ship` to match.
- `scripts/sync-agents.mjs` and its test are shared verbatim with other repositories. Do not edit
  them here.
- **Agents run the other way: `.claude/agents/*.md` is the source** and `.codex/agents/*.toml` is
  generated by the same sync. There is one, `docs-updater`, which holds the table of which
  document owns which fact. Run it, or read its file and follow it, whenever a change touches a
  route, table, environment variable, command, scan behaviour, CI check or project rule. `/ship`
  and `/end-session` both call it.

### Issue tracker

Issues live in GitHub Issues, through the `gh` CLI: public work in `jwh3times/Nearcited`,
confidential work in the private companion's tracker. Every open issue from both is on the
Nearcited project board (project 10), whose `Stage` and `Gate` fields carry the sequencing. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five default labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`), all of which exist in the tracker. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `docs/adr/` at the repo root holds the decision records and one `GLOSSARY.md`
at the root holds the settled terms. See `docs/agents/domain.md`.
