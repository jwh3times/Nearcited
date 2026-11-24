# Merging

From an open pull request to a finished merge and deploy. A merge to `main` deploys production,
migrations first; what an agent may never run is in [workspace](workspace.md#dev-stack).

## Merging

- **The maintainer says when to merge**, and `gh pr merge <n> --merge` is allowed when asked. The
  merge's Version tag and Deploy run follow on their own; watching them and reading the Deploy log
  is the agent's part. Running a hosted push or the Deploy workflow directly is not: hand those to
  the maintainer.
- **Open PRs merge in any order.** No branch names a version: each carries a `changelog.d/`
  fragment, and the Version workflow stamps the merge's section and tags it
  (`docs/agents/releases.md`), so catching up never touches the changelog.
- **`main` requires up-to-date branches**, so every other open PR then shows `BEHIND`:
  `gh pr update-branch <n>`, wait for its checks to pass again (about five minutes), then merge.
  Merge it once the previous merge's stamp commit, `chore(release): v<x.y.z> [skip ci]`, is on
  `main` (`git log -1 origin/main`): an update made before it lands leaves the PR behind again.
- **A Dependabot PR catches up with `@dependabot rebase`**, never `gh pr update-branch` or a merge of
  `main`: a merge commit pushed to its branch stops Dependabot from rebasing it later. Comment
  `gh pr comment <n> --body "@dependabot rebase"`, wait for the head sha to change and CI to rerun,
  then merge. It writes no fragment, and its merge gets a section from its PR title.
- **`@dependabot rebase` can go unanswered.** Dependabot reacts to a command it takes within about a
  minute; with no reaction after a few minutes, post it once more. It may instead close the PR
  ("Looks like these dependencies are updatable in another way") and open a replacement that is
  already current with `main` and may carry more bumps: merge the replacement, after reading its
  diff again for new packages.

## Reading CI

- **A check can stick at pending after its run finished.** The required changelog check sat at
  `pending` for 15 minutes while `gh run view <id>` said the run had succeeded. Read
  `gh run view <id> --json status,conclusion,jobs` and the log before waiting longer; if the job
  finished, `gh run rerun <run-id>` gives a real result within a minute. To wait for a release, watch
  for the tag (`git tag --points-at <merge sha>`) and the Deploy run, not the Version run's listed
  status. A Version run that found `main` moved succeeds with the notice "main moved during this
  run" and tags nothing: its merge still deploys, and the run after it tags it.
- **CodeQL skips a Dependabot PR.** Its `Analyze` jobs do not run and the `CodeQL` check reports
  `skipping`; the PR still shows `CLEAN` and merges. On a human PR it runs.
- **A failure before any test ran is the runner's.** "End-to-end in a browser" failing at
  `supabase start` with `address already in use` on 54322 passed on `gh run rerun <id> --failed`.
  Read `gh run view <id> --log-failed` first.
- **`packages/shared`'s `test/drafts.test.ts` can time out at 5 s in a full `pnpm check` under load**
  and pass alone (`pnpm --filter @nearcited/shared exec vitest run test/drafts.test.ts`). When only
  that file fails that way, run it alone, rerun `pnpm check`, and name it as a known flake in the PR.
  If it fails alone or in CI, it is a bug.

## Production steps

When a task needs a hosted change (a migration push, a Deploy run), run what is read-only yourself
(`pnpm exec supabase db push --dry-run --remote`, `pnpm exec supabase migration list --remote`),
then give the maintainer the exact commands to run, one short command per block so a wrapped paste
or a failed first step can't run the rest, then verify the result and record it on the issue. Always
pass `--remote` to a hosted command, and read the `Target:` line of any Supabase command before
believing its output: a bare command targets a local stack, which on a shared machine can be another
project's. A login stored on the machine means a hosted command can act with no credentials in the
environment, so a missing variable is no safeguard.

## Dependabot catch-up

`gh pr comment <n> --body "@dependabot rebase"` — never `gh pr update-branch`, whose merge commit
stops Dependabot from rebasing the PR later (see "Merging" above).

## Deploys

- `deploy.yml` — runs on `workflow_run` of Version, so its run lists `main`'s tip when Version
  finished, normally the stamp commit's sha, not the merge's; it still checks out and deploys the
  merge. It applies the merge's migrations, then deploys both Workers.
