---
status: accepted
---

# The payment provider's webhook acts as the worker, and trusts only the signature

Billing ([0006](0006-plans-are-rows.md)) needs the payment provider to tell the app when a
subscription starts, changes or ends. That arrives as a request with no signed-in user, and what
it has to change, an organization's plan, is something no member may change: `apply_plan()`
answers only the secret key. Every other request acts as its caller and row-level security decides
what it may do.

**`POST /api/stripe/webhook` is the one route that uses the worker's store.** It may because of
three things it does, and a route that does not do all three may not follow it:

- **The signature is the caller's identity.** The body is checked against the endpoint's signing
  secret before anything is read from it. A request that fails is refused and changes nothing.
- **Nothing in the body is acted on.** The event only names a subscription. The route asks the
  provider for that subscription as it stands now and makes the organization's plan agree with
  it. Events that arrive twice, late or out of order end in the same place, and a replayed old
  event cannot put back an old state.
- **It can do one thing.** It calls `applyPlan` and keeps the provider's customer and
  subscription IDs in `subscriptions`. Which organization is the one written on the subscription
  by checkout, which only that organization's owner can start.

An owner starting a checkout or opening the provider's account pages is an ordinary request. It
acts as the owner, learns what it needs from `billing_state()`, which answers only an
organization's owner, and changes nothing in the database.

The plan follows the subscription's status: in force (`active`, `trialing`, `past_due`) keeps the
plan paid for; over (`canceled`, `unpaid`, `incomplete_expired`) moves the organization to the free
plan, and only when it is the subscription the organization is recorded as being on. `past_due`
is the provider still retrying a payment, so the plan stays until the provider gives up.

## Considered options

- **Act on the event's own contents.** Rejected: the provider does not promise the order events
  arrive in, so the last one handled could be an older state. Reading the subscription back costs
  one request and removes the question.
- **Keep a table of event IDs already handled.** Rejected for now: with the state read back, a
  repeat is harmless, so the table would guard against nothing.
- **A database function the provider's request could call as an ordinary role.** Rejected: the
  caller has no account, so there is no identity for a policy or a function to check. The
  signature is checked in the Worker, and after that the secret key is the honest description of
  who is acting.
- **Create the provider's customer when checkout starts, and record it then.** Rejected: that is
  a write to `subscriptions` on an owner's request, which would need either the secret key on a
  request path or a function that lets a member write billing state. Checkout makes the customer
  and the webhook records it.

## Consequences

- The provider must be set to end a subscription (cancel it or mark it unpaid) when its retries
  run out. If it is set to leave the subscription past due, the organization keeps its plan.
- An organization can be double-subscribed if its owner completes two checkouts opened before
  either was paid. Checkout refuses once a subscription is recorded, so it takes two tabs. The
  later one wins here; the earlier is refunded and cancelled by hand at the provider.
- An organization whose limits were set by hand and which then subscribes takes the plan's
  limits, and ends on the free plan if the subscription ends. Putting hand-set limits back is the
  operator's to do.
