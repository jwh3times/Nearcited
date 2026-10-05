---
name: end-session
description: Close out a work session — harvest what was learned into memory and GitHub issues, then clean the local workspace. Use when the user says they are done for the day, wants to wrap up or end the session, or asks to clean up and record what this session found.
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

Include the scratch surfaces, because step 4 clears them:

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
| A change to what gets built first, or a new dependency between issues       | The task list in [Build order](https://github.com/jwh3times/Nearcited/issues/15), and a `Depends on` line in the dependent issue  |
| A repository setting or a decision only the owner can make                  | A checkbox in [#17](https://github.com/jwh3times/Nearcited/issues/17), or its own issue labelled `ready-for-human` if it is large |
| An answer to an open product question                                       | A comment on the issue that asks it (#14 for what a recommendation working means)                                                 |
| Implemented behaviour, setup steps, a known gap closed or found, a new rule | Public docs, which travel with the change through `/ship`: `README.md`, `docs/architecture.md`, `AGENTS.md`. Flag them in step 5. |
| A settled domain term or a durable architecture decision                    | `GLOSSARY.md` or `docs/adr/`, through `/domain-modeling`                                                                          |

Whatever the repository already records (code, git history, a merged PR) is
already recorded. Skip it.

The repository is public. Keys, a customer's or prospect's business name, pricing
and vendor quotes stay out of issues and docs; put the non-secret conclusion in the
issue and tell the user what was left out.

### 3. Update GitHub issues and memory

**Issues.** Command forms are in
[`docs/agents/issue-tracker.md`](../../../docs/agents/issue-tracker.md) and the
labels in [`docs/agents/triage-labels.md`](../../../docs/agents/triage-labels.md).
Confirm `gh auth status`, then for this session:

- **Resolved**: comment with what resolved it (the PR number) and close. A merged
  PR whose body said `Closes #N` has done this already.
- **Advanced but open**: comment with the current state and what unblocks it, so
  the issue stands alone without this transcript.
- **New work discovered**: open an issue in the shape the existing ones use
  (Why, Scope, Done when, Depends on), label it `bug` or `enhancement` plus one
  triage label, and add it to the Build order task list at the stage it belongs to.
- **A known gap found or closed**: the list under "Known gaps" in
  `docs/architecture.md` and "What is not built" in `README.md` are public docs;
  flag the edit for `/ship`.

An issue states its own question. Relationships go in task lists and
`Depends on #N`, where GitHub shows the other issue's state live.

**Memory.** One fact per file in the per-project memory directory (its path is in
the memory section of your system prompt), with a one-line pointer in `MEMORY.md`.
Before writing, read the memory whose subject overlaps and update it. Delete
memories this session proved wrong. Use absolute dates.

**Done when:** an issue reader with no access to this session knows the current
state, and `MEMORY.md` has one live pointer per fact.

### 4. Clean the local workspace

Harvesting is done, so deleting is now safe.

**Uncommitted work first.** `git status --porcelain -uall`. For each tracked
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
(`git log --oneline @{u}..`), worktrees (`git worktree list`), and local branches
whose PR has merged (`gh pr list --head <branch> --state merged`; merged head
branches are deleted on GitHub automatically, so only the local copy remains).

**Done when:** `git status` shows only work the user chose to keep, and ports
8787 and 5173 are free unless the user wanted them left running.

### 5. Report

Give the user, in this order:

1. What was recorded and where: memory files, and issues opened, commented on or
   closed, each by number.
2. What was cleaned: paths removed, processes and containers stopped.
3. What is still open: unpushed commits, undelivered branch work, public-doc
   updates owed to `/ship`, actions only the user can take, and any harvested item
   you could not route.
