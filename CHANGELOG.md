# Changelog

Every merge to `main` is a release: it is tagged `v<major>.<minor>.<build>`, and its section below
names the version it mints. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html), with the patch number
counting builds on a release line.

## [Unreleased]

No unreleased changes.

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

[Unreleased]: https://github.com/jwh3times/Nearcited/compare/v1.3.3...HEAD
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
