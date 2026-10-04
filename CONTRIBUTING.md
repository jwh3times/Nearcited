# Contributing

## Bugs and ideas

Open an issue. For a bug, say what you did, what you expected, and what happened.

Security problems go through a private report instead. See [SECURITY.md](SECURITY.md).

## Code

Pull requests from outside contributors are not being accepted yet. The terms under which
outside code would be contributed have not been decided, and merging it first would close off
options later. If you want to work on something, open an issue to talk about it.

## Working on the code

Setup is in the [README](README.md). Before pushing:

```sh
pnpm check
```

That runs lint, typecheck, every unit test and the build. The rules a change has to follow are in
[CLAUDE.md](CLAUDE.md), and the reasoning behind them is in
[docs/architecture.md](docs/architecture.md).
