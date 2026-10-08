---
status: accepted
---

# Platform roles are separate from organization roles, and automation gets a test account

Until now the only roles were inside an organization (owner, admin, member), and everything
automated used the secret key, which bypasses row-level security and can read or change every
customer's data. Two needs did not fit: saying who runs Nearcited, and letting automation sign in
to check that a deployment works without that key and without spending money on real scans.

We add a **platform role** per account, in its own table that no API role can write: `operator`
for the person who runs the product, `test` for an account held by automation. Most accounts have
none, and nothing a user can call grants one. Organization roles are unchanged: whoever creates an
organization is still its owner.

A **test account** is an ordinary sign-in with one difference: every organization it creates is a
**test organization**. A test organization's scans run on generated sample data, are recorded as
sample data, and are shown under the sample-data banner, in a deployment that is otherwise live.
Its limits are roomy and it is never billed. Because row-level security already confines an
account to the organizations it belongs to, a test account can only ever touch test
organizations; it needs no extra policy to keep it out of real ones.

That makes sample data a property of the organization as well as of the deployment. The rule that
generated data must never pass as real still holds, by the same two means as before: each scan
records `sample_data`, so sample and real results never share a window, and the interface shows
the banner whenever what it is showing is generated.

Beta features are not a role. When the first one exists, it will be a flag an organization's
owner opts into, with the operator able to override it; nothing is built for that yet.

## Considered options

- **A `test` role with elevated permissions for people.** Rejected: a role that means "more than
  a user" invites vague power, and a tester who is also a customer could not be both. The need
  was for automation, which wants less power than the operator, not more.
- **Keep using the secret key for automated checks.** Rejected: a smoke test would hold a key that
  can read every organization, and could only test the product by spending on real scans.
- **A separate staging deployment on sample data.** Rejected for now: it checks a copy, not the
  deployment that was just made, and doubles what has to be kept running. It remains the place
  for end-to-end tests in CI, which run against a local stack.
- **Roles in the sign-in token's metadata.** Rejected: the project keeps authorization in tables
  the policies can read, and a token outlives a change to it.

## Consequences

- `PROVIDER_MODE` is no longer the only thing that decides whether a scan is generated. Code that
  asks "is this sample data?" must ask about the organization too.
- The operator sets platform roles directly in the database. There is deliberately no interface
  for it.
- A test account's password is a production secret, and belongs with the others.
