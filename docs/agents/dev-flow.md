# Development flow

How work reaches a code change here: which flow skill to route the user to, which changes skip
the gate, and how a branch and a pull request name their issue. The gate itself, and the rule that
the human starts every phase, are in `AGENTS.md` under "Development flow".

`/ask-matt` (`.agents/skills/ask-matt/SKILL.md`) is the map of the whole flow and of the phase
boundaries; read it rather than this file when the question is "what comes after this?". It also
names `/implement-spec`, `/pr` and `/retro`, which this repository has not installed: route around
them.

## Routing

With no ready issue in hand, stop before the first edit, find the user's situation below, name
the command and say in one line why.

| The user has…                                    | Route                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| an idea one session can hold                     | `/grill-with-docs`, then `/to-spec`; add `/to-tickets` when the build spans sessions  |
| a huge, foggy effort that spans many sessions    | `/wayfinder`, then `/to-spec` once the map clears                                     |
| a raw issue someone else filed                   | `/triage`                                                                             |
| a ready issue nobody has started                 | `/clear`, then `/implement #N` in the fresh context                                   |
| something broken                                 | a bug issue (labelled `bug`) first, then `/diagnosing-bugs` against it                |

A ready issue carries `ready-for-agent` and either is a `/to-spec` spec or a `/to-tickets` ticket
in its body, or carries a `/triage` agent brief, which `/triage` posts as a comment. A bug worked
through `/diagnosing-bugs` needs the issue's number, not a spec. An issue that is
`ready-for-human`, `needs-triage` or `needs-info`, or has no triage label, is not ready.

The issue a public branch works from is a public one. Work tracked only in the private tracker
gets a public issue for its plumbing first (see "Which tracker" in
[`issue-tracker.md`](issue-tracker.md)).

`/prototype` and `/research` are exploration, not a change bound for `main`: a prototype lives on
its own `prototype/<name>` branch, research is a Markdown file. Either may run inside
`/grill-with-docs` or `/wayfinder` before any issue exists.

## Exemptions

The gate covers changes to code. A change touching only these paths is **docs and agent
config**, and exempt:

- the Markdown at the root: `README.md`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`,
  `SECURITY.md`, `GLOSSARY.md`
- `docs/`, including `docs/adr/` and `docs/agents/`
- `.agents/`, `.claude/`, `.codex/` and `skills-lock.json`
- `.github/pull_request_template.md`

Everything else is code: `apps/`, `packages/`, `supabase/`, `scripts/`, `.github/workflows/`,
`.github/dependabot.yml` and the root build config (`package.json`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`). A change touching both is code.

The other exemptions:

- **Dependency bumps.** Dependabot's pull requests, and a bump made by hand that changes only
  versions in `package.json` files and `pnpm-lock.yaml`. The edits a bump needs to pass
  `pnpm check` travel with it, as on #233.
- **Release prep.** A commit that only readies a release, such as a version number or a
  changelog. This repository keeps neither and deploys by running the Deploy workflow, so this
  rarely applies.
- **The user's waiver.** The user says, in this session, to skip the flow for this change. The
  pull request body opens with `Flow waived by the user: <reason>`, in their words.

## Linking work to its issue

**Branch:** `<type>/<issue#>-<slug>`, made from `main` before the first edit, since `/implement`
commits to the current branch. The type is one of `feat`, `fix`, `refactor`, `docs` or `chore`:
`feat/149-standing-permission`, `fix/6-stuck-scans`. An exempt change with no issue drops
the number: `docs/dev-flow`, `chore/bump-wrangler`. Dependabot's branches keep their own names.
The type is for the branch only; commit subjects stay plain sentences (see `/ship`).

**Pull request body:** its first line names the issue.

- `Closes #N` when the branch finishes issue N. The merge closes it and the project board moves
  it to Done.
- `Part of #N` when the branch is one slice of a spec that stays open, as each stacked step of a
  spec is: `Part of #202`. A slice that also finishes its own ticket names both:
  `Closes #141. Part of #202.`
- Each issue gets its own keyword: `Closes #104, closes #210`. GitHub links only the first issue
  of `Closes #104 and #210`.

A number in the pull request title alone links nothing.
