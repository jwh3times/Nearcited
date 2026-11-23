### Added

- `docs/agents/guard.md` holds this repository's own rules for the shared guard hook
  (`scripts/guard.mjs`), on top of the rules it applies everywhere. It denies the commands that
  delete the local database (`supabase stop --no-backup`, `supabase db reset`, removing or pruning
  the `supabase_*_nearcited` volumes), act on the hosted project or production (`supabase link`,
  `supabase db push` without `--dry-run`, `pnpm cf:deploy`, `wrangler deploy` without `--dry-run`,
  `wrangler secret`, a manual Deploy run), `pnpm local:env --force`, `npx skills update`, and
  stopping `workerd` by image name. It asks before `supabase stop`, and protects `private/`, the
  local key files, the Supabase CLI state and `node_modules/`. The docs map lists the new file. No
  product behavior changes.
