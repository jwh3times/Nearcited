### Added

- `docs/agents/dependabot.md` holds what the shared `/dependabot` skill needs to review a
  Dependabot pull request here: the pnpm install to reproduce, where each dependency is used, the
  facts about this stack a review must not get wrong (the Version and Deploy workflows run only
  after a merge, so a green PR says nothing about the actions and Supabase CLI commands only they
  run), and the gates and known fixes for each kind of bump, including the `@anthropic-ai/sdk`
  request-URL assertion that a minor once broke. The Doc map lists it.
