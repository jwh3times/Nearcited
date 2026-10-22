---
status: accepted
---

# NearcitedBot obeys robots.txt, and reads only pages an answer cited

NearcitedBot read one page of a site whose owner had asked to have it checked, the business's own
home page, and read `robots.txt` only to report what it said to the assistants' crawlers. A rule
addressed to it did not stop it (#78). Issue #155 has it read pages of other people's sites as well:
the page an assistant cited for a directory task, to tell the owner whether that page shows the
business's name, phone and address. A crawler that reads other people's sites obeys their
`robots.txt`.

**It reads `robots.txt` first, and obeys it.** Before it asks a host for a page it reads that
host's `robots.txt`, once a scan, and a redirect to another host reads that host's before the
request goes. Rules are read as RFC 9309 says: the group that names `NearcitedBot`, or the `*` group
when none does; the longest matching rule wins and an Allow wins a tie; `*` and `$` are wildcards.
A `robots.txt` that is not there (a 4xx) means no rules. One that faults, answers 429, times out or
does not answer means everything is shut, and nothing is read.

**On the business's own site only rules naming NearcitedBot count.** Its owner asked to have it
checked, and a site that shuts out every crawler with `*` is exactly what the on-page check exists
to report. Shut out by name, the on-page check reads no page, reports what `robots.txt` says to the
assistants' crawlers, and says the rest was not checked.

**It reads only pages an answer cited, and few of them.** The cited-page check reads, for the
directory tasks a scan leaves open and no member dismissed, the page the answers cited most for
each site: at most three pages, one a site, in at most thirty requests in all, every `robots.txt`
and redirect counted. Every hop must stay on the task's site, its host or a subdomain of it; a
redirect anywhere else is not followed. A page is asked for once a scan, with no retry, and a page
that cannot be read is reported as not read with the reason, never a failed scan. It is never read
on sample data, for a test organization, for an audit, or because someone opened a page.

**It keeps what it found, never the page.** Whether the page names the business, and for the phone
and the address whether it matches; the page's number only where it differs or there is none on
file. Nothing is cached between scans. What it found is composed into sentences by rule, and no
model reads the page or writes a word of it.

**Only the phone is ever called different.** A phone number is compared whole, after it is read
from the page's structured details or found under the business's name, so "it shows another
number" can be said. An address is matched loosely, by street number and postal code, and is only
ever said to be shown or not.

## Considered options

- **Obey only rules naming NearcitedBot everywhere.** Rejected: on someone else's site, a `*` rule
  is addressed to every crawler, NearcitedBot included.
- **Obey `*` on the business's own site too.** Rejected: the owner asked for the check, and it
  would go silent on exactly the sites it most needs to report.
- **Buy scraped listings instead of reading pages.** Rejected in ADR 0011: the product reads only
  what an assistant read, as a crawler would.
- **Retry a page that did not answer.** Rejected: one miss is reported as one, and the next scan
  reads again. Retrying would spend requests other pages need.

## Consequences

- The on-page check reads `robots.txt` before the home page, and a site whose `robots.txt` faults
  gets no checklist until it answers.
- A directory task carries what the latest scan found on its cited page (`cited_page`), from
  `scans.cited_pages`.
- `/bot` says which rules NearcitedBot obeys and which pages it reads.
- The scan's invocation makes up to thirty more requests to sites, beside the on-page check's
  fifteen and the providers' calls.
