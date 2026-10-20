---
status: accepted
---

# Standing permission is checked where an action is approved and where it is carried out

[0011](0011-the-product-does-the-work-and-the-owner-approves.md) settled that an owner who has
seen the product get a kind of action right three times can stop being asked: standing
permission, given per kind, acting first and telling the owners afterwards, and never for a reply
to a review of three stars or fewer. Issue #149 settled the rest.

**It is the organization's, for one kind of action.** An owner or admin gives it and ends it,
through `give_standing_permission()` and `end_standing_permission()`, which answer nobody else,
the operator included. It covers every location. Each giving is a row of `standing_permissions`,
with who gave it and when, and how it ended. One stands at a time for a kind. It is an allowance
kind of its own (`standing_permission`), so a plan includes it or does not.

**It is offered after three actions of the kind that a member approved as proposed, that were
carried out and that nobody asked to take back.** An approval of changed text, a failure, a lapse
and anything done under the permission itself do not count. The database counts them
(`standing_permission_count()`), so the count is the same wherever it is read. Once three count,
they stay counted: switching it off and on again does not start over.

**It approves an action as the action is proposed.** `propose_action()` makes a new proposal of a
kind under standing permission approved at once, keeping which permission approved it, who gave
that permission and when, with no member as approver, and the worker queues it like any approved
action. Nothing is approved by a second path, and what was waiting when the permission was given
goes on waiting.

**It is checked again where the action is carried out.** `claim_action()` puts an action back to
waiting for a yes, with a fresh fourteen days, where the permission that approved it has ended,
the plan no longer includes it, or the action always asks. A permission ended any other way puts
back what it approved and is not under way in the same step as the ending. Switching it off
therefore takes effect at once, and nothing approved a moment before is carried out after.

**An action can be marked as always asking.** It is proposed with `always_asks`, and both places
above refuse the permission for it. A reply to a review of three stars or fewer is proposed so;
the work that builds those replies only sets the mark.

**It ends three ways, and comes back one.** An owner or admin switches it off. A member asks to
take back something done under it, which ends it at the ask, recording the member and the action:
that is someone saying the product got it wrong. Or the organization's allowances stop including
it, by whatever path, and a trigger ends it as ended by the plan. A failure does not end it: nothing
changed outside, and a sign-in that is refused already breaks the connection. Only an owner or
admin gives it again; a plan that includes it again does not.

**The owners are told.** The daily action notice says of each action done under it that it was done
without waiting for a yes, under the permission who gave and when, and how to end one. It also says
when a permission was given or ended, and by what, once each. Those lines do not hold the
organization: only an action untold for 36 hours does.

## Considered options

- **For each location.** Rejected: the roles that give it are the organization's, most accounts
  have one location, and an owner with several would flip the same switch several times.
- **Approve proposals in a separate sweep.** Rejected: a second path that approves things, and a
  moment when an action shows as waiting when it is not.
- **Carry out what was approved before the permission ended.** Rejected: switching it off would not
  take effect at once, which is the point of being able to.
- **Leave the low-rated review rule to the work that builds replies.** Rejected: the guard belongs
  where the permission is applied, so it is built and tested with it.
- **Keep it, unused, while the plan does not include it.** Rejected: a yes in advance would come
  back by itself months later.

## Consequences

- An action has `approved_under`, `approved_under_by_email`, `approved_under_at` and `always_asks`.
  The record and the notice read who gave the permission off the action.
- `claim_action()` can now answer zero for an action it put back to waiting, and the worker reports
  that as `waiting`.
- The worker that proposes takes the queue, so what standing permission approves is carried out
  without waiting for the schedule.
- The export holds every permission given and ended.
