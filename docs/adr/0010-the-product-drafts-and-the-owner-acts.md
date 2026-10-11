---
status: accepted
---

# The product drafts the work and the owner does it

The product measured whether the assistants name a business and said where the problems were. It
stopped there: the owner still had to work out what to write, whom to ask and whether it helped.
Issue #120 settled that it goes one step further, and how far.

**For each source that costs the business a mention, the product hands over a task the owner can
finish in about fifteen minutes.** What the task is depends on the kind of site the assistant
read:

| Kind of source | The task | What is handed over |
| --- | --- | --- |
| A review platform that lets a business ask for reviews | Get more reviews there | The link straight to its review form, the same as a code to print, and a short request |
| A review platform that forbids asking | Claim the listing, complete it, answer the reviews it has | The claim link and a checklist |
| A directory or listing | Check that what it says is right | The claim link and the business's details to compare |
| An editorial page, such as a list or a local blog | Ask to be included. Optional and marked as a long shot | A note to its author |
| A competitor's own site | None: nobody gets listed on a rival's website | Nothing. It shows what the assistant found worth reading, which is a matter for the business's own site |

**The product drafts; it sends nothing.** The owner sends the request, from their own address or
phone, to their own customers. The product holds nothing about a business's customers: no names,
no addresses, no lists.

**A model may write a draft and nothing else.** A draft is built from what the scans recorded and
what the owner said about the business, and is labelled as written by a model. The rates, the
score, the recommendations and the steps of the action plan stay composed by rule, so each can
still point at the observation it rests on. This answers issue #59.

**A task is proved the way a recommendation is.** The owner marks it done, and the page shows how
often the business was named before that day and since. The rule from issue #14 holds: nothing
ships without a way to tell from a later scan that it worked. The page says what moved and never
that the task caused it.

**The loop is tried by hand before a model writes anything.** Nobody knows how long a change
takes to reach an answer, or whether more reviews on a site move whether an assistant names the
business. A few real businesses, with drafts written by hand, are how that is learned.

## Considered options

- **Send review requests to the business's customers for it.** Rejected for now. It would mean
  holding customer lists, with consent, unsubscribing and bounces to handle, and enforcing each
  platform's rules on who may be asked. It is also what review-request products already sell.
  What this product alone knows is which sites the assistants read for this business, and that
  needs no sending. If owners turn out not to send the requests themselves, this is reopened.
- **A message to the author of every cited page.** Rejected as the default: most of the pages an
  assistant reads for a local business are review platforms and directories, where there is
  nobody to write to and an unasked message is unwelcome. It is kept for editorial pages only.
- **Advice without drafts.** Rejected: it is what the action plan already does, and it leaves the
  owner with the work that stops them.
- **A model writing the steps or the findings as well.** Rejected: a written finding has nothing
  behind it, and one invented observation makes every measured one doubtful.
- **For a marketer or an agency, not the owner.** Rejected for now: a task sized for someone
  whose job this is would be one the owner cannot finish.

## Consequences

- Which kind a source is has to be known. A list of sites by kind is kept and maintained, and a
  site not on it is treated with caution: no request for reviews is drafted for a platform whose
  rules are unknown.
- Most sources are cited once or twice and will be on no list, so what the product does with a
  site of unknown kind is the common case and not the exception.
- A draft can be wrong about the business. It is only as good as what the owner has told the
  product, so it must not state a fact about the business that nobody gave it.
- The wording a model is given is tuning, and its real value is private
  ([0001](0001-private-tuning-as-data.md)).
- Drafts cost money per use, where every measurement so far costs per scan. What that does to a
  plan's limits is decided once the cost of one is measured.
