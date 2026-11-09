# Changelog

Every merge to `main` is a release: it is tagged `v<major>.<minor>.<build>`, and its section below
names the version it mints. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html), with the patch number
counting builds on a release line.

## [Unreleased]

No unreleased changes.

## [1.6.0] - 2026-11-09

### Added

- Customer contacts are deleted once they are no longer needed (#294, part of #146). No plan
  includes review requests yet, so no real customer's contact is kept.
  - **After a request:** the daily run deletes a contact 30 days after its review request was
    sent. A contact whose request was declined, lapsed or failed is deleted once the week after the
    job is over, when it can no longer be asked for again. The request itself stays on the list,
    with nothing of the customer's.
  - **Turning them off:** turning a location's review requests off, or the plan no longer
    including them, deletes every contact of the location at once, sent or not, and the receipt
    address stops receiving. A request still waiting is not sent, and the list shows it as "Not
    sent: review requests stopped for this location".
  - **Kept:** whom a business asked, who opted out and which addresses bounced or complained stay
    as fingerprints, so turning review requests on again asks nobody twice.

## [1.5.0] - 2026-11-07

### Added

- A customer can stop a business's review requests in one click, and an address that bounces
  or complains is never asked again (#293, part of #146). No plan includes review requests yet,
  so nothing is sent to a real customer.
  - **The opt-out page:** the link in every review request opens a page that needs no sign-in.
    Nothing changes until the customer clicks "Stop these emails", so a mail scanner opening the
    link does nothing. The click stops review requests to that address from every location of
    the business, and from no other business.
  - **One-click unsubscribe:** every request also carries the `List-Unsubscribe` and
    `List-Unsubscribe-Post` headers, so a mail client's own unsubscribe button does the same. A
    mail client that opens the link in a browser instead lands on the page.
  - **Bounces and complaints:** Resend reports them to a webhook at `/api/resend/webhook`,
    checked against `RESEND_WEBHOOK_SECRET`. A hard bounce or a spam complaint about a review
    request stops every business asking that address. Soft bounces are not retried, and reports
    about Nearcited's own emails (scan reports, invitations) change nothing. A request already
    waiting for a yes to such an address is not sent.
  - **Trusting nothing:** neither route is signed in or reads anything. Each checks the link's
    or the provider's signature, then leaves the recording to the worker. The opt-out answers
    the same for every address, on file or not. An address is kept only as a keyed fingerprint,
    which cannot be read back to it.

## [1.4.0] - 2026-11-07

### Added

- Review requests: a customer contact becomes a request for a review, which a member approves
  and the product emails to the customer the morning after the job (#292, part of #146). No plan
  includes review requests yet, so nothing is sent to a real customer.
  - **Proposing:** every 15 minutes the worker makes one request for each ready contact, in the
    wording the owner approved on the Settings tab. A location with no wording keeps its contacts
    waiting until a week after the job.
  - **Who is not asked:** a customer the organization asked in the last 12 months, from any of
    its locations, or who opted out of it, gets no request, and the contact is deleted. Both are
    checked against a keyed fingerprint of the address, which cannot be read back to it. Once the
    requests sent this month and those still waiting reach the plan's allowance, a customer is
    not asked either: the
    contact is deleted and the Settings tab counts them ("3 customers not asked: this month's
    allowance was used.").
  - **When it goes:** an approved request is sent at 10:00 in the location's time zone the day
    after the job, or at the next 10:00 if it was approved later. The Actions tab says when. One
    nobody approves lapses unsent at 10:00 a week after the job.
  - **What the customer gets:** an email under the business's name, from the product's sending
    address (`REVIEW_REQUESTS_FROM`), with replies going to the location's reply address. It has
    the approved wording, the link to the review form and a one-click opt-out link. The page the
    opt-out link opens comes in #293. Sending records the address as asked. Before sending, the
    worker checks again that the contact is still there, that nobody asked them or they opted
    out meanwhile, and that the wording is the one approved. If not, nothing is sent.
  - **Approving:** "Approve all N review requests listed" records one yes for each. After three,
    standing permission is offered, as for other actions, and under it requests go without a
    member's yes. A request that was sent cannot be taken back, so none offers a take-back.
  - **The daily notice** gives one line per location, for example "Riverside: 12 review requests
    sent, 3 waiting for a yes", and links to its Actions tab.
  - A test organization, sample contacts and a deployment on sample data send nothing. Without
    `REVIEW_REQUESTS_FROM` or `RESEND_API_KEY`, an approved request fails and says outgoing email
    for review requests is not set up.

## [1.3.3] - 2026-11-07

### Fixed

- A location's receipt address is now `receipts+<name>@nearcited.com`, a subaddress of one
  mailbox, so mail to it can reach the Worker (#300). The address 1.3.0 gave each location, at
  `receipts.nearcited.com`, could not: Cloudflare Email Routing has no catch-all rule for a
  subdomain, only one rule for each address. One rule now sends `receipts@nearcited.com` to the
  Worker, and Email Routing's subaddressing matches every location's address to it
  (`docs/adr/0032-receipts-arrive-as-subaddresses-of-one-mailbox.md`). The README's Deploy section
  says how to set that up.
  - The name a location keeps is unchanged. Its Settings tab and the owner's export write it in
    the new form, and a message to an address in any other form, the old one included, is
    refused.
  - Nothing was ever received at the old form, since nothing routed it, and no plan includes
    review requests, so nobody is told of the change. An owner who copied the old address onto
    their receipts copies the new one from the Settings tab.

## [1.3.2] - 2026-11-06

### Changed

- Dependency updates: `@anthropic-ai/sdk` 1.3.0 to 1.4.0, `hono` 4.13.14 to 4.13.16,
  `@cloudflare/workers-types` 5.20261031.1 to 5.20261103.1, `wrangler` 4.156.0 to 4.156.2,
  `@tanstack/react-query` 5.105.0 to 5.105.3, `@vitejs/plugin-react` 6.1.2 to 6.2.1,
  `@electric-sql/pglite` 0.5.13 to 0.5.14 and `vitest` 5.0.5 to 5.1.0.

## [1.3.1] - 2026-11-06

### Changed

- The project board gains a `Priority` field, from P0 (now) to P3 (later), set whether or not an
  issue is blocked, and its items are kept in that order. What to build next is now the open items
  with no open blocker and no gate, highest priority first, then the lowest stage.
- Issues carry a `blocked` label beside their triage label while they have an open blocker or wait
  on an outside party, so an issue list shows what can be picked up. The native issue dependency
  stays the record of what blocks what. `AGENTS.md`, `docs/agents/issue-tracker.md`,
  `docs/agents/triage-labels.md` and `docs/agents/human-follow-up.md` describe both. Nothing the product does changes.

## [1.3.0] - 2026-11-04

### Added

- Receipts copied to a location's receipt address are received, and each becomes a customer
  contact: the customer's email address and the day of the job, and nothing else (#291, part of
  #146). Nothing is proposed or sent to a customer yet, and no plan includes review requests.
  - **Receiving:** mail to `receipts.nearcited.com` reaches the Worker through Cloudflare Email
    Routing, a fourth way in beside the app, the schedule and the queue. Mail to an address that
    belongs to no location is refused.
  - **What counts:** a receipt counts only when Cloudflare found it passed DKIM or SPF for its
    sender's own domain, or DMARC. The customer is the one address in "To" that is neither the
    business's own nor Nearcited's, and the day of the job is the receipt's date in the
    location's time zone.
  - **Never guessed at:** a receipt that fails those checks, names no customer or more than one,
    comes from a declined sender, or arrives while review requests are off is dropped. Each is
    counted for the location by reason, and the Settings tab shows the counts for the last 30
    days.
  - **Senders:** receipts from a sender nobody has confirmed are held. An owner or admin confirms
    the sender as their own tool, which makes what it sent ready, or declines it, which deletes
    what it sent and drops what it sends later. What is held for seven days with nobody confirming
    is deleted. The daily email to the owners names a sender waiting.
  - **Who sees what:** nobody but the worker reads a customer's address in full
    (`docs/adr/0031-a-customer-contact-is-read-only-by-the-worker.md`). Members, owners, admins
    and the operator see it masked, as `j•••@gmail.com`, with the day, on the location's Settings
    tab. The download of an organization's data leaves contacts out.
  - A test organization, and a deployment on sample data, receive nothing: their receipts are made
    up once a day and marked as sample data.

## [1.2.0] - 2026-11-04

### Added

- An owner or admin can turn on review requests for a location, the first step of asking a
  business's customers for reviews by email (#146). Nothing is received or sent yet, and no plan
  includes them: they are tried on an organization whose limits are set by hand. Turning them on,
  from a card on the location's Settings tab, sets four things:
  - **Receipt address:** an unguessable address of the location's own, at
    `receipts.nearcited.com`, for the owner to copy receipts to. An owner or admin can replace it,
    and the old one then belongs to nobody.
  - **Site:** the site a customer is asked to review the business on. It starts on the one the
    answers cited most, among Google, BBB and Trustpilot where the location has a listing with a
    review form, and another can be chosen.
  - **Reply address:** where a customer's reply goes, starting as the owner's own address.
  - **Wording:** the email a customer would be sent, composed by rule with an opt-out line. It is
    read and approved as it stands, never edited.

  Turning them on is refused for a location with no time zone, for a category whose list of
  customers is confidential (medical, dental, mental health, legal, financial advice and the
  like), and without the owner's word that their list is not confidential and their customers
  expect to hear from them. Any member sees the settings, and a plain member or the operator cannot
  change them. They are turned off by removing the connection, and with their location. The export
  includes them.

## [1.1.0] - 2026-11-04

### Added

- A location keeps its time zone, so a morning can later be worked out where the business is. The
  location's details form has a Time zone field, an IANA name such as `America/Chicago` chosen from
  a list. For a location with none, it starts on the member's own browser time zone until they
  save. A name that is not a time zone, or a bare offset such as `+05:00`, is refused. Existing
  locations have none until someone sets one, and they load and save as before. The export
  includes it. Nothing reads it yet: asking customers for reviews by email (#146) will need it.

## [1.0.5] - 2026-11-03

### Changed

- The decisions for asking a business's customers for reviews by email (#146) are recorded ahead of
  the work. A new decision record says that only the worker, which sends the request, reads a
  customer's address in full, and that no member, owner or the operator does. It also says that an
  opt-out and the twelve months without a second request hold for the whole organization, and that
  a bounce or a complaint stops requests to that address from every business. The glossary now
  defines a customer contact as an email address and the day of the job, and adds the receipt
  address and the confirmed sender. Nothing the product does changes yet.

## [1.0.4] - 2026-11-03

### Fixed

- Every Supabase CLI command now runs one pinned version, a dev dependency of the root package:
  the documented commands, `pnpm local:env`, CI and the Deploy workflow, which applies the
  migrations to the hosted project. Before, each fetched the newest CLI, so a release that changed
  a default, as 3.0.0 did when it made the local stack the default target, reached developers'
  machines and production without a pull request. A newer CLI now arrives only through one.
- `pnpm db:types` runs from a fresh install, in the form the CLI accepts, and formats the types it
  writes so they pass the lint check. It needs the local stack running.

## [1.0.3] - 2026-11-03

### Changed

- Dependency updates from Dependabot: `resend` 6.35.0 to 6.37.0, and `@cloudflare/workers-types`
  5.20261030.1 to 5.20261031.1.

## [1.0.2] - 2026-11-03

### Changed

- The changelog check and the merged-migration check are now required to merge a pull request,
  and the README's Repository automation section says so.

## [1.0.1] - 2026-11-03

### Fixed

- The Deploy workflow reaches the hosted database over IPv4, through the project's shared pooler.
  GitHub's runners have no IPv6, so every Deploy since 1.0.0 stopped before applying a migration
  or deploying anything.

## [1.0.0] - 2026-11-03

The first versioned release. Nearcited had deployed to production since October 2026 without
version numbers; from this release on, every merge to `main` is tagged, recorded here, migrated and
deployed.

### Added

- Every merge to `main` is tagged with the next version and released on GitHub.
- The Deploy workflow runs after each merge is tagged: it lists the migrations the hosted project
  has not applied, applies them, and only then deploys both Workers. A failed migration stops the
  deploy. It can still be run by hand.
- CI fails a pull request that edits, renames or deletes a migration already on `main`, since the
  hosted project never applies it again (`scripts/check-migrations.mjs`).
- CI checks that `CHANGELOG.md` has a section for the version a pull request's merge will mint
  (`scripts/check-changelog.mjs`); a Dependabot merge gets its section on the next human pull
  request.

[Unreleased]: https://github.com/jwh3times/Nearcited/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/jwh3times/Nearcited/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/jwh3times/Nearcited/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/jwh3times/Nearcited/compare/v1.3.3...v1.4.0
[1.3.3]: https://github.com/jwh3times/Nearcited/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/jwh3times/Nearcited/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/jwh3times/Nearcited/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/jwh3times/Nearcited/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/jwh3times/Nearcited/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/jwh3times/Nearcited/compare/v1.0.5...v1.1.0
[1.0.5]: https://github.com/jwh3times/Nearcited/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/jwh3times/Nearcited/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/jwh3times/Nearcited/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/jwh3times/Nearcited/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/jwh3times/Nearcited/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jwh3times/Nearcited/releases/tag/v1.0.0
