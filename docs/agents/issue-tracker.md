# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `jwh3times/Nearcited`. Use the `gh` CLI for all operations.
Sequencing lives on the [project board](#project-board).

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Project board

[Nearcited](https://github.com/users/jwh3times/projects/10) (project 10, owner `jwh3times`) holds every
open issue. The issue is the record; the board is a view of all of them with three fields that
carry the sequencing. The board is private. [Build order](https://github.com/jwh3times/Nearcited/issues/15)
shows the same order to public readers, so move an issue in its task list when its `Stage` changes.

| Field    | Options                                                                                                                                                              | Meaning                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `Status` | Todo, In Progress, Done                                                                                                                                              | Closing an issue sets Done. Set In Progress by hand when work starts.      |
| `Stage`  | 1 - Make it real, 2 - Find out whether anyone wants it, 3 - Safe for someone else to use, 4 - Sellable, 5 - Rounding out, Decisions and upkeep                       | The order to build in. Lower stages first.                                 |
| `Gate`   | None, Owner decision, Owner action, External                                                                                                                         | What must happen outside the code before the item can finish.              |

- **Owner decision**: the owner has to choose something first (a vendor, a price, where code lives).
- **Owner action**: the owner has to do something an agent cannot (create an account, set a secret,
  change a repository setting).
- **External**: waiting on a third party.

What blocks what is recorded as native issue dependencies, described under
[Wayfinding operations](#wayfinding-operations), and never in a board field.

**The frontier**, what to build next: open items in the lowest stage that have no open blocker and a
`Gate` of None.

Commands. Read field and option IDs each time; they are not stable enough to write down.

- **List items**: `gh project item-list 10 --owner jwh3times --format json`
- **Fields and option IDs**: `gh project field-list 10 --owner jwh3times --format json`
- **Add an issue**: `gh project item-add 10 --owner jwh3times --url <issue-url> --format json -q .id`
- **Set a field**: `gh project item-edit --project-id <project-id> --id <item-id> --field-id <field-id> --single-select-option-id <option-id>`.
  The project ID is `gh project view 10 --owner jwh3times --format json -q .id`.

Every new issue goes on the board with all three fields set, in the same session that opens it.

## Pull requests as a triage surface

**PRs as a request surface: no.** Outside pull requests are not merged (see `CONTRIBUTING.md`), and Dependabot is the only routine pull request author, so `/triage` works on issues only.

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
