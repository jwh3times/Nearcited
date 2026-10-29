---
status: accepted
---

# A site's fetches are read from its Cloudflare zone

An assistant's fetcher reads a page without running its scripts, so the line on a business's site
never sees it (#139), and a fetch shows up only where the request was served. Hosted pages are
counted by the Pages Worker as it serves them (ADR 0019). Issue #156 counts the fetches of the
business's own site, which the product does not serve.

**The count comes from a Cloudflare connection.** The owner makes a token that can only read the
zone's analytics and gives it to the product, sealed as any sign-in is (ADR 0013). The worker reads,
once a day, how many requests each fetcher made for each page of the location's website host, and
the thirty days before on the first read. Cloudflare is the one source that answers on every plan,
its free one included, with fetcher, page and hour through an API, and it counts at the edge, so a
page served from a cache is counted too. It reaches only sites behind Cloudflare. A site that is not
is told so, plainly, and nothing is counted for it.

**A fetcher is known by the name it gives.** Below Cloudflare's Enterprise plan a request is known
only by its user agent, so a fetch is mapped to a fetcher the same way a hosted page's is, from one
list of fetchers. Anyone can give a fetcher's name, so, as with visits (ADR 0017) and hosted pages'
fetches, nothing is worked out from the count: no score, alert, task, report or bill.

**The count is Cloudflare's estimate.** Its request data is sampled on a busy zone and scaled up, so
what is kept is a whole number and the page says "about". On a small site it is usually exact.

**One zone, one location.** The zone holding a location's website host is that location's, as any
choice is one location's. Locations that share the website say where its fetches are counted, and
no fetch is shown twice.

## Considered options

- **A WordPress plugin that reports each fetch.** Rejected for now: a page cache or a network in
  front of the site serves most fetches without running the plugin, so it undercounts by an
  amount nobody can state, and it is code of ours on the owner's site, reporting to a route that
  must trust what it is told.
- **The website builders' statistics.** Rejected: none of Wix, Squarespace, Shopify, Duda or GoDaddy
  lets another service read its crawler figures.
- **Access logs from the host, or uploaded by the owner.** Rejected for now: few hosts offer them to
  another service, and an upload is done once and then not again.
- **Cloudflare's verified bot identities.** Rejected: they need its Enterprise plan, which a local
  business is hardly ever on, and nothing rests on the count anyway.

## Consequences

- Fetches are counted for a location only where its website is behind Cloudflare. The others can
  have a plugin or log source of their own later, beside this one.
- Fetches of the business's own site and of its hosted pages are counted and shown apart.
- The token reads the zone's request counts and nothing else, so it is the narrowest sign-in the
  product keeps.
