---
status: accepted
---

# A found answer is counted on the way to the review form

[0011](0011-the-product-does-the-work-and-the-owner-approves.md) allows one optional question,
"How did you find us?", put to every customer who follows a review request, never deciding who is
asked or where they are sent. A customer who heard of a business from an assistant and then phoned
or walked in leaves no trace on its website, so asking is the only way to count them. Issue #148
settled how the question is put and what is kept of the answer.

**The link in a review request is the product's, and it carries where it leads.** At sending, the
review form's link in the approved wording is replaced by a link of the customer's own,
`/r/<token>`, which a member approving the request sees as a placeholder, as they see the link to
opt out. The token names the request's action and the review form the email was sent with, signed
under a key of its own, and never the customer's address. The route that opens it, like the
opt-out route, checks the signature first and reads nothing: the page and the way on are made from
the link alone, so the link keeps leading to that form after its contact, its action or its whole
organization is gone. A link sent in an email lives for years, so the route and the token's format
are kept working for as long as any such email may be opened.

**The page is plain HTML from the Worker, in the business's name.** No script, cookie or image and
nothing of the product's name: the question, five answers (an assistant, with a second tap for
which; a search; someone they know; having been before; something else), and "Skip to the review"
with the same weight. Each is a form post that the Worker answers with a redirect to the review
form, whatever was tapped. There is no box to type in, since typed text could name a person. The
page says the answer is counted with others and not kept with the customer's name, and says
nothing about the rating or what to write.

**What is kept is a count, by location and month, and only the worker writes it.** The route
queues the answer with the action's id, and the worker counts the first answer for an action and
drops any later one, or one whose action is gone. The only thing tied to a request is that it was
answered, never what, and it goes with the action. The count is by month, not by day: a business
that sent two requests on a quiet day would otherwise read who said what. It belongs to the
location: shown on its page beside the visits from assistants and never added to them, exported
with the organization and deleted when the account closes. Anyone holding a link can tap anything,
so no score, alert, task, report or bill is worked out from it. A test organization and a
deployment on sample data send nothing, so their answers are made up by rule and kept as
`sample_data`.

**Whether the page costs reviews is measured by how many go on.** The product cannot see a review
being written, which happens on the review site. It can see how many opened the question and how
many went on to the form, whether they answered or skipped. Before the question, everyone who
followed a link reached the form. The two counts are kept for the deployment by month, belong to
no organization, and are read by the operator. If fewer than nine in ten go on after two hundred
opens, the operator looks at why, and the question is taken out if it is costing reviews. Mail
scanners open links nobody reads, which only makes the measured share lower than the real one.

## Considered options

- **A holdout: some customers are not asked, to compare.** Rejected. 0011 puts the question to
  everyone, and the review itself cannot be seen, so the comparison would still be of who reached
  the form.
- **The question as a page of the web app**, like the opt-out page. Rejected. It loads the signed-in
  app on a customer's phone, and a slow page is what would cost the reviews.
- **A short link naming only the action**, with a database function anyone may call that returns
  the form and whether the request was answered, and records the answer. Rejected. It adds a read
  and a write anyone can make, keyed by an id, where the opt-out route reads nothing. The cost of
  the choice is that a second visit is asked again, though only the first answer counts, and that
  the link is longer.
- **A row for each answer, or a count by day.** Rejected for the reason above: the owner knows whom
  they asked and when, so a fine enough record reads back as a person.
- **An owner's setting to turn the question off.** Not built. It costs a customer one tap, and the
  measure above is how the question would be found to cost more.

## Consequences

- Only requests the product sends carry the question. The request to send that an owner copies,
  and the code to print, keep the review form's own link, and nothing passes through the product.
- The question comes with review requests and is not an allowance of its own.
- The counts of opens can be padded by anyone who opens a link again, and the answers by nobody
  past one an action.
