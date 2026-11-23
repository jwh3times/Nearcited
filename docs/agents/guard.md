# Guard

The commands and paths `scripts/guard.mjs` stops in this repository, on top of the rules it applies
everywhere. Each heading is a setting defined in `.agents/skills/ship/settings/guard.md`.

## Deny commands

- `\bsupabase stop\b.*\s--no-backup\b` — deletes the local database. Stop the stack with
  `pnpm exec supabase stop`, which keeps the data, and only when the user asks.
- `\bsupabase db reset\b` — deletes the local database. Apply new migrations with
  `pnpm exec supabase migration up`, which keeps the data.
- `^docker volume (prune\b|rm\b.*supabase_\S*nearcited)|^docker system prune\b.*\s--volumes\b` — removing
  or pruning the `supabase_*_nearcited` volumes deletes the local database.
- `\bsupabase link\b` — links the checkout to the hosted project. A maintainer runs it (README
  "Deploy").
- `\bsupabase db push\b(?!.*\s--dry-run\b)` — pushes migrations to the hosted project with
  `--remote`, or without it to whatever local database answers, which can be another project's. Run
  `pnpm exec supabase db push --dry-run --remote` and give the maintainer the push command.
- `^(pnpm|npm|npx)\b.*\s(cf:deploy|run deploy)(\s|$)` — `pnpm cf:deploy` and a package's
  `deploy` script deploy to production, which a merge to `main` already does. Give the maintainer
  the command instead.
- `\bwrangler (versions )?deploy\b(?!.*\s--dry-run\b)` — deploys a Worker to production. Check a
  bundle with `wrangler deploy --dry-run --outdir dist`.
- `\bwrangler secret (put|bulk|delete)\b` — changes a production Worker secret. Give the maintainer
  the command instead.
- `^gh workflow run\s+(\S*/)?(deploy\.ya?ml|Deploy)(\s|$)` — the Deploy workflow deploys
  production. A merge to `main` runs it; a manual run is the maintainer's.
- `^((pnpm|npm|npx)\b.*\slocal:env|node\b.*local-env\.mjs)\b.*\s--force\b` — rewrites the env files
  with a new `CONNECTIONS_KEY`, which makes the sign-ins sealed under the old one unreadable. Run
  `pnpm local:env` without `--force`; it fills only missing files.
- `^((npx|bunx|npm exec|pnpm (dlx|exec))( -y| --yes)? )?skills(@\S+)? update\b` — `npx skills update`
  leaves `.claude/skills/` linked to its source instead of copied. Re-run the `npx skills add`
  commands in `AGENTS.md`, then `pnpm sync:agents`.
- `^(taskkill\b.*\s[/-][iI][mM]\s+workerd|stop-process\b.*\s-[nN]ame\s+workerd|(pkill|killall)\b.*\sworkerd)\b` — stopping
  `workerd` by image name stops every project's Worker. Stop the PID listening on the Worker's own
  port (8787, 8788).

## Ask commands

- `\bsupabase stop\b` — the local stack stays up unless the user asks.

## Protected paths

- `^private/` — the companion, an independent repository.
- `^apps/(api|pages)/\.dev\.vars$` — local keys, including this machine's `CONNECTIONS_KEY`; a new
  key makes the sign-ins sealed under the old one unreadable.
- `(^|/)\.env(\.(?!example$)[^/]+)?$` — local keys, including `apps/web/.env.local`; only
  `.env.example` is tracked.
- `^supabase/\.temp/` — the `supabase link` state for the hosted project; recreating it needs the
  maintainer's access token and database password.
- `^supabase/\.branches/` — local Supabase CLI state.
- `^node_modules/` — every check runs from it.
- `^\.claude/settings\.local\.json$` — the contributor's own Claude Code settings.
