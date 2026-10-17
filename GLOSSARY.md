# Glossary

The words this project uses with one fixed meaning. `docs/architecture.md` describes how the
system works; this file only settles vocabulary.

- **Shareable audit** (or **audit**): a one-off report for a business that has not signed up. A
  few prompts, each asked several times on every assistant in one go, read at `/audit/<token>` by
  anyone holding the link. Not a scan: it belongs to no organization and has no history.
- **Audit cell**: one prompt on one assistant within an audit, over every time it was asked: how
  many answers, how many named the business, and where.
- **Sample**: one asking of a prompt on one assistant. An audit takes several at once; a tracked
  location takes one per scan and counts them over the scan window.
- **Audit token**: the 64-character random string in an audit's link. Holding it is the only
  permission to read the audit. See `docs/adr/0002-audits-are-read-by-token.md`.
- **Source**: a site an assistant cited in an answer. Counted per answer, with how many of the
  answers that cited it named the business. It says nothing about what the site's pages contain.
- **On-page check**: reading a business's own home page as an assistant's crawler would, without
  running scripts, and reporting a fixed list of pass or fail checks. See "The on-page check" in
  `docs/architecture.md`.
- **Structured details** (or **the block**): a schema.org block stating who and where a business
  is, composed by rule from what its location holds and nothing else, for the owner to paste into
  the page the on-page check reads. Not a draft: no model writes it.
- **Action plan**: the ordered steps shown as "What to do next", composed by rule from the sources
  and the on-page check. A step states an observation; it does not promise a result.
- **Source kind**: what sort of site a source is, which decides what an owner can usefully do
  about it: a review platform that lets a business ask for reviews, one that forbids it, a
  directory, or an editorial page.
- **Task**: one piece of work that follows from one source, sized to finish in about fifteen
  minutes when the owner does it themselves, and marked done by the owner or by the action that
  did it. A step of the action plan states an observation; a task is the work that follows from
  it. See `docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md`.
- **Page task**: the work of publishing a page on the business's own site that answers one of its
  prompts, because no answer to that prompt named the business. Marked done by the owner or by the
  action that published it, and shown with how often the answers to that prompt named the business
  before and since. Not a task about a source: it follows from a prompt.
- **Page copy**: the draft for a page task: a title and the page under it, ending with a line
  composed by rule from the location's details.
- **Listing**: a business's own page on a site, as its owner gave it: where a customer is sent to
  find the business there. One for a location on a site, kept for the location and not for the
  task that asked for it. Not the page an assistant cited, which is often a list or somebody
  else's page. The product does not look for a listing and does not open one.
- **Review link**: the link Google gives a business to ask its customers for reviews with, which
  its owner copies from the business's Google profile. It is what an owner gives for Google in
  place of a listing, and what a customer is sent, since it opens where a review is written. Not
  made from anything a location holds: the owner gives it.
- **Request to send**: a short message asking a customer for a review, which an owner copies from
  a review task and sends themselves, from their own address or phone. Composed by rule from the
  business's name, the site's name and the link a customer is sent. It asks every customer alike
  for what they honestly thought, and offers nothing. Not a review request, which the product
  sends, and not a draft, which a model writes.
- **Code to print**: the link a customer is sent, drawn as a QR code for an owner to print on a
  card or save as a picture. A customer points a phone's camera at it and the link opens. It
  holds the site's own address and none of the product's, so nothing passes through the product
  and nothing is counted.
- **Visit from an assistant** (or **visit**): an arrival on a business's own site that says it
  came from an assistant: the visitor's browser names the assistant's site, or the address
  carries the assistant's own tag. Counted, never recorded: what is kept is how many there were on
  a day, from an assistant, on a page, and nothing about the visitor. Not a result of a scan, and
  it says nothing of how often the business is named.
- **Line to paste** (or **the line**): one line an owner pastes into their own site, once, so
  that the site reports its visits from assistants. It reports nothing about any other visit.
- **Line check** (or **check**): an owner opening their own site through a marked link, so that
  the line reports it is there. Noted with its day, and never counted as a visit.
- **Site key**: what the line carries to say which location a visit is for. Anyone who opens the
  site's source can read it, so it is no secret, and an owner or admin can replace it.
