---
# GENERATED — do not edit. Source: .agents/skills/end-session/SKILL.md — regenerate with 'node scripts/sync-agents.mjs'.
name: end-session
description: Close out a work session — harvest what was learned into memory, GitHub issues and the project board, check the docs for drift, then clean the local workspace. Use when the user says they are done for the day, wants to wrap up or end the session, or asks to clean up and record what this session found.
---

# End session

**Announce at start:** "I'm using the end-session skill to close out this session."

A session's durable value is the part that survives it. This skill **routes** each
thing the session learned to the one place that owns it, and it harvests first and
deletes last, so cleanup never destroys evidence that has not been recorded.

Shipping code is `/ship`'s job. When the branch has undelivered work, name it in
the report and let the user call `/ship`.

## Steps

### 1. Harvest: inventory the session before touching anything

Re-read the session and write a flat list of everything it produced that a future
session would want: decisions made, facts verified against real data, dead ends
and why they were dead, work started, work discovered but not started, surprises
that contradicted a doc, and every action only the user can take.

Include the scratch surfaces, because step 5 clears them:

- the OS temp scratchpad this session wrote to
- untracked files in the tree (`git status --porcelain -uall`)
- output from research or verification runs, especially a measured cost per
  check or a provider's real response shape

**Done when:** every item is written down and routed in step 2. An item you cannot
route is one you do not yet understand; say so in the report.

### 2. Route every item to exactly one home

One fact, one owner. A fact in two places means the next session reads a stale
copy of it somewhere.

