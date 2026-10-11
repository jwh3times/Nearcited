---
status: accepted
---

# The operator reads every organization's data, through policies, and can change none of it

The person who runs Nearcited needs to see what is broken and to help a customer who asks, which
means seeing every organization's locations, scans and results. Until now the only way to do that
was the secret key, which bypasses row-level security, and the rule is that no request path uses
it.

We give the `operator` platform role a **`select` policy on every table**, checked by one
function, `is_operator()`. The operator's requests run as the operator, through the same store and
the same routes as anyone's, and the database decides what they see. Because only `select`
policies are added, the database also guarantees the view is read-only: an operator who tries to
change another organization's data is refused or matches no row, whatever the code above it does.

Two tables that were closed to the API roles outright, `audits` and `provider_usage`, now grant
`select` to signed-in accounts and carry the operator's policy and no other. A member may ask them
and is told nothing. This is the one change to
[0002](0002-audits-are-read-by-token.md): a reader still gets an audit only through
`get_audit(token)`, but the table is no longer unreachable, only empty to everyone but the
operator.

Reading is one thing and belonging another. "My organizations" used to mean "every organization
I can read"; it now means membership, asked for through `my_organizations()`, so the operator's own
account still has exactly one organization.

## Considered options

- **An operator API that uses the secret key behind a role check.** Rejected: it breaks the rule
  that request handlers never bypass the policies, makes one `if` the only thing between a bug and
  every customer's data, and would have to re-implement read-only by being careful.
- **Functions that return only summaries.** Rejected as the whole answer: counts cannot explain why
  one customer's scan looks wrong, which is what the view is for. Summaries can still be built on
  top of the policies.
- **Signing in as the customer.** Rejected: it lets the operator change a customer's data by
  accident, and would carry the operator past the limits on that customer's plan.

## Consequences

- Code that lists rows and relies on row-level security alone to scope them now returns everything
  to the operator. `listOrganizations` was the one such query and is fixed here; a new one must
  filter by what it means, not by what the caller can see.
- The operator's looking is not recorded. That is acceptable while the operator is one person and
  must change before a second account is given a platform role: add an access log then.
- An operator's account is as sensitive as the secret key for reading. It can read every audit's
  token, and what every organization's scans used.
- Note (October 2026): "can change none of it" held until
  [0005](0005-the-operator-changes-limits-through-one-function.md). The operator still has
  `select` policies only. What the operator now changes (an organization's limits, a plan's
  settings and prices, and the announcements in 0008 and 0009) goes through functions that answer
  only the operator and record the change, never through a policy that writes.
