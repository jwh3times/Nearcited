---
status: accepted
---

# Google results are bought from a data vendor and checked from one point

Issue #8 asked for the Google half of the product: where a business shows for a Google keyword
in the map pack, the organic results and the AI Overview. Google has no interface for any of
them, and AI Mode, its own assistant, has none either. Issue #219 settled how they are checked.

**They are bought from a SERP data vendor, DataForSEO, in live mode.** It is the vendor that
takes exact coordinates for Google's results page, its map results and AI Mode alike, and it
returns an AI Overview with the sites it cites. Live mode answers inside the call, so a check
fits the provider interface as it is: `observe()` fetches and returns an `Observation`, and
`analyzeObservation` decides what it means, as for the assistants. Its queue is cheaper but
answers minutes later, which would need a scan to finish later and a postback endpoint the
vendor does not sign. Every vendor's results are read off Google, not licensed from it.

**One keyword is three calls, on four surfaces.** Google's results page is read for the organic
results and for the AI Overview loaded in full, which is charged only when there was one. Its
map results, Local Finder, are read deeper than the three places of the pack, so a move from
ninth to fifth shows before the business reaches it. AI Mode is a surface of its own, checked
for Google keywords only. Each call's use is recorded as searches under a name for the call and
priced from the tuning's rates, as a model is.

**From one point, the location's own.** Map results change from street to street, so a check
made anywhere else says little about what a customer near the business sees. The point is its
street address, or the middle of its city when it has none or the address cannot be found, and
nowhere when neither can, in which case Google is not checked. A grid of points around the
business would multiply every check, and is left for when the cost of one is known.

**The worker finds the point and keeps it.** Before a scan's first Google check, and again only
when the address changes, the worker looks the address up with Mapbox's permanent geocoding,
whose terms allow keeping the result, and writes it on the location. No request writes it: the
database keeps what a signed-in caller writes to those columns as it was, so nothing a request
sends decides where a check is made from. The owner corrects the point by correcting the
address.

**A plan includes it as an allowance.** Google results are a kind of work a plan includes
(ADR [0012](0012-a-plans-allowances-are-one-set.md)), and a scan checks the Google surfaces only
for an organization whose allowances include it. The kind starts on no plan. The operator can
give it to one organization with the limits editor to see what checking costs, and a migration
puts it on the plans that sell it.

## Consequences

- A scan stays all or nothing: one Google call that fails fails the scan, and the queue retries
  it, the calls already answered included.
- Google is checked only where the vendor's sign-in and the geocoder's token are both set.
- Audits and setup stay on the assistants.
- What a Google check costs, and so which plans include it, is decided outside this repository.