- **Alert**: a statement that something measured has changed at a location in a way its owner
  would want to know, composed by rule from what the scans recorded and saying what was counted.
  It is shown from the scan that raised it until a later scan clears it or a member dismisses
  it. Not a task or a step: it says what was seen, never what to do. See
  `docs/adr/0015-an-alert-is-kept-not-worked-out-again.md`.
- **Drop**: the alert that a prompt on one assistant, or a keyword on one Google surface, named
  the business and has stopped: none of its latest three checks did, and at least three of the
  four before them did.
- **First sighting**: the alert that the written answers have begun to name a business, or to
  cite a site, that no written answer of any earlier scan on record named or cited. Said once,
  and of the whole record, not of the scan window.
- **Draft**: wording written for one of an owner's tasks: the note to a page's author, the
  description for a listing, or the copy for a page task. A member asks for it, a model writes it, and it is labelled as a
  model's. It states nothing about
  the business beyond what the location holds and what its owner said it does. There is one for
  a task, and writing it again replaces it. The owner sends or publishes it themselves, or
  approves an action that does. Never a measurement, a step or a recommendation. See
  `docs/adr/0016-the-worker-writes-a-draft.md`.
- **What we do**: a few sentences in an owner's own words on what the business does. The one
  thing a draft may state about the business that the location's other details do not hold.
- **Sample text**: what stands where a draft goes on sample data and for a test organization.
  Generated from the same details, written by no model, and labelled as that.
- **Connection**: an owner's standing sign-in to an outside account where a business's work
  happens: its Google profile, its website, its visitor statistics, a customer source. Made once
  and synced from on a schedule.
- **Sign-in**: what a connection keeps so the product can act for the owner at the outside
  service. Sealed by the Worker and read only by the worker, never shown to anyone. See
  `docs/adr/0013-a-sign-in-is-sealed-by-the-worker.md`.
- **Broken connection**: one that cannot be read from: the outside service refused the sign-in,
  which waits for its owner, or reading from it failed three days in a row, which is still tried
  once a day and mends itself.
- **Paused connection**: one of a kind the organization's plan no longer includes. Nothing is read
  from it or done through it, and its sign-in is kept for thirty days. An answer subdomain, which
  has no sign-in, keeps serving its pages for thirty days, then sends visitors to the business's
  site for ninety more, and is removed after that.
- **Answer subdomain**: a subdomain of a business's own domain, such as `answers.` in front of it,
  which the owner points at the product with one DNS record, once, so that pages can be hosted
  there. A connection with no sign-in: the record points at a target of its own, and the name is
  registered to be served only once it does. "Answers" is only its suggested name.
- **Hosted page**: a page task's copy served by the product on a location's answer subdomain, as
  plain HTML, once a member approved it. Taken back, its address answers that it is gone. Not a
  page on the business's own site, which is the owner's or, through WordPress, published there.
- **Pages Worker**: the second Worker, which serves hosted pages and nothing else, and holds no
  secret. See `docs/adr/0019-hosted-pages-are-served-by-a-worker-of-their-own.md`.
- **Choice**: one thing a connection's sign-in reaches at the outside service: a profile, a site,
  a property. A sync finds them.
- **Match**: which choice is a location's. A location has one match for each kind of connection,
  and a choice is one location's.
- **Customer source**: a connection that tells the product who a business's customers are and
  when their job was finished.
- **Action**: one thing the product does outside itself for a business: a fact corrected, a
  review answered, a post or a page published, a review request sent. Not a step of the action
  plan, which only states an observation.
- **Proposal**: an action waiting for a member's answer. The worker makes it from what it read, and
  it lapses if nobody answers in fourteen days.
- **Approval**: a member's yes to one action, before it is carried out.
- **Taking back**: undoing what an action did, asked for by a member after it was done. It is a
  new action that removes only what the first one put there, and is not proposed again. See
  `docs/adr/0018-on-a-business-site-the-product-changes-only-what-it-made.md`.
- **Standing permission**: an owner's or admin's yes in advance to every action of one kind, so
  the product acts first and tells the owners afterwards. It can be taken back.
