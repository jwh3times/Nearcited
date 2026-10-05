---
# GENERATED — do not edit. Source: .agents/skills/ship/SKILL.md — regenerate with 'node scripts/sync-agents.mjs'.
name: ship
description: Ship the current branch — check it against the project rules, refresh the docs it made stale, run pnpm check, push, and open or update the PR. Use when a feature branch is ready for review, or when the user says "ship it", "open a PR", or "push this".
---

# Ship

Take the current branch from "code is done" to "PR is open with every required
check able to pass".

**Announce at start:** "I'm using the ship skill to open a PR for this branch."

`main` accepts changes only by pull request, on a branch that is up to date with
it, with three checks green: `Lint, typecheck, test, build`,
`Store against Postgres and PostgREST`, and `Verify generated agent config`. This
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
| touches `supabase/migrations/`          | Only **new** files; an edit to a migration already on `main` is a stop. A new table has policies, a `revoke`, explicit grants, and a non-member test in `packages/db/test/rls.test.ts`.                |
| adds or changes a payload               | The schema in `packages/shared/src/schemas.ts`, changed first, with snake_case field names, and both the API and the web client parsing through it.                                                    |
| adds a `Store` method                   | The Supabase implementation, the in-memory one in `apps/api/test/memory-store.ts`, and a line in `apps/api/test/supabase-store.integration.test.ts`.                                                   |
| adds a route                            | `c.get("store")` for data access. `createAdminClient` appears only in `apps/api/src/index.ts`; anywhere else it bypasses row-level security, so stop. A non-member request is tested and returns 404.  |
| adds or changes a provider              | A provider that returns an `Observation` and nothing else, registered only when its key is present, with recorded-response tests and no network. Matching stays in `analyzeObservation`.               |
| touches `PROVIDER_MODE` or the banner   | Mock mode still requires exactly `"mock"`, and the sample-data banner still shows while it is on.                                                                                                      |
| changes any `package.json` dependencies | A licence that combines with AGPL-3.0-only (MIT, ISC, BSD, Apache-2.0, MPL-2.0 pass; anything else is a stop until checked), and an updated `pnpm-lock.yaml`.                                          |
| touches `.agents/skills/`               | A regenerated `.claude/skills/` (step 4 runs the sync).                                                                                                                                                |
| adds any file                           | No secrets and no real customer or prospect data: the repository is public. `.dev.vars` and `.env.local` stay untracked.                                                                               |

**Done when:** every row whose trigger matches the diff has been checked, and each
gap is fixed or reported.

### 3. Refresh the docs the diff made stale

Each document owns one kind of fact. Update the owner; leave the others alone.

| Changed                                                                          | Owner                                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A route, an environment variable, a command, a table, setup or deploy steps      | `README.md` (API, Configuration, Commands, Data model, Run it locally, Deploy)  |
| Something listed under "What is not built" got built, or a new gap was left      | `README.md`, and "Known gaps" in `docs/architecture.md`                         |
| How a scan flows, failure handling, tenancy, a Worker limit                      | `docs/architecture.md`                                                          |
| The measured cost of one check                                                   | `docs/architecture.md` (issues #3 and #8 require it there)                      |
| A rule every change must follow, or a command agents run                         | `AGENTS.md`                                                                     |
| What counts as a security report                                                 | `SECURITY.md`                                                                   |
| A required CI check, the Dependabot schedule, a workflow                         | "Repository automation" in `README.md`                                          |
| A settled domain term or architecture decision                                   | `GLOSSARY.md` or `docs/adr/`, through `/domain-modeling`                        |

A pure refactor or test change usually owes no doc edit; say so in the report
instead of inventing one.

**Done when:** every row whose left column matches the diff has its owner
checked against the new behaviour.

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
closes it and the Build order task list updates by itself. A branch that closes
no issue is worth one line in the report: either the work was untracked, or an
issue should exist.

### 7. Report

Give the user: the PR URL; the issues it closes; what step 2 found and fixed or
left for them; which docs changed; and the state of the checks, saying which ran
locally and which only CI covers. CodeQL and the Copilot review also report on
the PR and can block the merge.

Merging is the user's call. `/ship` stops at "PR open".
