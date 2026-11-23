### Changed

- `AGENTS.md` fits Codex's 32 KiB instruction budget again (46,920 bytes down to 20,757), so a
  Codex session reads the whole file instead of silently losing its end, the MCP servers and Agent
  skills among it. Twenty-one area rules moved, word for word, into seven files under
  `docs/agents/`: `billing.md`, `accounts.md`, `connections.md`, `actions-and-drafts.md`,
  `scan-results.md`, `sites-and-pages.md` and `review-requests.md`. They bind like the rules left
  in `AGENTS.md`, whose new "Area rules" list says before which work to read each. The Doc map in
  `docs/agents/docs.md` records the 30,000-byte limit and the new files, and the `/ship` rule
  triggers, `docs/architecture.md`, the README and `CONTRIBUTING.md` point at them. No application
  behavior changes.
