# Releases

## Scheme

per-merge — every merge to `main` is a release. `.github/workflows/version.yml` tags it
`v<major>.<minor>.<build>` from the root `package.json`, each merge's dated `CHANGELOG.md` section
names the version it mints, and the Deploy workflow then applies its migrations and deploys it
(`docs/agents/dev-flow.md`, "Release prep"). The workspace packages stay at `0.1.0`: only the root
`package.json` carries the release line.

## Ask before bumping

only when the release level is ambiguous

## Release commit message

`Bring the docs and changelog up to date for v<version>` — overrides the default,
`docs: update docs and changelog for v<version>`, because commit subjects here are plain imperative
sentences with no type prefix (`docs/agents/dev-flow.md`, "Commit subjects").
