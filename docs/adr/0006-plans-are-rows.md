---
status: accepted
---

# Plans are rows, and an organization's own limits stay what is enforced

Nearcited is about to charge (issue #9). What is on sale, at what price and with what limits, has
to be changeable by the operator without a deploy, and has to be readable by a visitor who has no
account.

**A plan is a row in `plans`**: a price for the locations it includes, a price for each location
beyond those, and what an organization on it may do (prompts per location, how many assistants,
days between scans, scans by hand in a calendar month, whether a report is emailed). Everyone may
read the plans on sale, signed in or not. No API role writes the table.

**An organization points at a plan (`plan_key`) and keeps its own limit columns.** The triggers go
on enforcing the organization's columns, as they have since usage caps. Putting an organization on
a plan, or changing a plan, copies the plan's values onto the organizations on it. The plan is
where the numbers come from; the organization's row is what the database checks.

**`plan_key` is null for an organization whose limits were set by hand.** Nothing that follows a
plan touches it. Every organization that existed before plans is in that state, and the operator's
limits editor puts an organization in it.

The decisions billing is built on, so they are in one place:

- One subscription per organization, monthly, bought and changed only by its owner, through the
  payment provider's own checkout and account pages. The app never handles a card.
- A paid plan includes some locations and sells more one at a time.
- An organization whose subscription ends, or goes unpaid past the provider's retries, moves to
  the free plan. Nothing is deleted: what the free plan does not cover is paused and stays
  readable, and comes back when the organization subscribes again.
- A plan with fewer assistants than exist lets the owner choose which, and change it later.
- Scans by hand are counted over a calendar month in UTC.
- A change to a plan's limits applies at once to every organization on it. A change to its price
  applies at once to new subscribers, and to current ones only after at least a month's notice.

## Considered options

- **Plans as a constant in the code.** Rejected: a price change would need a deploy, and the
  operator asked to make one from the operator page.
- **No limit columns on the organization; read the plan on every check.** Rejected: the triggers
  would join to `plans` on every insert, an organization set by hand would need a plan of its own,
  and a plan edit could not be staged. Copying keeps the enforcement that is already tested.
- **Prices kept only at the payment provider.** Rejected: the price list has to be shown to a
  visitor without calling out to the provider, and has to carry limits the provider knows nothing
  about. The row holds the provider's price IDs so the two can be matched.

## Consequences

- The plan's values and the organization's can disagree if a copy is missed. Whatever changes a
  plan or an organization's plan must do the copy in the same transaction.
- The provider's price IDs sit in the table beside the prices. They identify a price and grant
  nothing, so they are not treated as secret; the API leaves them out because no page needs them.
- What a plan costs to serve is not in this repository.
