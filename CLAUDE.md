# CLAUDE.md

Claude Code adapter for this repository. `AGENTS.md` holds the project rules, commands and agent
skill setup. It is imported below; if the import does not resolve, read [`AGENTS.md`](AGENTS.md)
before starting. Where this file and `AGENTS.md` disagree, `AGENTS.md` wins.

@AGENTS.md

## Claude Code

- Skills load from `.claude/skills/`, which is generated from `.agents/skills/`. Edit the source
  and run `pnpm sync:agents`.
- `docs-updater` (`.claude/agents/docs-updater.md`) is a subagent here. Dispatch it instead of only
  reading its file.
