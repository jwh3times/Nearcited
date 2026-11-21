---
status: accepted
---

# A merge's changelog section is written when it is tagged

Every merge to `main` is a release, tagged `v<major>.<minor>.<build>`, and `CHANGELOG.md` gives each
one a dated section. No decision recorded how that section was written. Until issue #329 each branch
wrote it itself, for the version `scripts/next-version.mjs` predicted its merge would mint, and the
`Changelog names the version this merge mints` check held it to that prediction. A prediction
holds only until something else merges. Every merge renumbered every open pull request's section,
so branches shipped one at a time; a Dependabot merge minted a version with no section, which the
next human pull request had to backfill before its own check passed. Issue #329 moved the
repository to the `stamp-on-tag` scheme of `jwh3times/skills`, which holds its canonical scripts.

**A branch writes a fragment and names no version.** `/ship` writes the branch's entries to its own
`changelog.d/<branch-slug>.md`, which holds only category headings and their entries, and never
edits `CHANGELOG.md`. The changelog check now fails a pull request that adds, removes or renumbers a
section, adds entries to `Unreleased`, changes a fragment another merge added or adds one that does
not parse. A pull request may write no fragment, Dependabot's included, which run the same check
with no exemption. The check keeps its name, which the ruleset requires, though it no longer
predicts a version.

**The section is written after the merge, with its tag.** On each push to `main`, the Version
workflow runs `scripts/stamp-changelog.mjs`, which takes each untagged merge oldest first: its
section is the fragments it added, or, with none, one entry from its pull request's title; its
version is the computation `next-version.mjs` made before, from the root `package.json`'s release
line at that merge and the tags so far, now made once over the merges in the order they landed. It
writes the sections into one commit, `chore(release): v<x.y.z> [skip ci]`, deletes the fragments it
used, and tags each merge commit, not the stamp commit, so a tag is exactly the code its merge
deployed. Each GitHub release's notes are its section.

**The stamp commit reaches `main` through the release GitHub App.** The ruleset lets no one push to
`main`; `GITHUB_TOKEN` cannot be a bypass actor, so the workflow pushes with a token from the release
App, which the ruleset lists as its bypass. The commit and the tags go in one atomic push. The stamp
commit's subject is the canonical script's, with a type prefix this repository's own commit subjects
do not use. Every first-parent commit on `main` is a release, so merging stays by merge commit only.

**Nothing deploys a stamp commit.** `[skip ci]` keeps the App's push from starting CI or the Version
workflow, and the Deploy workflow runs only when a Version run succeeds, so no deploy is for a stamp
commit. Deploy checks out the commit that Version run was for, the merge, rather than `main`'s tip,
which by then is the stamp commit. Nothing outside GitHub Actions deploys from the repository.

**When `main` moves during a Version run, the next run releases both merges.** Runs share a
concurrency group that never cancels the one running. A run whose push is refused as
non-fast-forward has lost nothing: the run waiting behind it starts from the new tip and stamps and
tags both merges. That refusal alone is benign, so the run still succeeds, and its merge deploys,
migrations first, before its tag arrives a minute or two later. Any other refusal fails the run,
and its merge does not deploy. Three merges close together can still leave a waiting run cancelled
by the next one, as before the move; the next run then stamps and tags that merge too, and its
deploy carries the cancelled one's migrations and code.

Rejected: keeping the prediction and serializing merges, which was the problem; a release workflow
that writes the section and the version into a pull request of its own, which would double every
merge and leave `main` untagged until that one merged; and tagging the stamp commit, whose tree is
not what CI tested.
