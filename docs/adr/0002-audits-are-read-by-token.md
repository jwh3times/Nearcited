---
status: accepted
---

# A shareable audit is read by its token, through one function

A shareable audit (issue #5) is a report for a business that has no account, read by someone who
is not signed in. Every other table is guarded by row-level security policies that ask whether the
caller is a member of the row's organization. An audit has no organization and its reader has no
identity, so there is nothing for a policy to test.

We keep the `audits` table **closed to the `anon` and `authenticated` roles outright** and let a
reader in through a single `SECURITY DEFINER` function, `get_audit(token)`. It looks an audit up
by the 64-character random token in its link, returns only the fields the page shows, and returns
nothing once the audit is revoked or past its expiry. The API route calls it with an anon-key
client, so the rule that no request path uses the admin client still holds. Only the owner creates
an audit, with the secret key, from `scripts/create-audit.mjs`; no endpoint does.

Holding the link is the permission. That is the trade: a forwarded link is a shared report, and the
defences are that a link expires after 30 days and can be revoked.

## Considered options

- **A `select` policy for `anon` that matches on the token.** Rejected: a policy cannot see the
  filter a caller sends, so any policy that lets `anon` read a row by token lets `anon` list every
  row. Passing the token in a request setting would work but hides the check in two places.
- **Reading with the admin client in the route.** Rejected: it breaks the rule that request
  handlers never bypass the policies, and it would make the route's own code the only guard.
- **Signed, self-contained links (the report in a signed token).** Rejected: a link could not be
  revoked, and a report is too large for a URL.
- **Requiring the reader to sign up first.** Rejected: the audit exists to show a prospect their
  result before they have a reason to.
