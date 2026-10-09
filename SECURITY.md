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
  recommendations. The operator may read them, and may change only an organization's limits and a plan's settings and prices, through `operator_set_limits()`, `operator_set_plan()` and `operator_set_plan_prices()`; reading them, or the
  `audits` and `provider_usage` tables, without the operator role is a report (`usage_by_month()` adds up `provider_usage`, and getting a
  row from it without the role counts). So is calling `operator_accounts()`, which lists every account's email and sign-in
  times, without it, and so is changing limits through `operator_set_limits()`, changing a plan through `operator_set_plan()` or its prices through `operator_set_plan_prices()`, writing `plan_prices`, `price_changes` or `price_change_notices`, announcing or calling off a price change through `operator_announce_price_change()` or `operator_call_off_price_change()`, making an audit through
  `operator_create_audit()` or reading `operator_actions` without it.
- Writing scan results, scores or recommendations as a signed-in user. Only the worker should be
  able to.
- Granting yourself a platform role, or marking an organization as a test one.
- Calling a worker-only database function through the public API.
- Getting past token verification on `/api/*`.
- Forging the payment webhook: getting `/api/stripe/webhook` to act on a request Stripe did not
  sign, or on a replayed or reordered one. It needs no sign-in and uses the Worker's secret key,
  so the signature is its only guard.
- Getting a plan without paying for it, or keeping one after the subscription ended: changing an
  organization's plan or limits, or writing `subscriptions`, as a signed-in user. Checkout and
  the billing portal are for an organization's owner only.
- Moving a subscription to a higher price without its owners having been told at least thirty
  days before.
- Reading a shareable audit without its link, or after it was revoked or expired; listing audits;
  or creating one. `/api/audits/:token` is the one data route that needs no sign-in, and the
  token in the link is the only key to it.

## Supported versions

Only the current `main` branch.
