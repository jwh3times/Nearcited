---
status: accepted
---

# A Cloudflare token lists its zones, and the first read is what the zone keeps

[0028](0028-a-sites-fetches-are-read-from-its-cloudflare-zone.md) had the owner give a token that
"can only read the zone's analytics", and the worker read "the thirty days before" on the first
read. Building it (#156) changed both, with the owner's say-so. The rest of 0028 stands.

**The token also lists the zones it reaches.** It needs Zone › Zone › Read beside Zone › Analytics ›
Read. The worker matches each zone to a location by itself, so it has to learn which zones a token
reaches, and only Cloudflare's `GET /zones` says that, on that permission alone: the analytics
answer only for a zone whose ID is already known. The token still changes nothing. Of what it can
read about a zone, the worker keeps the ID and the name.

**The first read goes back as far as the zone keeps its request counts, up to thirty days.** How far
is a matter of the zone's plan, and Cloudflare says how far for each zone, so the worker asks it
before every read and asks for no day older than that. Thirty days stays the most it reads.

## Considered options

- **Keep the token to analytics alone, and have the owner give the zone's ID.** Rejected: that is a
  match made by hand, which 0028 and the rule for connections do without, and one more thing an
  owner has to find in Cloudflare and can get wrong.
- **Write the number of days a plan keeps into the code.** Rejected: it would go wrong without a
  sound when Cloudflare changed a plan, and Cloudflare answers the question itself.

## Consequences

- 0028's last consequence no longer holds as written. The token reads the details of the zones it
  reaches as well as their request counts, so an owner who scopes it to all zones shows the product
  the names of all of them. Scoping it to one zone is offered in the steps the owner follows.
- A new connection may start with fewer than thirty days, and on a plan that keeps less it reaches
  thirty only by reading day after day.
- Days the worker failed to read until the zone stopped keeping them are gone, and nothing fills
  them in.