| The item is…                                                                | Home                                                                                                                              |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| How the user works, a standing preference, a gotcha no file records         | Memory (step 3)                                                                                                                   |
| A discrete piece of work someone should pick up                             | A GitHub issue (step 3)                                                                                                           |
| A change to what gets built first, what gates an item, or what blocks it    | The [project board](https://github.com/users/jwh3times/projects/10) (step 3): `Stage`, `Gate`, and a blocking link between the issues                |
| A repository setting or a decision only the owner can make                  | A checkbox in [#17](https://github.com/jwh3times/Nearcited/issues/17), or its own issue labelled `ready-for-human` if it is large |
| An answer to an open product question                                       | A comment on the issue that asks it (#14 for what a recommendation working means)                                                 |
| Implemented behaviour, setup steps, a known gap closed or found, a new rule | Public docs, through the `docs-updater` agent (step 4)                                                                            |
| A prompt, weight, price, vendor quote, measured cost by vendor, or anything naming a real business | `private/`, indexed in `private/README.md` (step 3)                                              |
| Confidential work someone should pick up                                    | An issue in the private tracker (step 3)                                                                                          |
| A settled domain term or a durable architecture decision                    | `GLOSSARY.md` or `docs/adr/`, through `/domain-modeling`                                                                          |

Whatever the repository already records (code, git history, a merged PR) is
already recorded. Skip it.

This repository is public. A customer's or prospect's business name, pricing,
vendor quotes, prompts and weights go to `private/` or the private tracker, and
the public issue gets only the conclusion that is safe to publish. Keys go in
neither repository; they live in 1Password. When `private/` is absent, ask the
user to run `npm run bootstrap:private`, and if they decline, list in the report
what could not be recorded.

### 3. Update GitHub issues, the board and memory

**Issues.** Command forms are in
[`docs/agents/issue-tracker.md`](../../../docs/agents/issue-tracker.md) and the
labels in [`docs/agents/triage-labels.md`](../../../docs/agents/triage-labels.md).
Confirm `gh auth status`, then for this session:

- **Resolved**: comment with what resolved it (the PR number) and close. A merged
  PR whose body said `Closes #N` has done this already.
- **Advanced but open**: comment with the current state and what unblocks it, so
  the issue stands alone without this transcript.
- **New work discovered**: open an issue in the shape the existing ones use
  (Why, Scope, Done when, Depends on), and label it `bug` or `enhancement` plus
  one triage label.

An issue states its own question. Relationships go in blocking links, where
GitHub shows the other issue's state live.

**Board.** The field names, option lists and commands are in the
[project board section](../../../docs/agents/issue-tracker.md#project-board) of
the issue tracker doc. For this session:

- Add every issue opened above, and set its `Status`, `Stage` and `Gate`.
- Set `Status` to In Progress for work started and left open. Closing an issue
  moves it to Done without help.
- Correct `Stage`, `Gate` and the blocking links wherever the session proved the
  sequencing wrong. The frontier, what to build next, is computed from them:
  open items in the lowest stage with no open blocker and a `Gate` of None.
- When a stage changes, move the issue in the
  [Build order](https://github.com/jwh3times/Nearcited/issues/15) task list too.
  The board is private; that issue is the same order for public readers.

**Private docs.** Write each private item to the file `private/README.md` says
owns that kind of fact, or to a new file with a row added to that index in the
same commit. Commit and push in `private/` on its own: it is a separate
repository, and nothing there rides along with a public commit. For a private
issue, run `gh` from inside `private/` so it targets that tracker, and never
reference it from a public issue or pull request.

**Memory.** One fact per file in the per-project memory directory (its path is in
the memory section of your system prompt), with a one-line pointer in `MEMORY.md`.
Before writing, read the memory whose subject overlaps and update it. Delete
memories this session proved wrong. Use absolute dates.

**Done when:** an issue reader with no access to this session knows the current
state, every open issue is on the board with all three fields set, and
`MEMORY.md` has one live pointer per fact.

### 4. Check the docs for drift

Dispatch the `docs-updater` agent, scoped to what this session changed. Where
the harness cannot dispatch an agent, read
[`.claude/agents/docs-updater.md`](../../../.claude/agents/docs-updater.md) and
follow it yourself. Take the first branch that applies:

- **The session changed no code, config or workflow**: skip this step.
- **On a feature branch with work not yet merged**: **fix** mode, scoped to
  `$(git merge-base origin/main HEAD)..HEAD` plus the uncommitted changes. Its
  edits stay in the working tree for step 5, which asks the user about them with
  the rest. `/ship` runs the same agent again before the PR, so nothing is lost
  if they wait.
- **The session's work is already merged, or it changed only GitHub settings**:
  **check** mode, scoped to the merged commits or a description of the settings
  changed. `main` takes changes only by pull request, so for each drift found
  open an issue labelled `documentation` and `ready-for-agent`, or one issue
  listing them all when they are small, and add it to the board.

**Done when:** the agent's report is in hand, and every drift it found is an
edit in the working tree or an issue.

### 5. Clean the local workspace

Harvesting is done, so deleting is now safe.

**Uncommitted work first.** `git status --porcelain -uall`, here and again
inside `private/` when it is checked out. For each tracked
modification and each untracked file the session did not obviously generate, ask
the user whether to commit or discard.

**Then the known artifact paths.** Delete only these; they all regenerate:

```
apps/web/dist/   apps/api/dist/   apps/api/.wrangler/   coverage/   *.tsbuildinfo
```

The paths are enumerated because `git clean -X` would also take
`apps/api/.dev.vars`, `apps/web/.env.local` and `supabase/.temp/`, which are
gitignored and hold the local keys and the link to the hosted project.

**Local services.** Stop whatever this session started and nothing else:

- `pnpm dev` processes (the Worker on 8787, Vite on 5173).
- A PostgREST or Postgres container started for the store integration test
  (`docker ps`; the CI recipe names it `postgrest`).
- The local Supabase stack stays up unless the user asks. Stop it with
  `pnpm dlx supabase stop`, which keeps its data. `--no-backup` deletes the local
  database and needs an explicit request.

**Branch state.** Report it and leave it as it is: unpushed commits
(`git log --oneline @{u}..`, in both repositories), worktrees (`git worktree list`), and local branches
whose PR has merged (`gh pr list --head <branch> --state merged`; merged head
branches are deleted on GitHub automatically, so only the local copy remains).

**Done when:** `git status` shows only work the user chose to keep, and ports
8787 and 5173 are free unless the user wanted them left running.

### 6. Report

Give the user, in this order:

1. What was recorded and where: memory files, issues opened, commented on or
   closed, each by number, and board fields changed.
2. What the docs check found: files edited, or the issues opened for drift.
3. What was cleaned: paths removed, processes and containers stopped.
4. What is still open: unpushed commits, undelivered branch work, doc edits
   left uncommitted, actions only the user can take, and any harvested item
   you could not route.
