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
- **Action plan**: the ordered steps shown as "What to do next", composed by rule from the sources
  and the on-page check. A step states an observation; it does not promise a result.
- **Source kind**: what sort of site a source is, which decides what an owner can usefully do
  about it: a review platform that lets a business ask for reviews, one that forbids it, a
  directory, or an editorial page.
- **Task**: one piece of work that follows from one source, sized to finish in about fifteen
  minutes when the owner does it themselves, and marked done by the owner or by the action that
  did it. A step of the action plan states an observation; a task is the work that follows from
  it. See `docs/adr/0011-the-product-does-the-work-and-the-owner-approves.md`.
- **Draft**: text a model wrote, labelled as such. The owner sends or publishes it themselves, or
  approves an action that does. Never a measurement, a step or a recommendation.
- **Connection**: an owner's standing sign-in to an outside account where a business's work
  happens: its Google profile, its website, its visitor statistics, a customer source. Made once
  and synced from on a schedule.
- **Customer source**: a connection that tells the product who a business's customers are and
  when their job was finished.
- **Action**: one thing the product does outside itself for a business: a fact corrected, a
  review answered, a post or a page published, a review request sent. Not a step of the action
  plan, which only states an observation.
- **Approval**: a member's yes to one action, before it is carried out.
- **Standing permission**: an owner's or admin's yes in advance to every action of one kind, so
  the product acts first and tells the owners afterwards. It can be taken back.
- **Action notice**: the message that tells an organization's owners what an action changed, sent
  within 48 hours of it.
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
- **Price version**: one pair of prices a plan has been sold at: the plan's own and its extra
  location's. A plan's row carries the newest, which a new subscriber pays; `plan_prices` keeps
  them all, and a subscriber goes on paying the version they joined at until they are moved.
- **Price change**: an announcement, for one plan, that its current subscribers will move to its
  present price version from a named day. It is not setting a plan's price, which affects only new
  subscribers. See `docs/adr/0008-a-price-change-reaches-subscribers-by-announcement.md`.
- **Reduction**: a lower limit on a plan somebody pays for, or a report that stops. It is
  announced for a day at least thirty days out and made for the whole plan on that day, not at once
  as a raise is. See `docs/adr/0009-a-reduction-is-announced-like-a-price-rise.md`.
- **Included location**: a location a plan's price covers. An **extra location** is one beyond
  those, paid for separately.
- **Paused location**: a location its organization's plan no longer covers. It is not scanned and
  everything measured stays readable.
- **Set aside**: said of a prompt made inactive because the plan covers fewer. A larger plan
  restores it. A **retired** prompt is one its owner made inactive, which no plan restores.
