---
status: accepted
---

# Hosted pages are served by a Worker of their own

Issue #141 has the product serve pages on a subdomain of a business's own domain, its answer
subdomain, for a site whose builder offers no way in. Each answer subdomain is a custom hostname on
the `nearcited.com` zone (Cloudflare for SaaS), so its requests arrive at the same zone as the
app's, under every business's own name. This record is what answers them.

**A second Worker, the Pages Worker, serves hosted pages and nothing else.** It lives in
`apps/pages`, depends on the shared package alone, and is deployed with the main Worker. It is on a
`*/*` route on the zone, since a custom hostname's requests reach the zone's routes whatever its
name. Its routes are made in the dashboard by the setup and not by its deploy, so that deploying it
changes no traffic until the setup is done, and in the right order. The app, its API, its assets, the schedule and the queue stay the main Worker's.

**It holds no secret.** It has the database's address and the publishable key, which anyone can
read from the app's own bundle. It reads through one function any caller may call,
`hosted_page()`, which answers only for an answer subdomain that is live, and only with what the
page shows anyway: the page's words, and who and where the business is. A host the function does
not answer for gets a bare "Not found". It writes one thing, through a second such function,
`record_page_fetch()`: that a known assistant's fetcher or search engine's crawler read a live
page, kept as a count for a day, a page and a fetcher, which stops at a ceiling. Anyone can claim
to be a fetcher, so that function trusts nothing it is told and nothing is worked out from the
count, as with the visit count ([0017](0017-a-visit-is-counted-for-whoever-holds-the-site-key.md)).
Nothing it does can reach another table or read a sign-in.

**What a page is stays plain.** It is HTML an assistant reads without running anything: no
script but the structured details, no cookie, image, font or tracking, and a policy that forbids
them. Every word in it is written as text. The business's name links to its own site, and nothing
of Nearcited's is on it but a generator tag.

**It hands the zone's own names on.** A route runs before a custom domain on the same zone, so
`*/*` would reach `nearcited.com` first. The setup puts a route with no Worker on
`nearcited.com/*` in front of it, so the app is not routed through the Pages Worker at all, and
the Pages Worker hands any request for a name of the zone's own straight on, in case it is ever
reached for one.

**Registering a subdomain is the main Worker's.** Creating and removing custom hostnames needs a
Cloudflare token, a secret, and is done by the worker from the queue, as every other change
outside the product is. The Pages Worker only serves what is registered.

## Considered options

- **Serve hosted pages from the main Worker.** Rejected. Every business's subdomain would arrive at
  the app: one mistake in telling which site a request is for would show the sign-in screen, the
  API or one business's data under another's domain. It would also have the main Worker run for
  every asset of the app, which today is served without it, so that it could look at the host
  first.
- **Give the Pages Worker the secret key, to read the pages directly.** Rejected. It answers
  anyone on the internet under names the product does not own, and needs nothing a visitor could
  not be shown. A function that answers only that is the narrowest door.
- **A separate zone for hosted pages.** Rejected for now. It would keep the app's zone apart from
  every business's traffic, at the cost of a second domain to buy and keep. The route with no
  Worker on `nearcited.com/*` and the hand-on give the same separation on one zone.

## Consequences

- The project rules say two Workers, not one, and the deploy workflow deploys both.
- A page is as fresh as five minutes: what is served may be kept that long by a browser or a
  cache, so a page taken back can still be read for that long.
- A failure to read the database answers 503 with a time to come back, so a crawler tries again
  instead of taking the page for gone.
- The Pages Worker runs for every request to every answer subdomain, which Cloudflare bills as
  Worker requests on the account's plan.
