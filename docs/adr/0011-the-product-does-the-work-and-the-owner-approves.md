---
status: accepted
---

# The product does the work and the owner approves it

[0010](0010-the-product-drafts-and-the-owner-acts.md) had the product draft each piece of work
and the owner do it: send the request, publish the page, keep every customer's details
themselves. That settled what to build first. It leaves the owner with the sending, the
publishing and the remembering every month, and a product an owner has to keep working for is
one they stop paying for. This record replaces 0010: after one setup, the product does the work.

**An owner connects an account once and the product works from it.** A connection is the owner's
standing sign-in to somewhere the work happens: the business's Google profile, its website, its
visitor statistics, the tool that knows who its customers are. The product syncs from each on a
schedule and asks the owner for no data after the setup. Where no connection is possible the work
stays a task for the owner, with everything they need handed over.

**What the work is still depends on the kind of site the assistant read.** The kinds are 0010's,
with the business's own site added:

| Kind of source | The work | Who does it |
| --- | --- | --- |
| A review platform that lets a business ask for reviews | Get more reviews there | The product, by review requests, once a customer source is connected. Until then the owner, with the link straight to the review form, the same as a code to print, and a short request |
| A review platform that forbids asking | Claim the listing, complete it, answer the reviews it has | The owner, with the claim link and a checklist |
| A directory or listing | Check that what it says is right | The product where the listing is connected, which today can only be the Google profile. The owner elsewhere, with the claim link and the business's details to compare |
| An editorial page, such as a list or a local blog | Ask to be included. Optional and marked as a long shot | The owner, with a note to its author |
| A competitor's own site | None: nobody gets listed on a rival's website | Nothing. It shows what the assistant found worth reading, which is a matter for the business's own site |
| The business's own site | Publish a page that answers the prompt, and fix what the on-page check failed | The product where the site is connected. The owner elsewhere, with the copy and the structured details ready to paste |

**Nothing changes outside the product without a yes.** An action is one thing the product does
outside itself: a fact corrected, a review answered, a post or a page published, a request sent
to a customer. Each is shown first and carried out only once a member approved it. Each is
recorded with what it changed and who approved it, and the organization's owners are told within
48 hours of every one. Where a platform changed a listing itself, the product shows the
difference and proposes an action; it never puts the old value back on its own.

**Standing permission is given per kind of action and can be taken back.** It is offered only
after three actions of that kind were approved one at a time. Under it the product acts first
and tells the owners afterwards, still within 48 hours. A reply to a review of three stars or
fewer always waits for approval, whatever permission is standing.

**Who may say yes.** Only an owner or admin may make or remove a connection, and give or take
back standing permission. Any member may approve a single action.

**A model may write what is published, and still nothing that is measured.** Drafts, replies to
reviews, posts and page copy are written by a model from what the scans recorded and what the
owner said about the business. They are labelled as written by a model wherever a member reads
them, and state no fact about the business that nobody gave. The rates, the score, the
recommendations and the steps of the action plan stay composed by rule, so each can still point
at the observation it rests on.

**The product holds a customer's contact details only long enough to ask once.**

- A review request goes to every customer of a business alike, never chosen by how they are
  likely to rate, and offers nothing in return.
- It is one message, sent the morning after the job, with no reminder. Nobody is asked twice by
  the same business within twelve months.
- It is sent from the product's own sending address under the business's name, and a reply goes
  to the owner.
- It carries a way to opt out, which holds for that business from then on.
- The contact details are deleted 30 days after the request is sent. What is kept cannot be read
  back as a name, an address or a number, and answers two questions only: was this person
  already asked, and did they opt out.
- One optional question, "How did you find us?", may be put to the customer on the way to the
  review form. It is put to everyone, and never decides who is asked or where they are sent.
- A business whose list of customers is confidential by law or by professional rule, such as a
  clinic or a law firm, gets no automatic customer sync. It keeps the review link and the code to
  print.

