# Releases

## Scheme

none — no `v*` tags, no GitHub Releases and no `CHANGELOG.md`; the pull request body is the record
of a change, and deploys run the manual Deploy workflow (`docs/agents/dev-flow.md`, "Release
prep"). Every `package.json` stays at `0.1.0`.

## Skipped tags

none

## Version file

none

## Bump command

none

## Ask before bumping

none

## Next-version command

none

## Changelog check

none

## Release commit message

`Bring the docs up to date for <summary>` — overrides the default,
`docs: update docs for <summary>`, because commit subjects here are plain imperative sentences
with no type prefix (`docs/agents/dev-flow.md`, "Linking work to its issue").
