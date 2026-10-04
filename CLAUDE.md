# Nearcited

Local-visibility tracker: one Cloudflare Worker (Hono API, cron, queue consumer), a React app it
serves as static assets, Supabase for Postgres and auth. Read `docs/architecture.md` before
changing how scans run or how data is accessed.

## Commands

- `pnpm check`: lint, typecheck, test, build. Must pass before a change is done.
- `pnpm format`: apply Biome fixes.
- `pnpm --filter @nearcited/<api|web|shared|db> test`: one package's tests.
- `pnpm dev`: Worker on 8787, Vite on 5173.

## Rules

- **Row-level security is the authorization layer.** Request handlers use the store from
  `c.get("store")`, which acts as the signed-in user. Never call `createAdminClient` on a request
  path; it bypasses the policies.
- **New table: policies, explicit grants and a non-member test in `packages/db`, in the same
  change.** Supabase grants everything in `public` to every API role by default, so a table
  without a `revoke` is open.
- **Migrations are append-only.** Add a new file in `supabase/migrations`; do not edit one that
  has been applied anywhere.
- **`packages/shared/src/schemas.ts` defines every wire type.** Change the schema first, then the
  API and the client. Field names stay snake_case end to end.
- **All database access goes through the `Store` interface** (`apps/api/src/store/types.ts`). A
  new method needs the Supabase implementation, the in-memory one in `apps/api/test`, and a line in
  the integration test.
- **Providers only fetch.** They return an `Observation`; `analyzeObservation` in the shared
  package decides what it means. Do not put matching logic in a provider.
- **Mock data must never pass as real.** `PROVIDER_MODE` is mock only when it is exactly `"mock"`,
  and the UI shows a banner while it is. Keep both.
- No secrets in the repo. Local values go in `apps/api/.dev.vars` and `apps/web/.env.local`, both
  gitignored.
