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
  recommendations.
- Acting as the operator without the role. The operator may read every organization, and may
  change only an organization's limits and a plan's settings and prices, each through a function
  that records it. Without the role, each of these is a report:
  - reading another organization's rows, the `audits`, `provider_usage` or `operator_actions`
    tables, or a row from `usage_by_month()`, which adds up `provider_usage`;
  - calling `operator_accounts()`, which lists every account's email and sign-in times;
  - calling `operator_set_limits()`, `operator_set_plan()` or `operator_set_plan_prices()`;
  - announcing or calling off a price change (`operator_announce_price_change()`,
    `operator_call_off_price_change()`) or a reduction in a plan's limits
    (`operator_announce_limit_change()`, `operator_call_off_limit_change()`);
  - writing `plan_prices`, `price_changes`, `price_change_notices`, `limit_changes` or
    `limit_change_notices`;
  - making an audit through `operator_create_audit()`.
- Changing what an organization's plan allows from a member's request: calling `apply_plan()` or
  `fit_to_plan()`, or writing a limit, `plan_key`, `paused_by_plan` or `set_aside_by_plan`
  directly.
- Getting `choose_assistants()` or `activate_location()` to act on an organization the caller
  does not belong to.
- Getting a second organization on one account, or deleting or moving an organization.
- Writing scan results, scores or recommendations as a signed-in user. Only the worker should be
  able to.
- Granting yourself a platform role, or marking an organization as a test one.
- Calling a worker-only database function through the public API.
- Getting past token verification on `/api/*`.
- Forging the payment webhook: getting `/api/stripe/webhook` to act on a request Stripe did not
  sign, or on a replayed or reordered one. It needs no sign-in and uses the Worker's secret key,
  so the signature is its only guard. The same applies to `claim_subscription_start()`, which only the worker may call.
- Getting a plan without paying for it, or keeping one after the subscription ended: changing an
  organization's plan or limits, or writing `subscriptions`, as a signed-in user. Checkout and
  the billing portal are for an organization's owner only.
- Lowering a paid plan's limits without the announcement: through `operator_set_plan()`, or by
  calling `apply_limit_change()` as anyone but the worker.
- Moving a subscription to a higher price without its owners having been told at least thirty
  days before.
- Reading a shareable audit without its link, or after it was revoked or expired; listing audits;
  or creating one. `/api/audits/:token` is the one route that gives out an organization's data
  with no sign-in, and the token in the link is the only key to it. `/api/plans` needs no sign-in
  either: it is the price list, and holds nothing that belongs to a tenant.

## Supported versions

Only the current `main` branch.
