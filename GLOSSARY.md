# Glossary

The words this project uses with one fixed meaning. `docs/architecture.md` describes how the
system works; this file only settles vocabulary.

- **Shareable audit** (or **audit**): a one-off report for a business that has not signed up. A
  few prompts, each asked several times on every assistant in one go, read at `/audit/<token>` by
  anyone holding the link. Not a scan: it belongs to no organization and has no history.
- **Audit cell**: one prompt on one assistant within an audit, over every time it was asked: how
  many answers, how many named the business, and where.
- **Sample**: one asking of a prompt on one assistant. An audit takes several at once; a tracked
  location takes one per scan and counts them over the scan window.
- **Audit token**: the 64-character random string in an audit's link. Holding it is the only
  permission to read the audit. See `docs/adr/0002-audits-are-read-by-token.md`.
- **Source**: a site an assistant cited in an answer. Counted per answer, with how many of the
  answers that cited it named the business. It says nothing about what the site's pages contain.
