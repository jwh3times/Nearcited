# Security

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Please do not open a public issue for a security problem.

Include what you did, what you expected, and what happened instead. A request you can replay
or a failing test is the most useful thing you can send.

There is no bug bounty.

## What counts most

Nearcited is multi-tenant, and tenant isolation is enforced by Postgres row-level security
(see `docs/architecture.md`). The reports that matter most are:

- Reading or changing another organization's locations, queries, scans, results or
  recommendations. The operator may read them, and may change only an organization's limits, through `operator_set_limits()`; reading them, or the
  `audits` and `provider_usage` tables, without the operator role is a report. So is calling `operator_accounts()`, which lists every account's email and sign-in
  times, without it, and so is changing limits through `operator_set_limits()` or reading
  `operator_actions` without it.
- Writing scan results, scores or recommendations as a signed-in user. Only the worker should be
  able to.
- Granting yourself a platform role, or marking an organization as a test one.
- Calling a worker-only database function through the public API.
- Getting past token verification on `/api/*`.
- Reading a shareable audit without its link, or after it was revoked or expired; listing audits;
  or creating one. `/api/audits/:token` is the one data route that needs no sign-in, and the
  token in the link is the only key to it.

## Supported versions

Only the current `main` branch.
