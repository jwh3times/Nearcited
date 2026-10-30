# Workspace

## Running pnpm

Every command below is the repository's `pnpm` form. Where `pnpm` is not on `PATH` (Node 26 ships
no Corepack), `npx pnpm@10.28.0 <args>` runs the same command — the version in `packageManager`.

## Private companion

`private/` — an independent Git repository (not a submodule), ignored by this one (`/private/` in
`.gitignore`) and restored by authorized maintainers with `npm run bootstrap:private`, which reads
its locator from 1Password. Repository: `discover: git -C private remote get-url origin` — this
repository never names it (`AGENTS.md`, "Private companion"). `private/README.md` is its index. A
public clone has no companion, and everything here installs, passes `pnpm check` and runs in mock
mode without it.

## Workspace status command

`git status --short --branch`; then, when `private/.git` exists,
`git -C private fetch -q --prune origin` and `git -C private status --short --branch` — the fetch
makes its ahead/behind counts current.

## Companion commit checks

- A file added, moved or retired has its row in `private/README.md`'s "Document authority" table in
  the same commit.

## Sync with main

`npm run sync:main` — refuses a dirty tree; fetches and fast-forwards `main` here and in `private/`
(a missing `private/` is skipped). `npm run sync:main -- --skip-private` updates only this checkout.

## Safe-to-remove paths

- `apps/web/dist/` — `pnpm build` output; the Worker's assets point at it, so `pnpm dev` needs
  `pnpm build` again afterwards
- `apps/api/dist/` — the Worker bundle check's `--outdir`
- `apps/api/.wrangler/`, `apps/pages/.wrangler/` — `wrangler dev` local state
- `apps/api/.tuning/` — written by `scripts/prepare-tuning.mjs` before every dev session and
  deploy; may hold private values, so removing it is never a loss
- `apps/e2e/playwright-report/`, `apps/e2e/test-results/` — end-to-end test output
- `coverage/`, `*.tsbuildinfo`
- stray scratch files at the repository root or under `private/`, named one by one

## Never-remove paths

- `private/`, in any form — an independent repository; `git clean -X` would take it
- `apps/api/.dev.vars`, `apps/pages/.dev.vars`, `apps/web/.env.local`, and any other `.env`/`.env.*`
  but the tracked `.env.example` — local keys, including this machine's `CONNECTIONS_KEY`; a new
  key makes the sign-ins sealed under the old one unreadable
- `supabase/.temp/` — the `supabase link` state for the hosted project; recreating it needs the
  maintainer's access token and database password
- `supabase/.branches/`
- `node_modules/` — every check runs from it
- `.claude/settings.local.json`, `.claude/worktrees/` — removing a worktree is the user's decision
- never `git clean -x` or `-X`

## Dev stack

- **Show:** `pnpm dlx supabase status` (the local stack, `project_id = "nearcited"`; containers
  `supabase_*_nearcited` in `docker ps`); `docker ps --filter name=postgrest` for a store
  integration-test PostgREST; listeners on 8787 (Worker), 5173 (Vite) and 8788 (Pages Worker)
  (`ss -ltn` on Linux).
- **Stop:** `pnpm dlx supabase stop` — keeps the local data; the stack stays up unless the user
  asks. `pnpm dev` and `wrangler dev` from the terminal that started them. A Postgres or PostgREST
  container the session started for the store integration test: `docker rm -f <name>`.
- **Never run:** `supabase stop --no-backup`, `supabase db reset`, or `docker volume rm`/`prune` on
  the `supabase_*_nearcited` volumes — they delete the local database; `supabase link` or
  `supabase db push` — they act on the hosted project (README "Deploy"); `pnpm cf:deploy`,
  `wrangler deploy`, `wrangler secret put` or the Deploy workflow — production;
  `pnpm local:env --force` — it rewrites the env files with a new `CONNECTIONS_KEY`.

## Generated-config check

`pnpm sync:agents:check` (the required **Verify generated agent config**, beside
`node --test scripts/sync-agents.test.mjs`), regenerated with `pnpm sync:agents`, committing
`.claude/skills/` and `.codex/agents/` with their sources — always: it is quick, and it also
catches an orphaned mirror.

## Final portability check

none

## Hook: after sync

1. When the sync brought new files under `supabase/migrations/` and the local stack is running, say
   so and offer `pnpm dlx supabase migration up` (applies only the pending migrations, keeping the
   data). Never `supabase db reset`.
2. When `apps/api/.dev.vars`, `apps/pages/.dev.vars` or `apps/web/.env.local` is missing and the
   stack is running, offer `pnpm local:env` (never `--force`).