- **Action notice**: the message that tells an organization's owners what an action changed, sent
  within 48 hours of it.
- **Hold**: the stop on carrying anything more out for an organization while its owners have not
  been told of an action in time. It lifts when they are told.
- **Review request**: one message from the product to one of a business's customers, asking for a
  review on a site that lets a business ask. Sent to every customer alike, once, offering
  nothing.
- **Customer contact**: a customer's name and their email address or phone number, held only to
  send a review request and deleted afterwards.
- **Organization role**: what a person may do inside one organization: owner, admin or member.
  Whoever creates an organization is its owner. It says nothing about the product as a whole.
- **Platform role**: what an account is to Nearcited itself, apart from any organization. Most
  accounts have none. Never called "owner", which is an organization role.
- **Operator**: the platform role of the person who runs Nearcited.
- **Test account**: an account held by automation, not by a person, used to exercise the product.
  Its platform role is `test`.
- **Test organization**: an organization created by a test account. Its scans run on generated
  sample data and say so, and it is never a customer.
- **Plan**: something on sale: a monthly price and what an organization on it may do. An
  organization is on one plan, or on none when its limits were **set by hand**. See
  `docs/adr/0006-plans-are-rows.md`.
- **Subscription**: an organization's standing arrangement with the payment provider to pay for a
  plan each month. It lives at the provider; the app keeps only its ID and last reported status.
  **In force** while paid or while a failed payment is being retried; **ended** when cancelled or
  left unpaid, which moves the organization to the free plan. See
  `docs/adr/0007-the-payment-webhook-acts-as-the-worker.md`.
- **Price version**: one set of prices a plan has been sold at: the plan's own, its extra
  location's and, where it sells one, a stronger model's. A plan's row carries the newest, which a
  new subscriber pays; `plan_prices` keeps them all, and a subscriber goes on paying the version
  they joined at until they are moved.
- **Price change**: an announcement, for one plan, that its current subscribers will move to its
  present price version from a named day. It is not setting a plan's price, which affects only new
  subscribers. See `docs/adr/0008-a-price-change-reaches-subscribers-by-announcement.md`.
- **Allowance**: what a plan allows of one kind of work the product does for an owner: included or
  not, or a number a month for each location the plan covers. A limit caps what an owner sets up;
  an allowance says what work is done for them. See
  `docs/adr/0012-a-plans-allowances-are-one-set.md`.
- **Tier**: the model an assistant is asked with for an organization. **Standard** is the one the
  deployment checks everyone with; **Stronger** is a more capable one its owner pays for on that
  assistant, a month on top of the plan, on a plan that includes stronger models. Each result
  keeps the tier it was asked on, and a prompt on one tier is a different cell from the same prompt
  on the other. See `docs/adr/0021-a-stronger-model-is-a-line-of-the-plans-price.md`.
- **Reduction**: a lower limit on a plan somebody pays for, a report that stops, or an allowance
  taken away or made smaller. It is announced for a day at least thirty days out and made for the
  whole plan on that day, not at once as a raise is. See
  `docs/adr/0009-a-reduction-is-announced-like-a-price-rise.md`.
- **Included location**: a location a plan's price covers. An **extra location** is one beyond
  those, paid for separately.
- **Paused location**: a location its organization's plan no longer covers. It is not scanned and
  everything measured stays readable.
- **Set aside**: said of a prompt made inactive because the plan covers fewer. A larger plan
  restores it. A **retired** prompt is one its owner made inactive, which no plan restores.
- **Export**: everything an organization holds, as a ZIP its owner downloads at any time: a
  spreadsheet for each list and all of it in one file another tool can read. It holds no sign-in,
  nothing of the operator's record of changes and nothing about what the providers were paid. See
  "Downloading everything" in `docs/architecture.md`.
- **Closing**: an owner ending their account. The organization is out of reach from the ask, and
  the worker cancels the subscription, removes each connection, deletes the organization and the
  owner's sign-in, and sends one email. It cannot be undone. Only a fingerprint of the owner's
  address is kept, for thirty days, so a new organization made from it starts with its free first
  scan used. See `docs/adr/0020-the-worker-closes-an-account.md`.
