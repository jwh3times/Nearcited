# Changelog

Every merge to `main` is a release: it is tagged `v<major>.<minor>.<build>`, and its section below
names the version it mints. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html), with the patch number
counting builds on a release line.

## [Unreleased]

No unreleased changes.

## [1.0.4] - 2026-11-03

### Fixed

- Every Supabase CLI command now runs one pinned version, a dev dependency of the root package:
  the documented commands, `pnpm local:env`, CI and the Deploy workflow, which applies the
  migrations to the hosted project. Before, each fetched the newest CLI, so a release that changed
  a default, as 3.0.0 did when it made the local stack the default target, reached developers'
  machines and production without a pull request. A newer CLI now arrives only through one.
- `pnpm db:types` runs from a fresh install, in the form the CLI accepts, and formats the types it
  writes so they pass the lint check. It needs the local stack running.

## [1.0.3] - 2026-11-03

### Changed

- Dependency updates from Dependabot: `resend` 6.35.0 to 6.37.0, and `@cloudflare/workers-types`
  5.20261030.1 to 5.20261031.1.

## [1.0.2] - 2026-11-03

### Changed

- The changelog check and the merged-migration check are now required to merge a pull request,
  and the README's Repository automation section says so.

## [1.0.1] - 2026-11-03

### Fixed

- The Deploy workflow reaches the hosted database over IPv4, through the project's shared pooler.
  GitHub's runners have no IPv6, so every Deploy since 1.0.0 stopped before applying a migration
  or deploying anything.

## [1.0.0] - 2026-11-03

The first versioned release. Nearcited had deployed to production since October 2026 without
version numbers; from this release on, every merge to `main` is tagged, recorded here, migrated and
deployed.

### Added

- Every merge to `main` is tagged with the next version and released on GitHub.
- The Deploy workflow runs after each merge is tagged: it lists the migrations the hosted project
  has not applied, applies them, and only then deploys both Workers. A failed migration stops the
  deploy. It can still be run by hand.
- CI fails a pull request that edits, renames or deletes a migration already on `main`, since the
  hosted project never applies it again (`scripts/check-migrations.mjs`).
- CI checks that `CHANGELOG.md` has a section for the version a pull request's merge will mint
  (`scripts/check-changelog.mjs`); a Dependabot merge gets its section on the next human pull
  request.

[Unreleased]: https://github.com/jwh3times/Nearcited/compare/v1.0.4...HEAD
[1.0.4]: https://github.com/jwh3times/Nearcited/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/jwh3times/Nearcited/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/jwh3times/Nearcited/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/jwh3times/Nearcited/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jwh3times/Nearcited/releases/tag/v1.0.0