**Only data the business is entitled to hand over.** The product reads an outside account through
the owner's sign-in, or under a licence from whoever holds the data. It does not buy reviews or
listings that somebody else scraped from a platform.

**Proof is unchanged.** A piece of work, whoever did it, is proved the way a task is: the page
shows how often the business was named before that day and since, and never says the work caused
the change. The rule from issue #14 holds. A visit from an assistant is counted only where the
visit says where it came from, and the page says which assistants cannot be told apart from
ordinary search.

**What a plan includes is on the plan.** Each kind of work a plan includes is a value on its row
([0006](0006-plans-are-rows.md)), copied to the organization with its limits, and a number of
requests a month is a limit like any other. Taking either away from a plan somebody pays for is
a reduction ([0009](0009-a-reduction-is-announced-like-a-price-rise.md)). Which plan includes
what is decided with the prices and kept privately until the migration that turns it on.

## Considered options

- **Keep 0010: draft, and leave the doing to the owner.** Rejected for the reason at the top. It
  was right for the first step, and the tasks built under it stay for every site the product
  cannot be connected to.
- **Act without asking and report afterwards.** Rejected as where an owner starts. A wrong fact
  on a profile or a clumsy reply to an unhappy customer is public and carries the business's
  name. Google's rules for its profile interface also ask for the owner's specific consent to
  automated changes and for notice within 48 hours. Standing permission is how an owner who has
  seen the product get it right three times stops being asked.
- **Keep the customer list, to ask again and to send other things.** Rejected. The tools the
  contacts come from limit what they may be used for, a second request is an unwelcome one, and
  a list the product does not hold cannot leak.
- **Buy scraped reviews and listings for the platforms that offer no sign-in.** Rejected. Those
  platforms forbid it, whether it is lawful is still being argued in court, and what the product
  shows would rest on a supply that can stop.
- **Wait for the hand test.** 0010 had the loop tried by hand before a model wrote anything.
  The hand test still runs, to learn how long a change takes to reach an answer, and no longer
  holds anything up. The cost is that some of what gets built may be for work that turns out
  not to move an answer. The before-and-since proof is how that will show.

## Consequences

- The product now holds secrets that belong to someone else. A connection's sign-in is kept
  where no signed-in user can read it back: an owner or admin can make and remove one, the
  worker uses it, and it is never returned to a browser.
- Sync is polled from the schedule and run from the queue. Where an outside service can only
  call in, the route checks the signature and puts a message on the queue. The payment webhook
  stays the only request path that acts as the worker
  ([0007](0007-the-payment-webhook-acts-as-the-worker.md)).
- A platform can limit what may be kept. Google allows what is read from a profile to be held
  for 30 days and not combined across businesses, so its reviews and figures are shown from a
  recent sync and never become history. History rests on the product's own scans and its record
  of actions.
- An action can be wrong in public. Approval, the notice within 48 hours and the rule for
  reviews of three stars or fewer are what stand between a model's mistake and a business's
  reputation. None of them is weakened for convenience.
- The terms of service and the privacy policy were written for a product that sends nothing to a
  business's customers and holds nothing about them. They change, and a lawyer reads them,
  before the first request is sent.
- Each outside service has its own approval, and several take weeks. The build order follows
  those waits (issue #15).
- Some things cannot be done today and are not promised: a count of how often people in one town
  ask an assistant something; telling a visit from Google's AI answers apart from an ordinary
  Google visit; publishing to a website builder that offers no way in; changing a listing on a
  platform that opens its interface to partners only.
- What worked across businesses can be shown only once enough of them have done the same kind
  of work, and only from the product's own scans and actions.
- Text messages, call tracking and listings on other directories cost money for each use or
  each business, and texts need each business registered on its own. They come last, each with a
  number a month on the plan.
- The wording a model is given is tuning, and its real value is private
  ([0001](0001-private-tuning-as-data.md)).
