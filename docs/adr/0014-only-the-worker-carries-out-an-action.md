---
status: accepted
---

# Only the worker proposes an action, and it carries each one out once

[0011](0011-the-product-does-the-work-and-the-owner-approves.md) says nothing changes outside the
product without a yes. Issue #135 settled how an action is proposed, answered and carried out.

**A request records the answer, and the worker does the work.** A member approves or declines on
a request. Carrying the action out happens from the queue, because it needs the sign-in, which a
request cannot read ([0013](0013-a-sign-in-is-sealed-by-the-worker.md)), and so that a yes is
never lost along with an outside call that failed.

**The worker proposes; a request never does.** A proposal says what is there now and what would
replace it, and only the worker can read what is there. There is one open proposal for a thing:
a second is not made while the first is waiting or on its way.

**An action is carried out once.** Before it writes, the worker reads what is there now.

- If it is already what the action would make it, the action is done and nothing is written.
  That covers a message delivered twice, and a worker that wrote and died before it could say so.
- If it is no longer what the member was shown, nothing is written and the action lapses as out
  of date. The worker reads the account again at once, which proposes a fresh action against
  what is there now. A yes to one change is not a yes to another.

**An action has six states and no others**: proposed, then approved and done, or approved and
failed; a proposed one can also be declined, or lapse. A proposal lapses after fourteen days. A
thing that was declined is not proposed again until what the proposal rests on changes.

**A member may change the text before approving.** The record keeps what was proposed and what
was approved, and says a person changed it.

**A failure is tried three times and then waits for a member.** After that nothing is retried by
itself. Asking again makes a new action that points at the one that failed, so the record keeps
who approved each try.

**The owners are told once a day.** One message gathers everything carried out since the last
and who approved each, including what an owner approved themselves, and lists what is newly
waiting. If an action passes 36 hours without its notice, nothing more is carried out for that
organization and the operator is shown it. Where a deployment cannot send email, a real action
cannot be approved at all. A test organization is never written to: for it the record on the page
is the notice.

**What the product wrote is kept; what it replaced only as long as it may be.** The text, who
approved it and when are kept for as long as the organization exists. What it replaced, where
that was read from a platform that limits how long it may be held, is dropped when that limit is
reached, and the record says so.

**An action that does a task's work marks the task done**, at the moment it is carried out, and
a member cannot clear that mark. **An action takes from the month's allowance when it is carried
out** and gives it back if it fails; once the month's number is used, no more of that kind are
proposed.

## Considered options

- **Carrying the action out on the request that approves it.** Rejected. The request cannot read
  the sign-in, a click would wait on an outside service, and there would be nowhere to try again
  from.
- **Letting a member, or the page, propose.** Rejected. A proposal states what is there now, and
  a request does not know.
- **Writing whatever was approved, over whatever is there.** Rejected. The member said yes to
  replacing what they were shown. If that has changed, somebody changed it, and it is not the
  product's to overwrite unseen.
- **Trying a failed action again until it works.** Rejected. A change made days after it was
  approved, with nobody looking, is not the change that was approved.
- **Opening the failed action again when a member asks.** Rejected. It would overwrite who
  approved the first try.
- **A notice for each action.** Rejected. An owner who approves ten things would get ten emails
  saying so. Once a day keeps every notice well inside the 48 hours.

## Consequences

- Between a yes and the thing being done there are a few seconds, and the page says "being
  carried out" for them.
- Delivery is at least once, and an outside write cannot be made exactly once. Reading first
  narrows what can go wrong to a worker that dies between writing and recording, which the next
  try sees as already done.
- An approved action can wait while its organization is held. One whose message is lost, or
  whose worker died while carrying it out, waits for the next run of the schedule: a worker's
  hold on an action lasts ten minutes, and the schedule asks again for any left longer than that.
- The sample kind of action writes to a table of made-up listings, so the whole path is
  exercised where the data is generated and nothing leaves the product.
- What is built so far, and what of the above is still to come, is in `docs/architecture.md`.
