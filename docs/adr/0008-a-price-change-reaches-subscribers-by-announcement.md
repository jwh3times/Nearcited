---
status: accepted
---

# A price change reaches current subscribers by announcement, never by itself

[0006](0006-plans-are-rows.md) settled that a plan's price changes at once for new subscribers
and for current ones only after at least a month's notice. This is how that notice is given and
kept.

**Changing a plan's price and moving its subscribers are two acts.** The operator sets a new
price, which makes a new price version: new subscribers pay it, and everyone already subscribed
goes on paying the version they joined at (`plan_prices`). Nothing moves them until the operator
announces a day for the plan.

**An announcement names a day and the version.** From that day each subscription is moved to
the version at its own next renewal: the price is swapped with nothing charged or credited, so
what was paid for the current period stands and the renewal invoice is the first at the new
amount. While an announcement is open the plan's prices cannot be changed again, so what the
email said is what is charged.

**Notice is a fact about each organization, recorded when the email is sent.** The rule the code
keeps, in the one function that moves a subscription: a subscription is moved to a higher price
only when its owners were sent the announcement at least thirty days before. It is checked per
organization against the time the email went, not against the day the operator clicked. An
organization whose email could not be sent, or that has no owner to send to, is not moved. A
price that only goes down needs no notice.

The database also refuses to record an announcement that would put a price up less than thirty
days out. That is the operator's guard; the per-organization check is the customer's.

**The work is one message per organization per step**, on the queue the scans use: announce,
remind a week before, call off, move. Each step starts from the subscription as the provider has
it now and from what has already been recorded for the organization, so a message that arrives
twice, or after the organization has changed plan, cancelled or already been moved, does nothing
wrong. The daily run queues the reminders once and, from the day on, a move for every
subscription not yet moved, until none is left.

An announcement can be called off any time before its day. Everyone who was told is told it is
off. New subscribers go on paying the plan's present price either way.

## Considered options

- **Move everyone on the day, in the daily run.** Rejected: one invocation would make several
  requests to the provider for each subscriber, and a failure part way would have to be resumed
  by hand. A message each is retried by the queue and bounded in what it does.
- **Schedule each subscription's change at the provider when announcing.** Rejected: the
  provider would then move a subscriber whether or not our email reached them, and a subscriber's
  own waiting downgrade uses the same schedule.
- **Take "announced thirty days ago" as notice for everyone.** Rejected: it makes the operator's
  click the notice. An email that bounced out of the queue would still count.
- **Let the operator write the email.** Rejected for now: a fixed text with the two amounts and
  the day cannot be wrong about them.

## Consequences

- An organization that was not told is left on its old price, and shows to the operator as not
  moved. Two months after the day the announcement is closed with them still on it, so the plan's
  prices can be changed again.
- A subscriber's own change that is waiting for the period to end was made at their old prices.
  When they are moved it is rewritten at the new ones, or it would put them back.
- An announcement needs both the payment provider and outgoing email, and is refused without
  either.
- A subscription with a payment being retried is not moved until it is settled.
