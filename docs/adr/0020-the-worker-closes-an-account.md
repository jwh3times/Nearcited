---
status: accepted
---

# The worker closes an account, and a fingerprint of the address outlives it

Until issue #104, an owner who wanted their account gone wrote in, and the operator deleted the
organization by hand with the secret key. #103 had already taken away the owner's own delete,
because deleting an organization and making another reset the free first scan and the month's
counts. Issue #210 is the spec for closing an account from Account settings, and for downloading
everything first.

**Deleting the rows is not closing the account.** Every table under an organization cascades, so
one `delete` empties it. That would leave three things behind it:
- each connection's access standing at the outside service;
- an answer subdomain registered at Cloudflare with nobody to answer for it;
- a paid subscription still billing at Stripe.

It would also leave the owner's sign-in, free to make a new organization with a new free first
scan. Closing has to do all of those, and some of them call outside services that can fail.

**A request records the ask, and the worker closes.** `request_closing()` answers an owner of the
organization and nobody else. It refuses the operator, a test account and a test organization,
which are closed by hand if at all. The owner types the organization's name to say they mean it.
The function:
- marks the organization closing;
- marks every connection for removal, with `closing` as the reason;
- keeps a record of the closing.

The route then queues the worker, and the owner is signed out. This is the shape of actions,
drafts and connection removals ([0014](0014-only-the-worker-carries-out-an-action.md)): only the
worker uses the secret key, and deleting a sign-in needs it.

**The worker goes in an order where each step can be run again.**
1. It cancels the subscription at Stripe at once, with no proration: the terms already say a
   part-month is not refunded.
2. It removes each connection the way an owner's removal does. A WordPress password is asked
   back once. A site that cannot be asked is named in the email, and the closing goes on, since
   someone else's server must not hold it up. An answer subdomain is ours to let go, so the closing
   waits until Cloudflare has.
3. It deletes the organization.
4. It deletes the owner's sign-in.
5. It sends one email to the owner, and a note to everyone else.

Each step is written on the closing's record as it is done, the emails included, so a retry, or
the fifteen-minute sweep that picks up a closing nobody finished, carries on from there. A worker
takes the closing before it starts (`claim_closing()`), so two never run it at once.

**From the ask, the organization is out of reach.** The helpers every policy asks
(`is_org_member()`, `has_org_role()`, `can_access_location()`, `can_access_scan()`) answer no
for an organization being closed. Its members can neither read nor change anything, and
`billing_state()` and `choose_assistants()` no longer answer its owner, so no checkout starts for
it. The schedule scans nothing for it, and the worker emails nobody about it but the closing. `organization_held()` holds its actions, and `claim_draft()` writes nothing
for it. The minute or two the worker takes is not a window for anything else to happen.

**The record outlives the organization, and then keeps only a fingerprint.** The closing email
goes after the organization and the sign-in are gone, so what it needs is kept on a record of its
own with no foreign key to either:
- the addresses it goes to;
- whether a subscription was cancelled;
- the sites that kept their access;
- the subdomains whose DNS records the owner can now delete.

No API role reads the record. Once the email has gone, the addresses and notes are cleared. What
stays for thirty days is a SHA-256 of the owner's email, trimmed and in lower case, and the day.
`create_organization()` starts an organization made from that address meanwhile with its free
first scan already used. Then the schedule deletes the record. A different address still gets a
new account, as #103 accepted.

**What the owner added to a WordPress site stays.** Disconnecting already leaves it
([0018](0018-on-a-business-site-the-product-changes-only-what-it-made.md)), and taking back each
thing would hold the closing on a site that may be down. The confirmation says so before the owner
confirms.

**Downloading everything is the owner's, and needs one database function.** The terms promise a
chance to take your information with you. `export_organization()` answers an owner alone with
everything the organization holds, as one value, so the database's API, which answers a request
with at most 1,000 rows, never cuts a list short. It is `security definer` because it reads the
members' email addresses, and it checks the owner and reads by organization the way
`billing_state()` does. It never holds a sign-in, the operator's record of changes, or what the
providers were paid.

## Consequences

- A closed account cannot be reopened. There is no waiting period and no undo.
- Stripe keeps its customer and invoice records, which are tax records. The provider costs and the
  operator's record of changes are kept without the organization, as before.
- A sign-in can be deleted while an organization it made exists: `organizations.created_by` is set
  to null instead of refusing.
- Nothing else adds a way to delete an organization or a sign-in from a request.
