# Releases

## Scheme

stamp-on-tag — every merge to `main` is a release. Each branch's changelog entries live in its own
`changelog.d/<branch-slug>.md` fragment; after the merge, `.github/workflows/version.yml` stamps
them into the merge's dated `CHANGELOG.md` section and tags the merge commit
`v<major>.<minor>.<build>` from the root `package.json`, and the Deploy workflow then applies its
migrations and deploys it (`docs/agents/dev-flow.md`, "Release prep";
`docs/adr/0034-a-merges-changelog-section-is-written-when-it-is-tagged.md`). The workspace packages
stay at `0.1.0`: only the root `package.json` carries the release line.

## Ask before bumping

only when the release level is ambiguous

## Release commit message

`Bring the docs and changelog fragment up to date` — overrides the default,
`docs: update docs and changelog fragment`, because commit subjects here are plain imperative
sentences with no type prefix (`docs/agents/dev-flow.md`, "Commit subjects"). The stamp commit
`version.yml` makes keeps the canonical script's `chore(release): v<x.y.z> [skip ci]`.
