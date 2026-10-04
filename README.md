# Nearcited

Tracks whether a local business gets named when people ask an AI assistant or search Google for
what it sells, and who gets named instead.

**Status: skeleton.** The application runs end to end on generated sample data. No real data
provider is wired in yet, so nothing it shows today is a measurement. See
[What is not built](#what-is-not-built).

## Stack

| Layer | Choice |
| --- | --- |
| Web | React 19, Vite, TypeScript, React Router, TanStack Query |
| API and jobs | One Cloudflare Worker: Hono for HTTP, a Cron Trigger to schedule scans, a Queue to run them |
| Data and auth | Supabase (Postgres with row-level security, email sign-in) |
| Email | Resend |
| Tooling | pnpm workspaces, Biome, Vitest |

## Layout

```
apps/
  api/          The Worker. src/index.ts exports fetch, scheduled and queue.
  web/          The React app. Its build output is served by the Worker as static assets.
packages/
  shared/       Zod schemas for every wire type, plus the logic that decides whether a business
                was named, the visibility score, and the rule-based recommendations.
  db/           Tests that run the migrations in in-process Postgres and attack the policies.
supabase/
  migrations/   Schema, row-level security, and the SQL functions the Worker calls.
scripts/        integration-db.sh prepares a plain Postgres for the store integration test.
docs/           architecture.md: how a scan flows, the tenancy model, and known gaps.
```

## Run it locally

Needs Node 22, pnpm 10, and Docker (for the local Supabase stack).

```sh
pnpm install

# 1. Start Supabase. This applies supabase/migrations and prints the URL and keys.
pnpm dlx supabase start

# 2. Configure both apps with the values from `supabase status`.
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/web/.env.example apps/web/.env.local

# 3. Build the web app once. The Worker's config points at apps/web/dist.
pnpm build

# 4. Run the Worker (port 8787) and Vite (port 5173) together.
pnpm dev
```

Open http://localhost:5173 and sign in with any email address. Locally the sign-in link is not
sent anywhere; read it in the mail catcher at http://127.0.0.1:54324.

With `PROVIDER_MODE=mock`, "Run scan" returns generated results within about ten seconds and the
app shows a banner saying so. To fire the daily schedule by hand:

```sh
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Worker and web app with reload |
| `pnpm check` | Lint, typecheck, test and build. Run before pushing. |
| `pnpm lint` / `pnpm format` | Biome check / fix |
| `pnpm typecheck` | `tsc` in every package |
| `pnpm test` | Every unit test, including the row-level security tests |
| `pnpm build` | Build the web app |
| `pnpm cf:deploy` | Build, then `wrangler deploy` |

## Tests

- **`packages/shared`**: name matching, mention detection, scoring, recommendation rules, input
  validation.
- **`packages/db`**: applies the real migrations to in-process Postgres (PGlite) and checks, as
  different users, that one organization cannot read or write another's rows, that users cannot
  forge scan results, and that worker-only functions are closed to them. No Docker needed.
- **`apps/api`**: every route against an in-memory store, the scan runner (success, retry,
  permanent failure, reporting), the scheduler, and the mock providers.
- **`apps/web`**: the logic that lays results out as a grid.

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
   `pnpm dlx supabase db push`. In Auth settings, set the site URL to your deployed URL.
2. Create the queues:
   ```sh
   cd apps/api
   pnpm exec wrangler queues create nearcited-scans
   pnpm exec wrangler queues create nearcited-scans-dlq
   ```
3. In `apps/api/wrangler.jsonc`, set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `APP_URL` and
   `EMAIL_FROM`.
4. Set the secrets:
   ```sh
   pnpm exec wrangler secret put SUPABASE_SECRET_KEY
   pnpm exec wrangler secret put RESEND_API_KEY   # optional: scheduled-scan reports
   ```
5. From the repo root, with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` set in the
   environment: `pnpm cf:deploy`.

`.github/workflows/deploy.yml` does step 5 on demand once the repository has the secrets and
variables listed at the top of that file.

`PROVIDER_MODE` ships as `mock`. Any other value means live, and live has no providers yet, so
scans will fail with "No data provider is configured" until one is written.

## What is not built

- **Real data providers.** `apps/api/src/providers/live.ts` is an empty registry with notes on
  what each surface needs. This is the product; everything else is plumbing.
- **Billing and plan limits.** Nothing stops an organization from adding unlimited locations and
  queries, each of which will cost money per scan once providers are live.
- **Inviting teammates.** The schema and policies support members and roles; there is no API or
  screen for it.
- **Switching organizations.** A user in several organizations always sees the first.
- **Trends.** Scan history is stored and served (`GET /api/locations/:id/scans`) but not charted.
- **Editing a location** after creating it.
- **Stuck-scan cleanup.** A scan whose queue message is lost stays "queued" forever.

More detail, and the open product questions, in [docs/architecture.md](docs/architecture.md).
