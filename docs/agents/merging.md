# Merging

From an open pull request to a finished merge and deploy. A merge to `main` deploys production,
migrations first; what an agent may never run is in [workspace](workspace.md#dev-stack).

## Merging

- **The maintainer says when to merge**, and `gh pr merge <n> --merge` is allowed when asked. The
  merge's Version tag and Deploy run follow on their own; watching them and reading the Deploy log
  is the agent's part. Running a hosted push or the Deploy workflow directly is not: hand those to
  the maintainer.
- **Merge several PRs in changelog-version order.** First the PR whose `CHANGELOG.md` section claims
  the next version; wait for its `v*` tag (`git tag --points-at origin/main`) before the next merge,
  or that PR's changelog check breaks and needs a re-ship.
- **`main` requires up-to-date branches**, so every other open PR then shows `BEHIND`:
  `gh pr update-branch <n>`, wait for its checks to pass again (about five minutes), then merge.
- **A Dependabot PR catches up with `@dependabot rebase`**, never `gh pr update-branch` or a merge of
  `main`: those put a human-authored commit at the branch tip, and `ship`'s changelog backfill
  credits a version to the bot only when the merged branch's author is `dependabot[bot]`. Comment
  `gh pr comment <n> --body "@dependabot rebase"`, wait for the head sha to change and CI to rerun,
  then merge. A Dependabot merge mints a version with no changelog section, which the next `/ship`
  backfills.

## Reading CI

- **A check can stick at pending after its run finished.** The required changelog check sat at
  `pending` for 15 minutes while `gh run view <id>` said the run had succeeded. Read
  `gh run view <id> --json status,conclusion,jobs` and the log before waiting longer; if the job
  finished, `gh run rerun <run-id>` gives a real result within a minute. To wait for a release, watch
  for the tag and the Deploy run, not the Version run's listed status.
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
