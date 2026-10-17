---
status: accepted
---

# A stronger model is a line of the plan's price, set by the webhook and kept on each result

Until issue #86 every organization was checked with the same model on each assistant, set once
for the deployment in the tuning. `plans.stronger_models` marked the plan that might one day
offer more, and nothing read it. Issue #215 is the spec for letting an owner pay for a stronger
model on an assistant.

**The owner chooses a tier for each assistant.** Standard is the deployment's model. Stronger is a
more capable one, paid for on top of the plan. On a plan that checks one assistant that is the
same as one switch; on a plan that checks both, the owner may pay for one and not the other. The
choice names tiers, not models: an owner does not know what a vendor calls its models, and which
model is the stronger one changes with the tuning.

**Which plans sell it is an allowance.** `stronger_models` is an included-or-not kind of
allowance (ADR [0012](0012-a-plans-allowances-are-one-set.md)), so taking it off a plan somebody
pays for is a reduction, announced thirty days out ([0009](0009-a-reduction-is-announced-like-a-price-rise.md)).
On the day, the worker takes the stronger lines off each subscription on the plan, charging and
crediting nothing for the period already paid for. The old column stays until no deployed Worker
reads it.

**Its price is part of the plan's price version.** One amount a month for each assistant on Stronger
(for each location paid for, since ADR
[0022](0022-a-stronger-model-is-charged-for-each-location.md)), the same for either, set by the
operator in the price editor with the plan's other prices. The Worker makes a price of its own at
the payment provider for each assistant, because a subscription cannot hold one price twice and the
webhook has to tell which assistant was paid for. So a subscriber goes on paying the stronger price
they joined at, and a rise reaches them only by an announced price change
([0008](0008-a-price-change-reaches-subscribers-by-announcement.md)), which counts a dearer stronger
price, or one no longer sold, as a price that goes up. A plan sells Stronger only once its current
version has that price.

**The tier is what the subscription pays for.** Choosing Stronger is an upgrade, made at once and
prorated; going back to Standard is a downgrade, held until the period paid for ends. Either way
the request changes the subscription at the provider and writes nothing here. The webhook reads
the subscription back and `apply_plan()` writes `organizations.stronger_surfaces` from its lines,
keeping none on a plan that does not include stronger models. Nothing on a request path writes it.
On a plan that checks one assistant, a switch of assistant moves the stronger line to the new
one for the same price, or lets it go at the end of the period where the new one has no stronger
model.

**What Stronger is lives in the tuning.** Each assistant's settings may have a `stronger` block:
a model, how hard it works and, for Claude, how many searches a check may run. The values are
private, as the standard ones are ([0001](0001-private-tuning-as-data.md)). An assistant with no
block offers no Stronger. Someone already paying for one the tuning loses is checked on Standard,
the result says so, and the operator's overview warns.

**Each result keeps its tier, and a tier is part of the cell.** A prompt asked of a stronger model
is a different cell from the same prompt on Standard, for the score and for the alerts alike. The
score is counted over the cells of the newest scan, so after a switch the old tier's checks drop
out and the assistant's score starts again from its first scan on the new one, as a switch of
assistant already does. A drop open on the old tier is cleared as no longer checked. "For the
first time" still reads the whole record, whatever tier each answer was asked on. The scan keeps
the tier it asked each surface on, so the score's history can mark where one changed.

## Consequences

- Drafts do not follow the tier: the owner pays for how the checks are run.
- A test organization has no tier to choose and is always Standard, since its scans are generated.
- The operator sees each organization's tiers and does not change them. Spend needs nothing new:
  it already prices each model at its own rate.
- Choosing a model by name, more than two tiers, and charging by use are left for later.
