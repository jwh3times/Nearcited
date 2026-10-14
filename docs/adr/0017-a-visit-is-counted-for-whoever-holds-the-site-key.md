---
status: accepted
---

# A visit is counted for whoever holds the site's key

Issue #139 counts the visits a business's own site gets from assistants.
[0011](0011-the-product-does-the-work-and-the-owner-approves.md) settled what is counted: the
owner pastes one line into their site, a visit counts only where it says where it came from, and
the page says which assistants cannot be told apart from a search. This record is how a visit
gets from a stranger's browser into the product.

Until now nothing wrote to the database for a caller who is not signed in. The two public reads
are an audit, by the token in its link ([0002](0002-audits-are-read-by-token.md)), and the price
list. A visit is the first write of that kind, and whoever makes it will never sign in: it is a
visitor's browser on somebody else's website.

**A visit is counted through one function, which answers anyone holding the site's key.** Every
location has a site key, made with it, and the line on its site carries the key. The line posts
to one public route, which hands the visit to `record_visit()` with the public key, never the
secret one. The function finds the location by its key and writes the count itself. No table is
opened to a caller who is not signed in, and no request path acts as the worker: the payment
webhook stays the only one ([0007](0007-the-payment-webhook-acts-as-the-worker.md)).

**The key is not a secret, so the function trusts nothing it is told.** Anyone who opens the
site's source reads the key, and a browser's request can be imitated. So:

- The day is the function's own, never the caller's.
- Which assistant it was is worked out by the route from what the visit carried, by one list in
  the shared package. The function refuses any name not on that list.
- A visit counts only for a page on the website the location has on file, which the route takes
  from where the browser says the post came from, never from the body.
- A location counts at most 1,000 visits a day, under at most 50 pages. Past the fiftieth page
  of a day the visits are counted together.
- It counts only on a plan that includes visits, for a location the plan covers.

None of that stops somebody who means to post made-up visits. It bounds what they can write,
and it keeps a copied line, an old line and a mistake from counting.

**Nothing rests on the count.** Since it can be padded, no score, alert, task or bill is worked
out from it. It is shown as what the site reported, beside a statement that it can be padded.
That also takes away the reason to pad it.

**The line decides in the visitor's browser, and says nothing about any other visit.** It holds
a copy of the list, and posts only for a visit that arrived from an assistant on it. For one
that did it sends the key, the host the visitor came from or the assistant's tag, and the path
landed on. Not the address the visitor came from, which can hold what they asked, and not what
follows a question mark. It sets no cookie and keeps nothing in the browser. The product
therefore never hears of an ordinary visit to a customer's site.

**What is kept is a count, not a visit.** One row says how many visits a location had on a day
(UTC) from an assistant on a page. There is no row for a visit, no time of day and nothing about
the visitor, so there is nothing to delete on request and nothing to leak.

**The answer is the same whatever became of the visit.** The route answers that it has nothing
to say, counted or not. Asking tells nobody whether a key is somebody's or a site is a
customer's.

## Considered options

- **Put each visit on the queue and let the worker write it.** Rejected. The queue carries
  scans, and a flood of visits, real or made up, would sit in front of them. It would also make
  a message for every visit to write one number.
- **Write with the worker's store from the route.** Rejected for the reason 0002 gives: it makes
  the route's own code the only guard, and the rule is that no request path bypasses the
  policies.
- **A policy that lets a caller who is not signed in insert a row.** Rejected. A policy cannot
  bound how many rows a day, cannot set the day, and would have to trust the assistant's name
  and the page as sent.
- **Send every visit and decide on the server.** Rejected. The product would be told of every
  visitor to every customer's site to count a few of them, and a customer's site would need to
  tell its visitors so.
- **Keep a row for each visit.** Rejected. A row needs a time to be worth keeping, and a time
  with a page is a record of a person's visit. Counts answer what an owner asks.
- **Forward the visitor through the product, so the link itself is counted.** Rejected: the
  product cannot change the links an assistant gives, and the count is of arrivals on the
  business's site, which only that site sees.
- **Stop made-up visits with a secret in the line, or by checking each visitor.** Rejected. A
  secret in a page is not one, and anything that tells a real browser from an imitated one
  means identifying the visitor.

## Consequences

- The count is a floor, and a soft one. It leaves out every visit that does not say where it
  came from: Google's AI Overviews and AI Mode, Copilot inside Bing, an app that sends neither a
  site nor a tag, and a browser that blocks the line. It can be raised by anyone who reads the
  key. The page says both.
- The list of what each assistant's visits carry is in three places: the shared package, the
  line a site loads, and the names the database takes. A test keeps the first two the same. A
  new assistant is added to all three, the database first.
- The line is served as a file beside the app, not by the Worker, so a customer's site loading
  it costs no run of the Worker. A change to it reaches a site within the hour a browser keeps
  it.
- An owner who thinks a key is being abused replaces it, and the line on their site has to be
  pasted again. The old key then counts nothing.
- A location's visits go with the location, and the counts already kept stay readable when a
  plan stops including them.
- A request to the product reaches its host as any request does, and the host logs requests.
  The privacy policy says so. Nothing from those logs is put with a count.
