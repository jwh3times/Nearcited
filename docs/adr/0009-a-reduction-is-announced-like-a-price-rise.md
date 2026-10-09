---
status: accepted
---

# A reduction in what a paid plan allows is announced like a price rise

[0006](0006-plans-are-rows.md) has a change to a plan's limits reach every organization on it at
once. For a paying subscriber a lower limit is the same thing as a higher price: the same money
for less. [0008](0008-a-price-change-reaches-subscribers-by-announcement.md) gave a price rise
thirty days' notice; a reduction made on the spot would have had none.

**On a plan somebody pays for, a limit goes down only by announcement.** The operator names a day
at least thirty days out. Everyone on the plan is emailed then and again a week before, and on
the day the reduction is made for the plan and every organization on it together. Until the day
the fields going down are held where they are. It can be called off before the day, and everyone
who was told is told so.

**Everything else stays as 0006 has it.** Raising a limit, renaming a plan and taking it off sale
happen at once and send nothing: nobody loses by them. A save that raises some limits and lowers
others is split, the first made now and the second announced. A plan with no subscribers is
changed on the spot. So is the free plan, where nobody pays; each organization on it is sent one
email that day saying what changed.

What counts as going down: fewer prompts for each location, fewer assistants, more days between
scheduled scans, fewer scans by hand, and a report that stops. Prices have their own
announcement, and the two can be open for one plan at once.

## How this differs from a price change

A price is per subscription, so a subscriber who was not told is simply not moved. A plan has one
set of limits, and the rest of the system relies on every organization on a plan having them. So
a reduction is made for everyone on the day, told or not, provided the announcement was made
thirty days before. Who has been sent the email is recorded for each organization as it goes, and
the operator is shown by name whoever has not, to be written to directly.

## Considered options

- **Leave an organization that was not told on the old limits.** Rejected: organizations on one
  plan would have different limits, and the next time the plan is applied to them, on any change
  to it or to their subscription, the old ones would be overwritten without warning.
- **Give each subscriber the limits they joined at, as with prices.** Rejected for now: it needs
  a version of a plan's limits for each organization, where today there is one copy on the
  organization's row and everything that enforces a limit reads it.
- **One announcement for price and limits together.** Put off: nicer for the customer when both
  change at once, at the cost of reworking the price announcement just built.
- **Email on every change to a plan.** Rejected: an improvement or a new name arriving in the
  same voice as a reduction teaches people to stop reading, and the notice that matters is the
  one that gets missed.

## Consequences

- The rule lives in the database: `operator_set_plan()` refuses to lower anything on a plan with
  subscribers, and `apply_limit_change()`, which makes an announced reduction, answers only the
  worker. The Worker's own check is a convenience on top.
- An organization whose email could not be sent still has the reduction made for it. The operator
  page saying so is the only safeguard, and it depends on the operator reading it.
- A subscriber who joins the plan after the announcement was made is not emailed, and has the
  reduction made for them on the day like everyone else.
- Without outgoing email a reduction on a paid plan cannot be announced, and so cannot be made. A
  cut to the free plan is still made; nobody is told.
