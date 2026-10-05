# Nearcited

The engineering contract for every coding agent in this repository. `CLAUDE.md` imports this file;
Codex reads it directly. Project rules live here and nowhere else.

Local-visibility tracker: one Cloudflare Worker (Hono API, cron, queue consumer), a React app it
serves as static assets, Supabase for Postgres and auth. Read `docs/architecture.md` before
changing how scans run or how data is accessed.

## Commands

- `pnpm check`: lint, typecheck, test, build. Must pass before a change is done.
- `pnpm format`: apply Biome fixes.
- `pnpm --filter @nearcited/<api|web|shared|db> test`: one package's tests.
- `pnpm dev`: Worker on 8787, Vite on 5173.
- `npm run bootstrap:private`: clone the private companion into `private/` (maintainers only).
- `npm run sync:main`: fast-forward `main` here and in `private/`. Refuses a dirty tree.
- `pnpm sync:agents`: regenerate `.claude/skills` and `.codex/agents` after changing anything in
  `.agents/skills` or `.claude/agents`.

## Private companion

`private/` is gitignored here and is a separate, confidential repository for authorized
maintainers. A public clone does not have it, and everything in this repository must install,
pass `pnpm check` and run in mock mode without it.

- **What lives there:** provider prompt text, sampling and score weights; pricing, vendor quotes
  and measured costs by vendor; anything naming a real customer or prospect; security review
  findings; deployment runbooks. `private/README.md` is its index and says what each file owns.
  Read it before working there.
- **Nothing from `private/` is copied into this repository**, including into issues, pull
  requests, commit messages and docs. A public document may say a private one exists.
- **This repository never names the private one.** Its locator lives in 1Password and
  `scripts/bootstrap-private.mjs` reads it at run time. Keep it out of every tracked file.
- **Commit and push the two repositories independently.**
- If `private/` is absent and the task needs it (writing a provider's prompts, pricing a plan),
  stop and ask the user to run `npm run bootstrap:private`.
- How the Worker build consumes code kept there is not decided yet; issue #25 owns it. Until
  then `private/` holds documents only, and no code here imports from it.

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
- **The code is AGPL-3.0-only and the repo is public.** A new dependency must be under a license
  that can be combined with it; MIT, ISC, BSD, Apache-2.0 and MPL-2.0 are fine, anything else
  needs checking first. Outside pull requests are not merged (see `CONTRIBUTING.md`).
- No secrets in the repo. Local values go in `apps/api/.dev.vars` and `apps/web/.env.local`, both
  gitignored.

## Agent skills

The skills come from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, see
`THIRD_PARTY_NOTICES.md`) and are pinned in `skills-lock.json`.

- **`.agents/skills/` is the source.** The skills installer writes there and Codex reads it.
  `.claude/skills/` is a generated copy for Claude Code; each generated `SKILL.md` says so on its
  second line. Never edit `.claude/skills/` by hand.
- **After installing, updating or editing a skill, run `pnpm sync:agents` and commit the result.**
  CI runs `pnpm sync:agents:check` and fails if the copy is stale.
- **Install or update with the installer**, so the lock file stays right:
  `npx skills add mattpocock/skills -a codex -s <name> --copy -y`, or `npx skills update -p -y`.
- **Four skills are this repository's own** and are not in the lock file: `ship` (rule check, doc
  refresh, `pnpm check`, PR), `end-session` (record what a session learned, then clean up),
  and `handoff` with `lets-go` (pass a session to another machine through the Proton Drive
  Handoffs folder). Edit them in `.agents/skills/`. When a project rule, a required check or a
  document's job changes, update `ship` to match.
- `scripts/sync-agents.mjs` and its test are shared verbatim with other repositories. Do not edit
  them here.
- **Agents run the other way: `.claude/agents/*.md` is the source** and `.codex/agents/*.toml` is
  generated by the same sync. There is one, `docs-updater`, which holds the table of which
  document owns which fact. Run it, or read its file and follow it, whenever a change touches a
  route, table, environment variable, command, scan behaviour, CI check or project rule. `/ship`
  and `/end-session` both call it.

### Issue tracker

Issues live in GitHub Issues, through the `gh` CLI: public work in `jwh3times/Nearcited`,
confidential work in the private companion's tracker. Every open issue from both is on the
Nearcited project board (project 10), whose `Stage` and `Gate` fields carry the sequencing. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five default labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`), all of which exist in the tracker. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root, both created when the first
term or decision is settled. See `docs/agents/domain.md`.
