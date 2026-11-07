---
status: accepted
---

# Receipts arrive as subaddresses of one mailbox

A location's receipt address is a name of its own, 32 hex characters the database keeps, so that
one location's address says nothing about another's
([0031](0031-a-customer-contact-is-read-only-by-the-worker.md)). The first version wrote it at a
subdomain, `<name>@receipts.nearcited.com`, and expected Cloudflare Email Routing to send every
name there to the Worker with one catch-all rule. Email Routing allows a catch-all only at a
zone's apex. A subdomain takes literal rules, one for each address, and a zone has at most 200.
It also adds a subdomain only for a zone that already has Email Routing on, which replaces the
apex's MX records (issue #300).

**A receipt address is a subaddress of one mailbox: `receipts+<name>@nearcited.com`.** Email
Routing's subaddressing is turned on for `nearcited.com`, and one rule sends
`receipts@nearcited.com` to the Worker. Cloudflare matches `receipts+<name>@nearcited.com` to that
rule and hands the Worker the full address, which `receiptName`
(`packages/shared/src/review-requests.ts`) reads back to the name. An address in any other form
is nobody's and is refused. The name the database keeps did not change, only how it is written
out.

**`nearcited.com`'s own mail moves to Email Routing with it.** Each address the business uses
forwards to a mailbox elsewhere, and replies go out through Resend's SMTP, which already sends the
app's mail.

## Considered options

- **A domain of its own for receipts**, with Email Routing and a catch-all at its apex, leaving
  `nearcited.com`'s mail where it was. Rejected: it costs a registration, and the product would
  have two domains to keep.
- **Reading a mailbox over IMAP** instead of receiving through Email Routing. Rejected: more code,
  and the Worker would have to trust another provider's authentication header, where
  `readReceipt` trusts Cloudflare's own.
- **A rule for each address, written through Cloudflare's API** as an address is made. Rejected:
  it stops at 200 locations, and the Worker would need a token that can change the zone's routing.

## Consequences

- Receipts arrive only once the rule and subaddressing are set up on the zone, an owner step in
  the README's Deploy section.
- Every address at `nearcited.com` is the product's, so a receipt address in a receipt's `To:` is
  never taken for its customer.
- An address in the old form never received anything, since nothing routed it, so changing the
  form needed no notice to owners.
