---
status: accepted
---

# The worker writes a draft, and a rule decides whether it is kept

Issue #138 is the first thing a model does in the product. A task hands an owner a link and what
to do, and the owner still has to write the wording: the note to a page's author, the
description for a listing. A draft is that wording.
[0011](0011-the-product-does-the-work-and-the-owner-approves.md) settled that a model may write
it, that it is labelled as a model's, and that it states no fact about the business nobody gave.
This record is how that is kept.

**A task has a draft where its work is wording.** There are two kinds. A note, for a task about
a page somebody wrote: the work is asking its author. A listing's description, for a task about a
directory, or about a review site that does not let a business ask for reviews: the listing is
claimed and filled in, and the field that takes writing is the description. A task whose work is
asking customers for reviews has none, since the product writes nothing to a business's
customers. A task about a site of a kind nobody knows has none either: nobody knows what the site
would take.

**A draft is asked for, not written when a task is opened.** A member presses a button on the
task. A plan gives a number of drafts a month, and writing one for every task a page shows would
spend the month on tasks nobody means to do, and charge an owner for looking.

**A request records the ask, and the worker writes.** Writing takes one from the month's
allowance and, on real data, calls a model and records what that cost. None of that is a
member's to do, so a request does one thing: `ask_draft()` notes who asked, and the worker is
queued. The page says a draft is being written and asks again every couple of seconds. This is
the shape actions have, for the same reason
([0014](0014-only-the-worker-carries-out-an-action.md)).

**The worker reads what a draft is written from, off what is on file.** The task, the page it is
about and the location's details are read by the worker when it writes. Nothing a request said
decides what a model is given, so a member cannot have a draft written about a page the scans
never read or a business that is not theirs.

**A draft is written from what a location holds, what its owner said it does, and the page.**
The name, city, region, category and website on file; the few sentences the owner wrote under
"What we do"; and the site the task is about, with the page of it the answers cited. Nothing
from the answers themselves is given: what an assistant said about a business is the thing being
measured, and it is often wrong. Nothing is written until the owner has said what the business
does, because without it a model has only a name and a city and fills the rest in.

**A rule checks every draft before anyone is shown it.** Every number, web address and email
address in a draft has to be in what it was written from. A web address passes as one that was
given or as the site of one, so a made-up page of the business's own site does not. A draft that
fails is thrown away and written once more. If the second fails too, nothing is kept, the reader
is told it could not be written, and the month is given back what was taken.

The rule reads characters, not meaning. It catches a made-up phone number, year, price, count,
link or address to write to, which are the inventions an owner is least likely to notice and a
reader most likely to act on. It does not catch "award-winning" or "the oldest in town". The
label beside every draft says to read it before using it, and the draft is the owner's to change
and send: the product sends nothing.

**One draft for a task, and writing it again counts.** A draft belongs to the task it was asked
for. Asking again replaces it and takes one more from the month, because it cost one more. The
draft from before stays where it is while the next is written, and stays if the next cannot be.

**The month is taken from when the worker takes the draft, and given back when nothing was
written.** A request checks there is room and refuses when there is none, so nobody waits on a
draft that cannot come. It counts nothing. `claim_draft()` takes one, once for an ask however
many tries it needs, and `finish_draft()` gives it back when the ask ends with nothing written:
the check failed twice, the model failed, the task had gone, or the month ran out in between.

**Sample text is nobody's writing, and says so.** On sample data and for a test organization the
worker writes generated text from the same inputs, through the same check and the same count,
and calls no model. It is kept marked as sample text and labelled as that wherever it is read,
never as a model's.

**A real draft is written only with the private instructions.** Which model writes, how hard it
works and what it is told are tuning ([0001](0001-private-tuning-as-data.md)). The default tuning
carries placeholder instructions so the code runs, and a build that has only those writes no
draft on real data, for the reason it runs no live scan: what it wrote would be shown as the
product's own work. A tuning file with no instructions for a kind of draft writes none of that
kind. Nothing falls back to the placeholder.

**The model is given the details set out by the code, and looks nothing up.** The instructions
are private; what follows them is not. Each detail goes on a line with its name, the same way
every time, and one that is not on file is said to be not on file. The request has no tools, so
the model cannot search for the business and bring back what it finds.

**What the writing used is recorded after every write.** A draft that was thrown away, or cut
short, or refused was still paid for. Its use goes to the operator's spend against the
organization, as a scan's does, though the month is given back.

**A draft is copied, not edited here.** It is shown with a button that copies it. Where it goes
is an email, a form on somebody else's site or a field in a listing, and that is where it is
changed.

## Considered options

- **Writing a draft when the task is opened.** Rejected, for the reason above. It is what #120
  first said, before a month had a number.
- **Writing it on the request.** Rejected. It is quicker by the queue's wait, about ten seconds.
  It would also have a request take from an allowance and call a model with what the request
  said, and a failed request would leave the count taken or the model's cost unrecorded.
- **A second model reading the draft for facts nobody gave.** Rejected. It would catch more, and
  what it passed would rest on a model's say-so, which is what the check is there to avoid. It
  also doubles what a draft costs.
- **Giving the model the answers, so the note can say what assistants say of the business.**
  Rejected. An answer is not a fact about the business, and a draft built on one would repeat
  what the product exists to correct.
- **Not counting a draft written again.** Rejected. A member could have one written until the
  month's cost was whatever they liked.
- **Editing the draft in the product.** Rejected for now. Nothing here sends it, so the edit
  would be made twice.

## Consequences

- A draft takes a moment to arrive: the queue's wait, then the writing.
- The check will throw away some drafts a reader would have found fine, such as one that says
  "one of 3 pizzerias" where nobody gave a 3. That costs a second write and, rarely, a draft.
- The instructions are private and the check is not: it is a rule in the shared package, and it
  runs on whatever was written, by whatever wrote it.
- A draft costs money that a month given back does not return. A writer that keeps failing the
  check is paid for twice an ask and shows only in the operator's spend.
