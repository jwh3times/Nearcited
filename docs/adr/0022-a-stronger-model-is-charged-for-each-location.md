---
status: accepted
---

# A stronger model is charged for each location paid for, on each assistant

ADR [0021](0021-a-stronger-model-is-a-line-of-the-plans-price.md) made a stronger model a line of
the subscription, one for each assistant on Stronger, at one amount a month whatever the number of
locations. No plan had a stronger price yet, so nobody had paid for one, when issue #217 changed
how the line is counted.

**A flat amount does not follow what is checked.** Every location is checked on each assistant at
every scan, so an organization with many locations has many times the stronger checks of one with
a few. One amount that suits a few locations does not cover many, and one that covers many is too
dear for a few. The operator could not set a stronger price that fits every subscriber on a plan.

**The stronger price is a rate, and the line counts the locations paid for.** The price version's
stronger price is an amount a month for each location the subscription pays for, on each assistant
on Stronger. The line on an assistant counts every location paid for, the plan's included ones as
well: a location costs the same to check whichever it is. It does not count the locations in use,
which billing does not know. It is still one amount, the same for either assistant, with a price of
its own at the payment provider for each, as ADR 0021 has it.

**It moves with the locations as one bill.** A change of locations on a subscription paying for
Stronger moves every stronger line in the same change, and the new total decides whether it is
an upgrade, made at once, or a downgrade, held to the end of the period, as any change of
locations is. The owner is not asked about it separately. A switch of assistant moves the line at
the same count, and the day a reduction takes stronger models off a plan takes the lines off
whatever their count, so neither bills more. A dearer rate still reaches a subscriber only by an
announced price change.

## Consequences

- The amount kept on each price version is the same column, read as a rate. No data changed:
  there were no stronger lines to convert.
- Owners are shown the rate and what it comes to for their locations: the price list says it for
  each location, on each assistant, and Account settings says the total for theirs.
- What the rate is, and why, is decided outside this repository.
