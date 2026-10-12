---
status: accepted
---

# An alert is kept, not worked out again from the window

Issue #136 tells an owner when something measured gets worse. There are three kinds: a drop, a
prompt on one surface that named the business and has stopped; a business the answers name for
the first time; and a site they cite for the first time.

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

**A first sighting is said of the whole record, not of the window.** A business is named for
the first time, or a site read for the first time, when the written answers of the latest three
scans name or cite it in at least three answers across at least two of those scans, and no
written answer of any earlier scan on record did. Seven scans cannot say "first", so the worker
reads what every earlier scan's answers named and cited, and compares names and sites itself by
the rules it uses everywhere else. That read is the location's whole record. It is made only
when the latest scans hold something the rest of the window does not, which is rare: the
businesses and sites the answers name week after week are ruled out by the window in hand.

**Only written answers count toward one, and none is raised before a location's seventh scan.**
A results list names ten businesses every time and its tail changes daily. A location's first
scans name everyone for the first time, so nothing is new until there is a full window to be new
against. A competitor's own website is not said as a site: naming the competitor says it.

**A first sighting is news, not a state.** Nothing ends it, so it is cleared as old news once
seven more scans have passed, when the scan that raised it leaves the window. It is said once
for a business or a site: from then on the record holds it.

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

**The owners are told in the scan report, once.** Where an organization's plan emails a report
after each scheduled scan, the alerts not yet told lead that report and its subject line. An
alert only ever comes of a scan, and the report already goes to the same owners after every
scheduled scan, so a message of its own would always arrive beside one. An alert a manual scan
raised goes in the next report, if it is still open. A drop the owners were told of gets one line
when the business is named again. One that a member dismissed first is not sent, and nothing is
said when a dismissed one ends, or when one ends because its prompt was retired. An alert is
marked told only when the report went to someone: a report that failed, or had nobody to go to,
leaves it for the next. A test organization is sent nothing.

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

- **Calling it new when the window has not seen it.** Rejected. A business the answers name for
  a month every season would be new every season.
- **Keeping a list of everything a location's answers have named, added to at each scan.**
  Rejected. It is a second copy of the record to keep right, and filling it for the scans already
  made would mean matching names in SQL by rules that live in the shared package.
- **An email of its own for each alert.** Rejected. It would land beside the report every time,
  and a surface that stops naming the business would send one for every prompt.

## Consequences

- A drop is not raised until its prompt has seven checks on its surface, so a new location, and
  a new prompt, are quiet until their seventh scan. A first sighting waits for the same seven.
- Names are matched as they are everywhere else, loosely: a longer name that contains a known
  one is the same business. A new branch of a known business is therefore not said.
- Reading the record costs more as a location's history grows. It is one query over that
  location's results, made on the few scans that need it.
- A prompt that was named about half the time and then stops is often not raised at all: its
  four checks before the misses may not hold three that named the business. The grid still
  shows it.
- A drop already under way when alerts were first deployed is raised at the next scan if its
  window still shows it, dated from its first miss. One older than the window is never raised.
- Sample scans and real ones never share a window, so each alert keeps which kind raised it and
  a page shows only the kind it is showing.
- An organization whose plan sends no report is told of no alert by email. If it moves to a plan
  that does, the alerts still open go in its first report.
- If the report goes and keeping that it went fails, the next report says the same alerts again.
- What is built so far, and what of issue #136 is still to come, is in `docs/architecture.md`.
