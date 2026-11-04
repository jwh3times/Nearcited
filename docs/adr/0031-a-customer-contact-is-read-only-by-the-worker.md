---
status: accepted
---

# A customer contact is read only by the worker

[0011](0011-the-product-does-the-work-and-the-owner-approves.md) has the product ask a business's
customers for reviews, and says what is kept about them: their address and the day of the job,
deleted 30 days after the request is sent, and afterwards only whether the address was asked and
whether it opted out. That says how long a customer contact is kept. Issue #146 settled who may
read one while it is.

**Nobody reads a customer contact in full but the worker, which sends the request.** Members,
admins, owners and the operator alike see it masked, as `j•••@gmail.com` and the day, which is
enough to approve or decline a request. No route or wire type carries the full address, and
`export_organization()` leaves contacts out. The owner already has the address in the tool that
sent the receipt; the product holding it adds nothing for them to read.

**What remains is a fingerprint.** The record that this address was asked, or opted out, is kept
as a keyed fingerprint of the address, which answers "this one again?" and cannot be read back.
The opt-out and the twelve months without a second request hold for the whole organization, so a
customer who opted out with one location is not asked by another.

**A bounce or a complaint stops every business.** A hard bounce or a spam complaint stops review
requests to that address from the product as a whole, kept as a fingerprint the same way. The
sending address is the product's, so one business's bad list would cost every business its
delivery.

## Considered options

- **Owners and admins see the full address**, to check a request before approving it. Rejected.
  The masked address and the day tell them which customer it is, every reader of a full address
  is one more place it can leak from, and once shown it cannot be taken back.
- **A suppression for each organization only.** Rejected. A complaint is about the product's
  sending address whichever business caused it, and an address that bounced will bounce for the
  next business too.

## Consequences

- An owner who wants the full address looks in their own tool. Support cannot look one up either.
- Turning review requests off, or the plan no longer including them, deletes every contact at
  once, sent or not, and keeps the fingerprints, so turning it on again asks nobody twice.
