---
status: accepted
---

# A search that showed nothing is kept and not counted

Many local Google keywords show no AI Overview at all, and AI Mode, the map pack and the organic
results can come back empty too. Until issue #223 a scan kept such a check as an empty answer,
which the analysis read as "not named": it lowered the score, the "named in x of y" counts and the
report email, raised "Not named on AI Overview", and an overview that named the business and then
stopped appearing raised a drop. "Google showed an overview and you weren't in it" is something an
owner can act on; "Google showed nothing for this search" is not about them.

**A check where Google showed nothing is kept as nothing shown.** It is a third outcome beside
named and not named, stored on the result (`scan_results.shown`, false), with nothing else on it.
It is kept, not dropped, so the owner can see how often the overview appears at all.

**It is decided in the analysis, from what came back.** `analyzeObservation` calls a check on a
Google surface nothing shown when what the provider returned holds nothing: no answer text, no
businesses and no cited pages for an answer, no entries for a ranking. The providers only fetch, as
before. An assistant always answers, so an assistant's check is never nothing shown: an answer
that names nobody still left the business out.

**It counts nowhere.** Not in the score, where a cell is averaged over its shown checks and a cell
with none is left out; not in a rate, which is out of the shown checks; not in the report email,
which says how many searches showed nothing; not in a recommendation; and not in an alert. A drop
looks only at the checks that showed something, so a check that showed nothing raises, counts
toward and clears nothing. With nothing left to score the location has no score, and the page says
it is because Google showed nothing.

## Consequences

- One rule, `isCounted` (`packages/shared/src/scoring.ts`), says whether a check counts; whatever
  counts checks asks it, so no two parts of the product disagree.
- A window cell's `checks` are the shown ones, with `not_shown` beside them and a three-way
  history, so a reader of the counts gets the right number without knowing the rule.
- `complete_scan()` takes a result that does not say as shown, so the Worker deployed before the
  column keeps working; the migration that added it put right the results kept before, where a
  Google result held nothing at all.
- A drop needs the cell's window to be full and, among the checks that showed something, three
  misses with three named before them. A search that showed nothing in the window shortens what a
  drop can be seen over; it never stands in for a miss.
- A failed Google call still fails the scan (ADR 0023). That is a call that did not answer, not a
  search that showed nothing.
