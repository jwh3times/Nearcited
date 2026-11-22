# Dependabot

What reviewing a Dependabot pull request takes here, read by the `dependabot` skill in a session
and in the scheduled review. These facts apply to this repository only.

## Stack

- A pnpm workspace with one lockfile, `pnpm-lock.yaml` at the root, covering the root
  `package.json`, `apps/*` and `packages/*` (`pnpm-workspace.yaml`). The package manager is
  `pnpm@10.28.0` (`packageManager` in `package.json`).
- `apps/api` is the main Cloudflare Worker: a Hono API under `/api` plus `/r/*`
  (`apps/api/src/app.ts`), two Cron Triggers and a queue consumer (`apps/api/src/index.ts`,
  `apps/api/wrangler.jsonc`), on `@supabase/supabase-js`, `@anthropic-ai/sdk`, `stripe`
  (`apps/api/src/billing/stripe.ts`), `resend`, `zod` 4 and `fflate`. Its `wrangler.jsonc` serves
  `apps/web`'s build as static assets. `apps/pages` is a second Worker that serves hosted pages
  only.
- `apps/web` is a React 19 SPA on Vite 8, with `react-router` 8 (`apps/web/src/App.tsx`) and
  `@tanstack/react-query`. `apps/e2e` is Playwright. `packages/db` runs the migrations and the
  row-level security tests in in-process Postgres (`@electric-sql/pglite`). `packages/shared` holds
  the zod schemas and `libphonenumber-js`. Every package's tests run on Vitest 5.
- The data store is hosted Supabase. The Supabase CLI is the root devDependency `supabase`,
  pinned exactly. Lint and format are Biome 2 (`biome.json`); TypeScript is 7 (each package's
  `tsconfig.json`).
- `.github/dependabot.yml` updates `npm` at `/` and `github-actions` at `/`, daily. Groups: `react`
  (majors of `react`, `react-dom`, `@types/react`, `@types/react-dom`), `vite` (majors of `vite`,
  `vitest`, `@vitejs/plugin-react`, `@vitest/*`), `minor-and-patch` (every other npm minor and
  patch) and `actions-minor-and-patch`. Every other major arrives as its own PR. There is no
  `docker` ecosystem.

## Resolution

At the repository root: Node from `.nvmrc` (26; `engines` requires `>=26`), then
`npm install -g pnpm@10.28.0`, then `pnpm install --frozen-lockfile`, the install every CI job
runs (`.github/workflows/ci.yml`; `pnpm/action-setup@v6` takes the version from `packageManager`).
Read the install output for unmet peers against the same install on `main`.

## Where to look

- `apps/api/src` (the Hono app, the `scheduled` and `queue` handlers, `billing/stripe.ts`),
  `apps/web/src` (the router in `App.tsx`), `packages/shared/src`.
- `apps/api/test`: the provider tests assert the exact requests a library sends
  (`apps/api/test/claude.test.ts` asserts the Messages URL).
- `apps/api/wrangler.jsonc` and `apps/pages/wrangler.jsonc`, `apps/web/vite.config.ts`,
  `packages/db/vitest.config.ts`, `apps/e2e/playwright.config.ts` and
  `apps/e2e/playwright.smoke.config.ts`, `biome.json`, each `tsconfig.json`, `pnpm-workspace.yaml`.
- The `with:` inputs and the `run:` commands in `ci.yml`, `changelog.yml`, `version.yml` and
  `deploy.yml` under `.github/workflows/`.

## Grounding facts

- `version.yml` and `deploy.yml` run only on `main`, after a merge (`push` to `main`, and
  `workflow_run` of Version). A pull request's CI never runs them, so a green PR says nothing
  about the steps only they hold: `actions/create-github-app-token@v3` (`version.yml`),
  `1password/load-secrets-action@v5` and the checkout of the private companion with `ssh-key`
  (`deploy.yml`), and the Supabase CLI's `db push --remote ... --dry-run` and `--yes`
  (`deploy.yml`). A bump that reaches one of those is reviewed against its `with:` inputs or its
  flags, since CI is no gate for it.
- Dependabot updates neither the `postgres:17` service nor `postgrest/postgrest:v13.0.4` in
  `ci.yml`. Both are throwaway CI containers with no persisted data directory, so the "a newer
  Postgres major refuses an old data directory" hazard does not apply. If a PR does touch one, the
  gate is the "Store against Postgres and PostgREST" job.
