---
name: ship
description: Ship the current branch — check it against the project rules, refresh the docs it made stale, run pnpm check, push, and open or update the PR. Use when a feature branch is ready for review, or when the user says "ship it", "open a PR", or "push this".
---

# Ship

Take the current branch from "code is done" to "PR is open with every required
check able to pass".

**Announce at start:** "I'm using the ship skill to open a PR for this branch."

`main` accepts changes only by pull request, on a branch that is up to date with
it, with four checks green: `Lint, typecheck, test, build`,
`Store against Postgres and PostgREST`, `Verify generated agent config`, and
`End-to-end in a browser`. This
repository has no version file and no changelog; the PR body is the record of the
change.

## Steps

### 1. Preconditions: stop if any fail

- **On a branch.** If on `main`, stop and offer to create one
  (`git switch -c <topic>`).
- **Clean working tree.** `git status --porcelain`. If anything is uncommitted,
  stop and ask the user whether to commit it.
- **`gh` authenticated.** `gh auth status` succeeds.
- **Up to date with `main`.** `git fetch origin`, then
  `git merge-base --is-ancestor origin/main HEAD`. If it fails, merge or rebase
  `origin/main` now: the ruleset refuses to merge a branch that is behind, and
  conflicts are cheaper before the docs pass than after.

### 2. Review the diff against the rules

Read the whole branch diff, since commit messages leave things out:

```bash
base=$(git merge-base origin/main HEAD)
git diff --stat "$base"..HEAD
git diff "$base"..HEAD
```

`AGENTS.md` holds the rules. Walk the diff once for each trigger below and fix
what is missing, or stop and tell the user when the fix is a design decision.

| The diff…                               | Must also contain                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| touches `supabase/migrations/`          | Only **new** files; an edit to a migration already on `main` is a stop. A new table has policies, a `revoke`, explicit grants, and a non-member test in `packages/db/test/rls.test.ts`. The Worker deployed before the migration still works after it. Where the migration drops or renames something that Worker uses, the PR body says to deploy first and migrate second.                |
| writes a limit, `plan_key`, `paused_by_plan` or `set_aside_by_plan` | Only through `apply_plan()` (worker only) or the operator's function. No request path writes them, and nothing gives an account a second organization. |
| adds or changes a payload               | The schema in `packages/shared/src/schemas.ts`, changed first, with snake_case field names, and both the API and the web client parsing through it.                                                    |
| adds a `Store` method                   | The Supabase implementation, the in-memory one in `apps/api/test/memory-store.ts`, and a line in `apps/api/test/supabase-store.integration.test.ts`.                                                   |
| adds a route                            | `c.get("store")` for data access. `createAdminClient` appears only in `apps/api/src/index.ts` and in the payment provider's webhook in `apps/api/src/app.ts` (`docs/adr/0007-the-payment-webhook-acts-as-the-worker.md`); anywhere else it bypasses row-level security, so stop. A non-member request is tested and returns 404.  |
| adds or changes a provider              | A provider that returns an `Observation` and nothing else, registered only when its key is present, with recorded-response tests and no network. Matching stays in `analyzeObservation`.               |
| adds a prompt, weight or sampling value | A field and placeholder default in `TuningSchema`, passed to the code as an argument. The real value goes in `private/tuning.json`, never in this diff. No web file imports a value from the tuning module.          |
| touches `PROVIDER_MODE` or the banner   | Mock mode still requires exactly `"mock"`, the sample-data banner still shows while it is on, and live scans still refuse the default tuning.                                                                                                      |
| touches sample data, `is_test` or `platform_roles` | A test organization's scans are still generated, recorded as `sample_data`, shown under the banner, and never reach a real provider, a site or an inbox. Nothing a request can do writes `platform_roles` or `organizations.is_test`. |
| touches billing, `subscriptions` or the webhook | The webhook still verifies the signature before reading the body, acts only on the subscription read back from the provider, and is the only caller of `applyPlan` on a request. No request path writes `subscriptions`. Checkout, the account pages and the subscription change routes answer only an organization's owner, and decide upgrade or downgrade on the server. A price is never edited in place: a change makes new prices and keeps the old ones in `plan_prices`, so a subscription still matches its plan. Nothing but `runPriceChangeStep` changes what a running subscription is billed at, and the thirty-day notice check stays per organization. Nothing lowers a paid plan's limits but an announced reduction made by `apply_limit_change()`; `operator_set_plan()` refuses to on a plan with subscribers. |
| changes any `package.json` dependencies | A licence that combines with AGPL-3.0-only (MIT, ISC, BSD, Apache-2.0, MPL-2.0 pass; anything else is a stop until checked), and an updated `pnpm-lock.yaml`.                                          |
| touches `.agents/skills/` or `.claude/agents/` | Regenerated `.claude/skills/` and `.codex/agents/` (step 4 runs the sync).                                                                                                                      |
| mentions prompts, weights, pricing, a vendor quote, or a real business | None of it. That content lives in `private/` (see "Private companion" in `AGENTS.md`); move it there and leave at most a note that it exists. The private repository's name appears nowhere in the diff. |
| adds any file                           | No secrets and no real customer or prospect data: the repository is public. `.dev.vars` and `.env.local` stay untracked.                                                                               |

