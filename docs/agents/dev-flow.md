# Development flow

The flow itself is `.agents/skills/ship/settings/dev-flow.md`, and `AGENTS.md` summarizes it. This file holds what this repository
adds.

## Commit subjects

The branch's type is for the branch only; commit subjects stay plain sentences in the imperative, with
no type prefix.

## Exemption details

- **Dependency bumps** by hand change only versions in `package.json` files and `pnpm-lock.yaml`. The
  edits a bump needs to pass `pnpm check` travel with it, as on #233.

## Release prep

A commit that only readies a release: the `CHANGELOG.md` section for the version the merge mints,
and, for a new major or minor line, the root `package.json` `version`. Every merge to `main` is a
release: the Version workflow tags it, and the Deploy workflow applies its migrations and deploys it
(`docs/agents/releases.md`). A merge is therefore a production deploy, and a migration in it reaches
the hosted project before its Worker does.

## Linking

A slice that also finishes its own ticket names both: `Closes #141. Part of #202.` The merge closes
the issue and the project board moves it to Done.
