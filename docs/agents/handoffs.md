# Handoffs

## Map key

Nearcited

## Extra document content

- Machine-local files the other machine must have, named never valued: `apps/api/.dev.vars`,
  `apps/pages/.dev.vars`, `apps/web/.env.local` (written there by `pnpm local:env` after
  `pnpm dlx supabase start`; `--force` would make a new `CONNECTIONS_KEY`), and whether the local
  Supabase stack held data that matters. The companion is restored with
  `npm run bootstrap:private`.
- Where the work sits in the public Build order issue (#15).
- The companion appears only as its state and commit hash, and private material only by its path
  under `private/` — never its remote, an issue link or its content.
