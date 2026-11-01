# Development flow

The flow itself is `.agents/skills/ship/settings/dev-flow.md`, and `AGENTS.md` summarizes it. This file holds what this repository
adds.

## `/ask-matt` here

`/ask-matt` also names `/implement-spec`, `/pr` and `/retro`, which this repository has not installed:
route around them.

## Commit subjects

The branch's type is for the branch only; commit subjects stay plain sentences in the imperative, with
no type prefix.

## Exemption details

- **Dependency bumps** by hand change only versions in `package.json` files and `pnpm-lock.yaml`. The
  edits a bump needs to pass `pnpm check` travel with it, as on #233.

## Release prep

A commit that only readies a release, such as a version number or a changelog. This repository keeps
neither and deploys by running the Deploy workflow, so this rarely applies.

## Linking

A slice that also finishes its own ticket names both: `Closes #141. Part of #202.` The merge closes
the issue and the project board moves it to Done.