**Done when:** every row whose trigger matches the diff has been checked, and each
gap is fixed or reported.

### 3. Refresh the docs the diff made stale

Dispatch the `docs-updater` agent in **fix** mode, scoped to this branch's diff
(`"$base"..HEAD`), and tell it what step 2 changed. It owns the table of which
document holds which fact. Where the harness cannot dispatch an agent, read
[`.claude/agents/docs-updater.md`](../../../.claude/agents/docs-updater.md) and
follow it yourself.

A pure refactor or test change usually owes no doc edit; the agent's report
saying so is a complete result.

**Done when:** the agent's report is in hand, and each drift it could not
resolve from code is fixed or carried into step 7.

### 4. Checks: refuse to push if any fail

```bash
pnpm sync:agents      # regenerate .claude/skills, so the agent config check passes
pnpm format           # Biome fixes, including the files the steps above edited
pnpm check            # lint, typecheck, every unit test, build
```

`pnpm check` is the first required CI job, minus the Worker bundle check, and takes
well under a minute. Add the bundle check when the diff touches `apps/api`:

```bash
pnpm --filter @nearcited/api exec wrangler deploy --dry-run --outdir dist
```

The store integration test needs Postgres and PostgREST and runs in CI. When the
diff touches `apps/api/src/store/` or a migration, say in the report that this
test is the one that covers it and that it has not run locally, unless
`POSTGREST_URL` is set and you ran it.

The end-to-end tests drive the app in a browser and are a required check. They need
the local Supabase stack, so `pnpm check` does not run them. When the diff touches
`apps/web`, a route the web app calls, or `apps/e2e`, run them before pushing, which
is quicker than waiting for CI to say no:

```bash
pnpm e2e              # needs `supabase start`, and `pnpm local:env` once
```

Where the stack is not running, say in the report that CI is what will run them.

If any command is red, stop and report.

### 5. Commit what the steps above changed

```bash
git add -A
git commit -m "<what the docs or generated files now say>"
```

Commit subjects here are plain sentences in the imperative ("Add the location
edit form"), with no type prefix. Skip the commit when steps 2 to 4 changed
nothing.

### 6. Push and open or update the PR

```bash
git push -u origin "$(git branch --show-current)"
gh pr list --head "$(git branch --show-current)" --state open --json number -q '.[0].number'
```

- **No PR**: `gh pr create --base main`, with the body following
  `.github/pull_request_template.md`: What changed, How it was checked, and the
  Before merging checklist ticked from what steps 2 and 4 actually established.
- **PR exists**: `gh pr edit <number>` to refresh the body.

Write `Closes #N` in the body for each issue the branch finishes, so the merge
closes it and the [project board](https://github.com/users/jwh3times/projects/10) moves it to Done. A branch that closes
no issue is worth one line in the report: either the work was untracked, or an
issue should exist.

### 7. Report

Give the user: the PR URL; the issues it closes; what step 2 found and fixed or
left for them; which docs changed; and the state of the checks, saying which ran
locally and which only CI covers. CodeQL and the Copilot review also report on
the PR and can block the merge.

`/ship` covers this repository only. When the same work changed `private/`,
commit and push there separately (`git -C private status`), and say in the
report whether that is done. The PR body does not mention it.

Merging is the user's call. `/ship` stops at "PR open".
