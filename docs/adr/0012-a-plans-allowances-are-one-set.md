---
status: accepted
---

# A plan's allowances are one set, not a column each

[0006](0006-plans-are-rows.md) made each thing a plan allows a column, copied to the
organization. [0011](0011-the-product-does-the-work-and-the-owner-approves.md) has the product do
about a dozen kinds of work for an owner, each of which a plan includes or does not, some up to a
number a month. Issue #133 settled how a plan carries them.

**The kinds of work a plan includes are one set on its row**, `allowances`, copied to the
organization as its limits are. A kind that is absent is not included. `true` is included. A whole
number is how many a month the plan allows for each location it covers. The limits that existed
before stay columns.

**A set may name only a kind that exists.** `allowance_kinds` lists them, and the database refuses
a set that names any other or gives a kind a value it does not take, so a slip of the keyboard
cannot become an allowance. The shared package lists the same kinds with the words the pages use.
Adding a kind is one row and one entry.

**A number is shared across the organization.** What it may use in a month is the plan's number
times the locations the plan covers, extra ones included, over a calendar month in UTC. A busy
location can use what a quiet one does not, and scans by hand are already counted this way.

**At the number the work stops**, and the page says so and offers the larger plan. Nothing is
charged beyond the plan.

**Taking a kind away, or lowering its number, is a reduction**
([0009](0009-a-reduction-is-announced-like-a-price-rise.md)): refused on the spot where somebody
pays, announced kind by kind, and held where it is until the day.

**A build leaves alone a kind it does not know.** The wire type keeps it, the forms neither show
nor send it, and the API puts it back when an edit is saved. A kind is added by a migration that
is applied before the Worker that knows it is deployed, and the Worker running in between must not
drop it.

**A test organization has every kind**, with room to exercise it, as its limits are generous.

## Considered options

- **A column for each kind, as the limits are.** Rejected. A column is handled by name in the
  function that copies a plan, the two that edit one, the one that finds reductions and the one
  that makes them. Two of those take an argument for each value and have to be dropped and made
  again to gain one. With a dozen kinds coming, each new kind of work would begin by remaking the
  functions billing rests on.
- **Moving the existing limits into the set too.** Rejected. Triggers enforce them from the
  columns, and nothing is gained by disturbing what is tested.
- **A row for each plan and kind.** Rejected. It needs a table on the plan's side and another on
  the organization's, each with policies, and a join wherever an allowance is read, to hold what
  one value holds. A reduction is already recorded as JSON.
- **Charging for use beyond the number.** Rejected. It is a bill nobody agreed to, and it would
  need metered billing at the payment provider.
- **Counting over the period paid for.** Rejected. It is fairer on paper and gives the product two
  meanings of "this month".

## Consequences

- The database cannot type a set as it types a column. A trigger checks it in the column's place,
  and whether a kind is counted is fixed when the kind is made.
- The list of kinds is kept twice: in the database, for what is accepted, and in the shared
  package, for the words. A test holds the two equal.
- No kind exists yet. The first arrives with the work that needs it, and counting use against a
  number is a step of its own.
- Which plan includes what, and the numbers, are decided with the prices and kept privately until
  the migration that turns each on.
