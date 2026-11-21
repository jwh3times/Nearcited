### Changed

- Each merge's changelog section is now written when the merge is tagged, not on its branch
  (#329). A branch writes its entries to its own `changelog.d/<branch-slug>.md` fragment and never
  edits `CHANGELOG.md`. After each merge, `.github/workflows/version.yml` turns the merge's
  fragments, or its pull request's title when it has none, into its dated section, tags the merge
  commit, pushes both with the release GitHub App's token in a `[skip ci]` commit, and creates the
  GitHub release with the section as its notes. Pull requests no longer renumber their sections
  after each other's merges, a Dependabot pull request no longer turns the next one's changelog
  check red, and its merge gets a section of its own. The Deploy workflow still deploys the merge
  commit, never the stamp commit. ADR 0034 records the move, and `docs/agents/releases.md`,
  `merging.md`, `dev-flow.md`, `docs.md`, the README and `AGENTS.md` describe it. The section for v1.7.15, a Dependabot merge, is backfilled.
