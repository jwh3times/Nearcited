# Changelog

Every merge to `main` is a release: it is tagged `v<major>.<minor>.<build>`, and its section below
names the version it mints. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html), with the patch number
counting builds on a release line.

## [Unreleased]

No unreleased changes.

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

[Unreleased]: https://github.com/jwh3times/Nearcited/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/jwh3times/Nearcited/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jwh3times/Nearcited/releases/tag/v1.0.0
