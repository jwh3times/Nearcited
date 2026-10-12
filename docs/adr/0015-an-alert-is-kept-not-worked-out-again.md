---
status: accepted
---

# An alert is kept, not worked out again from the window

Issue #136 tells an owner when something measured gets worse. The first kind is a drop: a prompt
on one surface that named the business and has stopped.

**An alert is a row, raised and cleared by the worker when a scan finishes.** A recommendation is
worked out again from the scan window at every scan, and one whose rule no longer fires is
resolved. An alert cannot be: the window is seven scans, so seven scans after the business was
last named the window holds nothing that says it ever was. A rule that looked only there would
stop firing, and the alert would clear itself while the business was still not named. So what
raises an alert and what clears it are different conditions, and the row carries what was
counted when it was raised.

**A drop takes three misses, after a prompt that was named.** It is raised when the latest three
checks of a prompt on a surface did not name the business and at least three of the four before
them did. One answer is a sample. A prompt that names the business nine times in ten misses three
times running by chance about once in a thousand scans, and twice running about once in a
hundred: for a location with thirty such cells scanned daily that is a false alert about once a
month, against one every few days. The cost is time. The rule counts scans, so a drop is told
three days after it begins on a daily plan and six weeks after on one scanned every fourteen
days. Two misses was the alternative, and was turned down for crying wolf.

**A drop clears when the business is named again, and never by age.** One check that names it,
made after the alert was raised, is enough. It also clears when its prompt is retired or its
surface is no longer checked. An alert that expired would say the problem had ended when it had
not.

**A dismissed alert is still current.** A member may dismiss an alert, which takes it off the
page. The rule goes on firing at the next scan, so the dismissed row stays in the way of a second
alert for the same thing until the worker clears it. The same thing is raised again only once it
has ended and begun afresh.

**Only the worker raises or clears one.** A request dismisses, through a function that answers
only a member of the location's organization, and changes nothing else. The thresholds are
constants beside the recommendation rules in the shared package, public as those are: they are
not prompt wording or score weights.

**An alert says what was seen, not what to do.** It is composed by rule from the facts kept on
the row, in the shared package, so the page and any message say the same sentence. No model
writes one. What to do stays with the action plan and the tasks.

## Considered options

- **Working alerts out from the window at each scan, as recommendations are.** Rejected. It
  needs no table, and it clears a drop that never ended.
- **Two misses in a row.** Rejected. It tells an owner a day or two sooner and is wrong about
  ten times as often.
- **Looking further back than the window for the checks that named the business.** Rejected. The
  page shows the window. An alert resting on checks the page no longer shows could not be checked
  by whoever reads it.
- **Raising on a fall in the rate, such as from five of seven to two of seven.** Rejected. A
  prompt named half the time reads five of seven or better in more than one window in five, and
  two of seven or worse as often, with nothing having changed.

## Consequences

- A drop is not raised until its prompt has seven checks on its surface, so a new location, and
  a new prompt, are quiet for their first seven scans.
- A prompt that was named about half the time and then stops is often not raised at all: its
  four checks before the misses may not hold three that named the business. The grid still
  shows it.
- A drop already under way when alerts were first deployed is raised at the next scan if its
  window still shows it, dated from its first miss. One older than the window is never raised.
- Sample scans and real ones never share a window, so each alert keeps which kind raised it and
  a page shows only the kind it is showing.
- What is built so far, and what of issue #136 is still to come, is in `docs/architecture.md`.
