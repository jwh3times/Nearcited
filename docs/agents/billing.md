# Billing and plans

The project rules for subscriptions and the payment webhook, prices, a plan's limits and
allowances, and stronger models. `AGENTS.md` "Rules" points here, and these bind as its own do:
read this file before changing anything in this area.

- **A subscription changes a plan only through the webhook.** Checkout and the account pages are
  the provider's. An owner's request may start a checkout, or change the subscription at the
  provider (an upgrade now, a downgrade at the end of the paid period), and writes nothing here.
  The webhook verifies the signature, reads the subscription back from the provider and calls
  `applyPlan`. `subscriptions` has no write path from a request, and whether a change is an
  upgrade is worked out on the server from the prices, never taken from the request.
- **A subscriber's price goes up only after they were told.** Setting a plan's price changes it
  for new subscribers; current ones keep the price version they joined at until an announced
  change moves them (`docs/adr/0008-a-price-change-reaches-subscribers-by-announcement.md`).
  `runPriceChangeStep` moves a subscription to a higher price only when its owners were sent the
  announcement at least thirty days before, checked per organization. Do not add another path
  that changes what a running subscription is billed, and never edit a price in place. The two
  that stronger models add are the only exceptions, and neither bills more
  (`docs/adr/0021-a-stronger-model-is-a-line-of-the-plans-price.md`): a switch of assistant moves
  a stronger line to the new one for the same price (`followAssistantSwitch`), and the day a
  reduction takes stronger models off a plan takes the lines off without charging
  (`fitSubscription`).
- **What a paying subscriber gets goes down only after they were told.** On a plan with
  subscribers a lower limit, or an allowance taken away or made smaller, is announced for a day
  at least thirty days out and made on that day by `apply_limit_change()`, which only the worker
  calls (`docs/adr/0009-a-reduction-is-announced-like-a-price-rise.md`). `operator_set_plan()`
  refuses to lower anything there on the spot. Raising a limit, and anything on a plan nobody
  pays for, still happens at once. Do not add a path that lowers a paid plan's limits or
  allowances without the announcement.
- **An organization's limits come from its plan.** `apply_plan()`, which only the worker calls,
  copies them from the plan, and the operator's limits editor changes them through its function.
  Nothing on a request path writes a limit, `allowances`, `plan_key`, `paused_by_plan`,
  `set_aside_by_plan` or `stronger_surfaces`. An account has one organization:
  `create_organization()` refuses a second.
- **A stronger model is a line of the subscription, and the tier is kept on each result.** An
  owner's request changes what the subscription pays for at the provider and writes nothing here;
  the webhook reads it back and `apply_plan()` sets which assistants are on Stronger, none on a plan
  without the `stronger_models` allowance
  (`docs/adr/0021-a-stronger-model-is-a-line-of-the-plans-price.md`). Its price is part of the
  plan's price version, one amount for each location paid for with a provider price of its own for
  each assistant, so it rises only by an announced price change, and each stronger line counts the
  locations paid for and moves with them
  (`docs/adr/0022-a-stronger-model-is-charged-for-each-location.md`). Which model Stronger is lives
  in the tuning's `stronger` blocks, and an assistant with none is sold none. A result and a drop
  keep the tier they were asked on, and a tier is part of the cell for the score and the alerts
  alike (`cellKey`, `packages/shared/src/scoring.ts`): keep the two agreeing. A test organization is
  always Standard.
- **A kind of work a plan includes is an allowance, not a new column.** It is one row in
  `allowance_kinds` and one entry in `ALLOWANCE_KINDS` (`packages/shared/src/allowances.ts`), added
  in the same change (`docs/adr/0012-a-plans-allowances-are-one-set.md`). A form shows and sends
  only the kinds its build knows, and the API puts back the ones it does not: keep that, or the
  Worker running while a migration adds a kind will drop it. A kind of connection that needs an
  allowance names it in `connection_kind_allowances` and `CONNECTION_KIND_ALLOWANCES`
  (`packages/shared/src/schemas.ts`), added in the same change.
