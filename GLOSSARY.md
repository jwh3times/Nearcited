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
- **On-page check**: reading a business's own home page as an assistant's crawler would, without
  running scripts, and reporting a fixed list of pass or fail checks. See "The on-page check" in
  `docs/architecture.md`.
- **Action plan**: the ordered steps shown as "What to do next", composed by rule from the sources
  and the on-page check. A step states an observation; it does not promise a result.
- **Organization role**: what a person may do inside one organization: owner, admin or member.
  Whoever creates an organization is its owner. It says nothing about the product as a whole.
- **Platform role**: what an account is to Nearcited itself, apart from any organization. Most
  accounts have none. Never called "owner", which is an organization role.
- **Operator**: the platform role of the person who runs Nearcited.
- **Test account**: an account held by automation, not by a person, used to exercise the product.
  Its platform role is `test`.
- **Test organization**: an organization created by a test account. Its scans run on generated
  sample data and say so, and it is never a customer.
- **Plan**: something on sale: a monthly price and what an organization on it may do. An
  organization is on one plan, or on none when its limits were **set by hand**. See
  `docs/adr/0006-plans-are-rows.md`.
- **Included location**: a location a plan's price covers. An **extra location** is one beyond
  those, paid for separately.
- **Paused location**: a location its organization's plan no longer covers. It is not scanned and
  everything measured stays readable. Not the same as a location whose scans its owner turned off.
- **Set aside**: said of a prompt made inactive because the plan covers fewer. A larger plan
  restores it. A **retired** prompt is one its owner made inactive, which no plan restores.
