---
status: accepted
---

# Analytics counts are kept apart from the line's

Many businesses already have Google Analytics on their site. For them, visits from assistants can be
read with one sign-in and nothing pasted anywhere (#144). ADR 0011 settled that the sign-in asks to
read and nothing more, and that a visit is counted only where it says where it came from. Two things
were left: what a location shows when it has both this and the line, and where Google sends someone
once they have agreed.

**The two sources are kept in separate tables and shown apart, and never added.** Analytics counts go
in a table of their own, written only by a worker function; `record_visit()` stays the only thing
that writes `visits`, and ADR 0017 stands as it was. They count different things: a session against a
report from a browser. Analytics misses a visitor who declines its cookies, and the line misses one
whose browser does not say where they came from, and most of the people each sees the other sees
too, so a sum would count them twice and a choice between them would hide what the other found. The
location's visits card has a section for each, each with its own total and its own statement of what
it leaves out, and one sentence on why they differ where both have counts. A location with only the
line looks as it did.

**Google sends its owner back to a page of the web app, not to the API.** The API knows who is
calling from the sign-in the app sends, and a redirect from Google carries none. A return to the API
would have to take the caller from the address alone, or set a cookie the product otherwise does
without. The page posts the code and the `state` to a signed-in route as the caller, so the
connection is made through `create_connection()` under row-level security like any other, with no
secret key on the path (ADR 0013). The `state` is sealed with the key sign-ins are sealed with, to
this caller and this organization, and lasts minutes, so it needs no row of its own. Nothing a return
carries is believed until it has opened.

**A property is matched by the worker, never by hand.** The sync lists the properties a sign-in
reaches and the web streams of each, and matches a property to the organization's location whose
website a stream measures: one property, one location, the one made first where several share a
website, as for a Cloudflare zone (ADR 0028). A location whose website another location's property
already measures names that location, and no session is shown twice.

**Only sessions from assistants are asked for.** The report is filtered to the sources in
`ASSISTANT_REFERRERS`, the one list the line uses too, and `assistantOfSource` still decides what each
row is. Nothing is kept of a session but the count for a day, a location, an assistant and a page,
and, as with the line, no score, alert, task, report or bill is worked out from it.

## Considered options

- **Add the two counts, or show the larger.** Rejected: most of the same people are in both, so a sum
  is wrong by an amount nobody can state, and the larger hides that the two disagree.
- **Prefer Analytics where it is connected and hide the line.** Rejected: the line is what counts a
  visitor who declined Analytics' cookies, and an owner who pasted it would see its numbers vanish.
- **Keep them in `visits` with a column for the source.** Rejected: `record_visit()` is called by
  anyone with the key and trusts nothing it is told, and a table it writes is one whose every row is
  in doubt. A table only the worker writes can say more.
- **Return to the API, with the organization on the `state`.** Rejected: see above. A route that makes
  a connection on the strength of the address alone is the one this product has nowhere else.
- **A row for each `state`.** Rejected: a signed value that opens only for this caller and organization
  says as much, and needs nothing to clean up.

## Consequences

- The sign-in path is Google's and not Analytics': the Google profile connection (#142) can use it as
  it stands, with its own scope.
- A property that measures more than one website counts them together. The report is not split by
  host: Google's documentation does not say that `hostName` can be asked for beside `sessions`, and a
  report it refused would count nothing at all. The page says so.
- A day here is a day in the property's own time zone, not UTC as the line's is, since that is the
  only day a report gives. The page says so.
- Google's review of the sign-in screen is still owed (#145). Until it passes, people see a warning
  and at most 100 can connect, and a project left in Google's "Testing" status gets sign-ins that
  expire after seven days, so the screen has to be "In production" to try this for longer.
- The tests answer from Google's documentation, and nobody has run this against a real property. A
  first real connection is owed, once the project exists (#130).