- The "Changelog names the version this merge mints" check (`changelog.yml`,
  `scripts/check-changelog.mjs`) runs on Dependabot PRs with no exemption. A PR with no
  `changelog.d/` fragment passes it, and after the merge `version.yml`
  (`scripts/stamp-changelog.mjs`) writes the merge's changelog section from the PR title. Its
  green says nothing about the dependency.
- `@vitejs/plugin-react` needs a matching Vite major, and Vitest tracks the Vite majors it
  supports; that is why the `vite` group exists. Review it as one unit. Vitest runs every
  package's tests, not only `apps/web`'s.
- Both Workers are deployed by wrangler. CI's `wrangler deploy --dry-run --outdir dist` is the gate
  for `wrangler.jsonc` schema and bundling changes.
- pnpm 10 runs install scripts only for the packages under `onlyBuiltDependencies` in
  `pnpm-workspace.yaml` (`esbuild`, `workerd`, `sharp`). A bump that adds a dependency needing an
  install script installs without running it; read the install output for skipped build scripts.
- `billing/stripe.ts` constructs `Stripe` with no `apiVersion`, so the API version a request uses
  is the one the installed `stripe` major pins.

## Playbook

- `vite` group major: read the Vite, Vitest and plugin-react notes for each major crossed; check
  `apps/web/vite.config.ts` and `packages/db/vitest.config.ts`; run `pnpm typecheck`, `pnpm test`
  and `pnpm build`.
- `react` group major: read the React upgrade notes; check whether `react-router` and
  `@tanstack/react-query` report new unmet peers on `react` against `main`; run `pnpm typecheck`,
  `pnpm test` and `pnpm build`.
- Worker tooling major (`wrangler`, `@cloudflare/workers-types`): read the changelog for schema
  changes to the `wrangler.jsonc` keys used here (`assets`, `triggers.crons`, `queues`,
  `compatibility_flags`, `build`, `alias`, `routes`); run the wrangler dry run and
  `pnpm typecheck`.
- Server-library major (`hono`, `stripe`, `zod`, `@supabase/supabase-js`, `@anthropic-ai/sdk`,
  `resend`, `fflate`, `libphonenumber-js`): read the migration guide; search `apps/api/src`,
  `apps/web/src` and `packages/shared` for the APIs used; run `pnpm typecheck` and `pnpm test`. For
  `stripe`, read which API version the new major pins and check `billing/stripe.ts` against it.
- `@anthropic-ai/sdk`, any bump: `apps/api/test/claude.test.ts` asserts the exact Messages request
  URL. 1.3.0, a minor, dropped `?beta=true` from it and turned `pnpm test` red; the fix was to
  update that assertion on the PR's branch (PR #239, its review comment and the commit pushed to
  it). A red there that names only the request URL is that change, not a break.
- `@electric-sql/pglite` major: it runs the migrations and row-level security tests in
  `packages/db`. Read the release notes; run `pnpm test`.
- TypeScript or Biome major: run `pnpm typecheck` and `pnpm lint`; cite the compiler option or lint
  rule that changed, against each `tsconfig.json` or `biome.json`.
- `@playwright/test` major: e2e is CI-only (it needs the local Supabase stack). Read the release
  notes for config and API breaks against `apps/e2e`; the gate is the "End-to-end in a browser" job.
- Supabase CLI major (`supabase`): the e2e job runs `pnpm exec supabase start --exclude` with the
  list of services in `ci.yml`, the root `db:types` script runs
  `supabase gen types --lang typescript`, and Deploy runs
  `supabase db push --remote=<url> --dry-run`, then `--yes`. Confirm each command and flag still
  exists in the new major; the e2e job is the gate for `start`, and nothing before the merge runs
  `db push`.
- GitHub Actions major (`actions/checkout`, `actions/setup-node`, `pnpm/action-setup`,
  `actions/upload-artifact`, `actions/create-github-app-token`, `1password/load-secrets-action`):
  NEEDS EFFORT only if a removed or renamed input or a changed default reaches a `with:` use here
  (`setup-node`'s `node-version-file: .nvmrc`, `cache: pnpm`, `package-manager-cache: false`;
  `checkout`'s `fetch-depth: 0`, `ref`, `token`, `repository`, `ssh-key`, `path`,
  `persist-credentials`; `create-github-app-token`'s `client-id`, `private-key`,
  `permission-contents`; `upload-artifact`'s `name`, `path`, `retention-days`). Name the step.
