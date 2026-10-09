---
status: accepted
---

# The operator changes an organization's limits through one function, which records the change

[0004](0004-the-operator-reads-through-policies.md) made the operator's view read-only and had the
database guarantee it. The first thing the operator needs to change is what a customer's plan
allows: how many locations, how many prompts each, how many scans by hand in a day, and how often
it is scanned. Until now that took the secret key and a statement typed against production.

We add **one database function, `operator_set_limits`**, and no policy. It answers the operator
and nobody else, changes those four columns and nothing else, and in the same transaction writes a
row to `operator_actions` saying who changed which organization from what to what. The operator's
request reaches it through the same store as any other request. For anyone else it returns no row,
which the API reports as an organization that does not exist.

The record is a table no API role can write, the operator included: a row exists only because the
function made a change. The operator may read it.

Making a shareable audit follows the same shape: `operator_create_audit` inserts the audit for the
operator alone and records that it did. The request then queues it. An audit spends real money at
the providers, which is why it is recorded, and a deployment serving sample data refuses to make
one.

Which assistants an organization is checked on, whether it is a test organization, and who holds
a platform role are still set only with the secret key.

## Considered options

- **An `update` policy for the operator on `organizations`.** Rejected: a policy opens whole rows,
  so the column grant would have to carry the limit, and the member's grant covers `name` alone for
  a reason. It would also leave no record, and it would undo the guarantee in 0004 that the
  operator's policies cannot change anything.
- **A route that uses the secret key behind a role check.** Rejected for the reason given in 0004.
- **Keep using the secret key by hand.** Rejected: it is the riskiest way to make the commonest
  change, and it records nothing.

## Consequences

- "The operator can change nothing" is now "the operator can change what a named function lets
  them". Each further action is its own function, with its own test that nobody else can call it
  and its own row in `operator_actions`. Still no policy that writes.
- Lowering a limit below what an organization already has removes nothing. The limits are checked
  when something is added.
- The record covers changes, not reading. 0004's note about an access log still stands.
