# Test proof

How `test-prover` runs one test on its own here, and how it tells a run that tested nothing from a
pass. `pnpm` is not always on `PATH` (`docs/agents/workspace.md`), so the commands run each
package's own Vitest through `npx`.

## Test commands

- `apps/api/`: `test/**/*.test.ts`. One file: `npx vitest run <file>`; one test:
  `npx vitest run <file> -t "<name>"`. Worktree: link `node_modules` and `apps/api/node_modules`.
  `test/supabase-store.integration.test.ts` is not run here: it needs Postgres and PostgREST with
  `POSTGREST_URL` set (CI's **Store against Postgres and PostgREST** job), and without them skips
  every test.
- `apps/web/`: `test/**/*.test.ts`. One file: `npx vitest run <file>`; one test:
  `npx vitest run <file> -t "<name>"`. Worktree: link `node_modules` and `apps/web/node_modules`.
- `apps/pages/`: `test/**/*.test.ts`. One file: `npx vitest run <file>`; one test:
  `npx vitest run <file> -t "<name>"`. Worktree: link `node_modules` and `apps/pages/node_modules`.
- `packages/shared/`: `test/**/*.test.ts`. One file: `npx vitest run <file>`; one test:
  `npx vitest run <file> -t "<name>"`. Worktree: link `node_modules` and
  `packages/shared/node_modules`.
- `packages/db/`: `test/**/*.test.ts`, the row-level security tests, each loading the migrations
  into an in-process Postgres. One file: `npx vitest run <file>`; one test:
  `npx vitest run <file> -t "<name>"`. Worktree: link `node_modules` and
  `packages/db/node_modules`; `test/private-tuning.test.ts` also needs `private` linked, and skips
  without it, which reads as `zero-match`, not proven.
- repo root: `scripts/*.test.mjs`. One file: `node --test <file>`; one test:
  `node --test --test-name-pattern="<name>" <file>`. Worktree: link `node_modules`.
- `apps/e2e/`: the Playwright browser tests and the smoke test are not run here: they need the
  local Supabase stack, the env files from `pnpm local:env` and an installed browser, or a deployed
  stack and its `E2E_*` and `TEST_ACCOUNT_*` values.

## Guide

none
