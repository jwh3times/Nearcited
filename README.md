# Nearcited

[![CI](https://github.com/jwh3times/Nearcited/actions/workflows/ci.yml/badge.svg)](https://github.com/jwh3times/Nearcited/actions/workflows/ci.yml)

Tracks whether a local business gets named when people ask an AI assistant or search Google for
what it sells, and who gets named instead.

**Status: early.** Two real providers exist: ChatGPT, through OpenAI's API with web search, and
Claude, through Anthropic's. The other five surfaces are not built, and local development runs
on generated sample data. See [What is not built](#what-is-not-built).

## Contents

- [How it works](#how-it-works)
- [Stack](#stack)
- [Layout](#layout)
- [Run it locally](#run-it-locally)
- [Configuration](#configuration)
- [Commands](#commands)
- [API](#api)
- [Data model](#data-model)
- [Tests](#tests)
- [Deploy](#deploy)
- [Repository automation](#repository-automation)
- [Private companion](#private-companion)
- [Working with coding agents](#working-with-coding-agents)
- [What is not built](#what-is-not-built)
- [Contributing and security](#contributing-and-security)
- [License](#license)

## How it works

A user signs in, creates an organization, and adds a **location**: a business at an address. For
each location they list the **queries** to track. A query is either a prompt someone would give
an AI assistant ("best emergency plumber in Asheville") or a keyword they would type into Google.

A **scan** runs every active query on every **surface** that kind of query applies to. The
surfaces are ChatGPT, Gemini, Perplexity, Claude, Google AI Overview, the Google local pack and
Google organic results. For each one, a provider fetches what the surface returned, and shared
code decides whether the business was named, at what position, and who was named instead. The
scan then stores a 0 to 100 visibility score and a list of recommendations.

An assistant can answer the same prompt differently each time, so one answer is a sample and not
a measurement. Results are therefore shown as "named in x of y", counted over a location's last
seven successful scans, and the score and recommendations are worked out over the same window.

An assistant with web search lists the pages it read before answering. Nearcited counts those
sites over the same window: how many answers cited each one, and how many of those answers named
the business. A site that is read often in answers that never name the business becomes a
recommendation, and so does a business website that no answer cites. Each recommendation clears
by itself when a later scan shows the thing it pointed at has changed. The location page and the
shareable audit both show the table.

Each scan also reads the business's own home page the way an assistant's crawler would, without
running scripts: does it load, does `robots.txt` let the assistants' search crawlers in, is it
free of `noindex`, does it have text, does that text state the business name and city, and does
it carry structured business details that name the business. Each failed check is a recommendation
that clears when a later scan finds it fixed. Where a page has none, the location page offers a
block of them to copy into the page, built from the details on file and nothing else. An owner
marks it done once it is on the page, the next scan says whether it found it there, and the
answers that cited the business's website before the mark are set beside those since. Neither
count says the block caused a change.
The shareable audit shows the whole checklist. The fetch identifies
itself as `NearcitedBot`, with a link to the public `/bot` page, and is skipped while the deployment serves sample data.

The operator has one more screen, `/operator`: what needs attention (a failed scan, a scan stuck or
overdue, a website that cannot be read, a failed audit, an organization whose owners were not told
of an action, a location with no active prompts),
every organization with its plan and how many of its locations are at their prompt limit, every account with how far it got (signed up, made an organization, added a location, had a scan succeed, scanned in the last week), every shareable audit, and what the deployment runs. From there the operator
can read through a customer's pages, with everything that changes something hidden, and change the
organization's limits (locations, prompts per location, manual scans a month, days between scans) and
its allowances, one field for each kind of work a plan can include, on its plan page. A Plans
section lists each plan with its price, how many organizations and subscribers
are on it and their monthly total, and edits its name, limits, allowances, emailed report and whether it is on
sale; lowering a limit or an allowance first shows how many organizations it reaches and asks to save again. A raise
reaches every organization on the plan at once. A lower limit on a plan nobody pays for is made at
once too (on the free plan each organization is emailed that day). On a plan with subscribers it
asks for a day at least thirty days out and is announced instead: the owners are emailed, reminded a
week before, and the reduction is made for the whole plan on the day. The editor shows who has and
has not been told, by organization name, and "Call off the reduction" until the day; whatever else
the save changed is made at once. A second form sets its prices, typed in dollars,
for new subscribers; current subscribers keep the price they pay until the operator announces a
day for them ("Current subscribers": pick a day, announce, asked twice). Each subscriber's owners
are emailed, reminded a week before, and each subscription is moved to the new price at its next
renewal; the form then shows how many were told and moved, and "Call it off" until the day. The
monthly total is worked out from each plan's present price, so it overstates or understates for
subscribers still on an older one.

The location page and the audit turn all of that into an action plan, "What to do next": fix
what keeps the website from being read, get listed on the sites the assistants read without
naming the business, keep the listings that did lead to its name accurate, and see who is
recommended instead. Every step is composed by rule from the counts and checks above and says
which; none is written by a model. On the Overview tab the sites to get listed on also appear as
tasks the owner can mark done, with the answers that cited the site before beside those since. A
task that an action did the work of is marked done by that action, and a member cannot clear it.
How often a location is scanned, and on which assistants, are settings on its organization.

A task about asking customers for reviews also asks for the business's **listing** on that site:
the address of its own page there, which the owner pastes once. The page an assistant read is often
a list or somebody else's page, so the product does not guess at it, and it does not open what is
pasted: it checks only that it is a page on that site. Once a listing is kept the task gives the
link to send customers, to copy, with the listing beside it to change or remove. On a site whose
review form has an address that the site's own pages showed, which today is bbb.org and
trustpilot.com, the link goes straight to the form. On the others, Google aside, it is the listing,
and the customer finds the form from there. The listing is kept for the location, so a task that
comes back already has it. A site that does not let a business ask for reviews is never asked about.

Google is asked for something else: the **review link** Google gives a business, which its owner
copies from the business's Google profile. The task assumes the owner has not heard of it, and says
where it is in Google's own steps (on the Business Profile, Read Reviews, then Get more reviews, then
Copy), with a link to the page of Google's help that has them. What is pasted is kept as a listing is
and is what a customer is sent; nothing is built from the place ID a location holds. It must be an
address on `g.page` or on `google.com`, not a front page, not a Google search address and not a page
only the business's owner can open, and the refusal says where the link is.

Once the task holds the link to send, it also shows a **request to send**: a short message to copy
that thanks a customer for choosing the business, asks them to review it on the site by its name
(Google, BBB, Trustpilot and so on), and ends on the link on a line of its own. The owner sends it
themselves, by text or by email, from their own address or phone. It is composed by rule from the
business's name, the site's name and that link, and no model writes it. It asks every customer alike
for what they honestly thought, good or bad, and the task tells the owner to send it to every
customer and not only the happy ones, and to offer nothing in return. Nothing is sent from the
product, nothing is kept, and copying it does not mark the task done. A task with no link kept, or
for a site that forbids asking, shows none.

Under the request the task shows the same link as a **code to print**, a QR code a customer scans
with their phone's camera to open it. It is drawn in the browser from the link alone, which is the
site's own address, so nothing of the product's is in it and nothing is sent anywhere to make it.
"Download the code" saves it as a picture. "Print a card" opens a page with a card four inches by six
to print: the business's name, a line that asks "How did we do?" and for a review on the site, by its
name, the code, and "Point your phone's camera at the code." The owner is told to cut it out, hand
one to every customer or leave it where they pay, and to offer nothing in return for a review. The
code is black on white in either theme. Nothing is kept or counted, and neither printing nor saving
marks the task done. Wherever there is a request there is a code, so none is shown for a site with no
link kept or one that forbids asking, and a card page for such a site says there is no card to
print. The operator, reading a customer's account, sees the code and the card.

Two kinds of task can also have a **draft**, which the owner copies and sends or pastes themselves.
A task about a page somebody wrote ("Ask to be included on ...") has the note to its author. A task
about a directory, or about a review site that does not let a business ask for reviews ("Check your
listing on ...", "Claim and complete your listing on ..."), has the description its listing asks
for. A task about asking customers for reviews has none, since the product writes nothing to a
business's customers, and neither does one about a site of a kind nobody knows. A member asks for a
draft with "Write a draft", and the worker, never the page, writes it. It is written from the
location's details, the page the task is about and a few sentences in the owner's own words on what
the business does ("What we do"), which the task asks for first if the location has none; nothing
from the answers is given to it. A draft is checked by rule before it is kept: every number, web
address and email address in it must be in what it was written from, or it is written once more, and
if that fails too nothing is kept. It is labelled with who wrote it. Writing one again replaces it
and counts as another. A plan includes a number of drafts a month for each location, taken from when
the worker starts one and given back when nothing was written. A draft of any kind, a page's included, counts against
that one number. The paid plans include drafts and the free plan does not; the numbers they started
with are in `supabase/migrations/20261012180000_drafts_on_plans.sql`, and the operator can change
them. On a plan with none a task offers no draft; where one could be written, a line above the
tasks says so and, for the owner, links to the plans.

A prompt that at least four assistant answers were given to, none of which named the business, is
also a **page task** where the location has a website: a page on the business's own site that
answers the prompt in plain words, which an assistant could read for it. The Website tab lists
them under "Pages that answer your prompts" (the Overview leaves them out), and the task clears when
an answer to the prompt names the business. Its draft is the copy for the page, written the same way
as the others: a title, headings and paragraphs, followed by a closing line the product composes from
the location's name, address and phone number. On a location with a connected WordPress site, or a live answer subdomain, the
product proposes publishing the page, and publishes it on approval, keeping its link; otherwise the
owner copies the page, publishes it themselves, marks the task done and says where it is (an
address on the location's own site, which is kept and never opened), so the scans can count the answers that cited it beside the answers that named the
business. Nothing says the page caused a change.

On real data Claude writes the draft, through Anthropic's API with no tools: it is told what to
make by instructions that come from the private tuning, then given the details it is written from,
one to a line, with "not on file" for one the location does not hold. A build without instructions
for a kind of draft writes none on real data, as a build without the private tuning runs no live
scan, and a task of that kind is offered no draft: a task shows one only where one can be written
(on sample data any kind, and on real data a kind the build has instructions for, with
`ANTHROPIC_API_KEY` set), so nobody is shown a button that could only be refused. What each write
used is recorded for the organization, kept or not, and is in the operator's spend. A deployment in
mock mode, and a test organization, get sample text instead, generated from the same details,
labelled as that and written by no model.

The Overview tab also lists **alerts**: statements that something measured has changed in a way
an owner would want to know. There are four kinds. A drop is a prompt that named the business on
an assistant, or a keyword on a Google surface, and has stopped: none of its latest three checks
named it, and at least three of the four before them did. A first sighting is a business the
written answers (the assistants and Google's AI Overview, not a results list) begin to name, or a
site they begin to cite: at least three answers across at least two of the latest three scans, and
no written answer of any earlier scan on record. Both need seven scans on record, so a new
location is quiet until it has them. A phone number is one the written answers give for the
business that is not the one on file: the same number, in at least two of the last seven scans.
A number counts as the business's when the name written nearest before it in the answer is the
business's, and a location with no phone on file is told nothing. Like the action plan, an alert
is composed by rule, says what was counted and never what to do, and no model writes one. A drop
stays until a later scan names the business again, or its prompt is retired or its surface is no
longer checked, and is never cleared by age. A first sighting is news, not a state: it is cleared
once seven more scans have passed, and is said once for a business or a site. A phone number is
cleared when no answer in the last seven scans gives it any more, or when it becomes the number on
file. A member can dismiss an alert, which takes it off the page; a drop is raised again only once
it has ended and begun afresh. A member who dismisses a phone number ("This number is ours") says
it is the business's own, and it is never raised again. The locations table shows how many each
location has. The organization's owners are told of a new alert once, at the head of the report a
scheduled scan emails and in its subject line, and told in one line if a drop they were told of
ends because the business is named again. An alert a member dismissed first is not sent, nothing
is sent when a first sighting or a phone number clears, and nothing is sent for a test
organization or a plan that sends no report.

The location page charts the score over time, and each cell of the results grid carries a strip
of dots, one per recent scan, showing how that prompt has moved on that assistant.

The app has a sidebar listing every location and a light or dark theme, kept in the browser. The
locations page is a table of score, change, rate per assistant, top competitor and next step,
built from each location's own endpoints. The location page has tabs (Overview, Actions once the
location has one, Prompts, Sources, Website, Answers, Settings); ticking a step of the action plan is remembered in the browser only.
An Account settings page, linked from the sidebar, renames the organization and shows what its
plan allows, which is not edited there, and the scans run by hand this month. On a plan that
checks one assistant the owner chooses which. It links to the plans, and the
owner of an organization that has been through checkout sees what is paid for (plan, locations,
when it renews), a change waiting for the end of the period with "Keep my current plan", a link to
"Change plan or locations", a "Manage billing" button (Stripe's pages, for payment method,
invoices and cancelling only), a warning while a payment is being retried or after a subscription
ended, and a thank-you on return from checkout that waits for the plan to move, and, for a subscriber not yet
moved, the new amount and from when after an announced price change. A new user is walked through four steps (organization, location, prompts, first scan), and nothing is created until the
last. The prompts step says how many the free plan tracks and takes them from the suggestions or in the owner's own words. The privacy policy (`/privacy`), the terms of service (`/terms`), a page describing the
crawler (`/bot`) and the plans (`/pricing`) are readable without signing in, and so are the
licence file for the packages the web app includes ([License](#license)) and `/line.js`, the
script a business pastes into its own site to count visits from assistants. A visitor who
chooses a plan signs in and is brought back to `/pricing?plan=<key>`; an owner with no
subscription goes on to Stripe's checkout from there, a subscriber gets a location stepper
and a "Switch" button on every paid plan ("Update locations" on their own) and a confirm step that
says what is charged today or when the change takes effect, and the free plan offers "Cancel
subscription" (Stripe's pages). A member is told the owner decides. An upgrade is made at Stripe
at once and the difference charged; a downgrade waits for the end of the paid period.

A **connection** is an organization's standing sign-in to an outside account. The Connections page,
linked from the sidebar once an account has been connected or one could be, lists them for anyone
in the organization; its owner or an admin connects an account and removes one, after being asked
twice. The sign-in is sealed by the Worker and nobody can read it back, the operator included.
The worker then reads what the account reaches (a profile, a site, a property), and again about
once a day. The Connections page says when, and the owner or an admin chooses which of those is each
location's; a location's Settings say which accounts it is matched to. Removing is finished a moment
later by the worker, which takes back the access, deletes the sign-in and the matches, and keeps a
record of who connected the account and who removed it. An account that refuses its sign-in is
marked not working at once, and one that cannot be read three days in a row is, and is still tried
daily; the owners and admins are emailed when one breaks and once more a week later, and the
Connections page and the sidebar say which are not working. When a plan stops including a kind of
account, the accounts of that kind are paused, and come back with the plan; after thirty days
paused one is removed, except an answer subdomain, which is removed after 120 (below). Three kinds exist. A sample account reaches three sample listings, needs no
allowance and is offered where the data is generated. A WordPress site is connected from its
location's Website tab, on a plan that includes it: the card asks the location's website whether it
is a WordPress that can hand out an application password, sends the owner to WordPress's own
"Authorize Application" screen, and on their approval keeps the password it is given, sealed, as
the sign-in. The worker's first sync reads the one site and matches it to that location. Removing
the connection deletes the password at the site. A third kind, an answer subdomain, has no sign-in
and needs the `hosted_pages` allowance (Pro and Enterprise). From the same tab, on a location whose
website is on file and which has no WordPress site connected, the owner or an admin picks a name,
such as `answers`, which goes in front of the website's domain, and is shown one DNS record to add
there: a CNAME to a target of that connection's own. The worker looks the name up, registers it at
Cloudflare to be served only once the record points at that target, and emails the owners once
when it is served with its certificate. It also reads the business's home page for a link to it. A
name not live within thirty days, because its record never pointed at the target or its
certificate was never issued, is let go, with an email; one whose location is deleted is removed with it. The Pages Worker (see [Deploy](#deploy)) serves a live name, and a page task's copy is published there on approval, all below. When the plan stops including hosted pages, the subdomain is paused: nothing new is published, its pages stay up for thirty days, then every address sends visitors on to the business's own website with a permanent redirect for ninety more, and then the name is removed. The owners are emailed once when the pause begins, with both days, and the card and the Connections page say them too; a page can still be taken back while the subdomain is paused. Nothing else is read from an account, and the
only things done through one are the sample action, on a WordPress site adding the business
details to the home page and publishing a page's copy as a new page, and on an answer subdomain publishing a page's copy there (see [What is not built](#what-is-not-built)).

An **action** is one thing the product does outside itself for a location, and nothing is done until
a member of the organization says yes. After the worker reads a connected account, it proposes what
it could do for each location matched to it, composed by rule, saying what is there now and what it
would put there. A location that has an action gets an Actions tab, and the sidebar says how many are
waiting at each location. A member approves a proposal, with its text changed or not, or declines it
with a reason. The worker, never the page, then carries it out: it reads what is there first, and
writes nothing if it is already so or has changed since the member was shown it. A try that fails is
made again in ten minutes, three times in all; then the action is marked failed and a member can ask
again. What an action replaced is kept only as long as it may be, and then dropped, and the record
says so; a proposal still waiting on it lapses. An action of a kind that a plan counts takes one
from the month's allowance when it is carried out and gives it back if the thing was not done, and
a yes is refused while the month has none. A proposal nobody answers lapses after fourteen days. Once a day the organization's owners
are emailed what was carried out, with who approved each, and what is newly waiting for a yes; if
one goes 36 hours untold, nothing more is carried out for the organization until they are, and the
operator is shown it. Where outgoing email is not set up, a real action cannot be approved. There
are four kinds. A sample one sets the opening line of a made-up listing. A WordPress one adds the
business's details, as a marked block of structured data, to the home page of a connected WordPress
site when that page is a page and the account may add scripts, or updates the block when it
differs. It changes only that block, is approved as it is proposed, and is carried out only if the
block on the page is still what the member was shown. A member can take a done action back from
the Actions tab, which removes the block or puts back what it replaced, unless a later action has
changed it since. The other two publish a page task's copy, as a new page on a connected WordPress site or on the location's live answer subdomain, which the product serves itself: the copy is proposed once it is written, a member may change it before approving, and the page goes up only if nothing else is at its address. Taking it back removes it from WordPress, or makes its address on the subdomain answer that it is gone. When the Pages Worker answers a live page to a fetcher it knows, it counts the fetch. The known ones are the assistants' (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, Claude-User, PerplexityBot and Perplexity-User) and two search engines' (Googlebot and Bingbot), each recognised by a word in its user agent. The page task shows, for the last 30 days, which of them fetched the page and how often, the assistants' and the search engines' apart. Anyone can send a user agent, so the count can be padded: it shows the page is being read, not who read it, and nothing is worked out from it. Publishing or taking back a page on a subdomain also tells IndexNow, and through it Bing, unless the data is generated.

A business's own site can count the visits that arrive from an AI assistant. The owner pastes one
line into the site. It reports a visit only when the visitor came from ChatGPT, Gemini,
Perplexity, Copilot or Claude, and sends nothing at all for any other visit; it sets no cookie and
keeps nothing in the browser. What the product keeps is how many such visits a location's site had
on a day, from which assistant, on which page, and nothing about the visitor. A visit counts only
for a page on the website the location has on file, on a plan that includes visits: the paid plans
do and the free plan does not. Google's AI Overviews and AI Mode, and Copilot inside Bing, arrive as
a search does and are not counted, nor is a visit from an assistant's app that says nothing of where
its visitor came from, or from a browser that blocks the line, so the count is at least this many.
Anyone who reads the site's source can read the key the line carries, so the count can be padded,
and no score, alert, task or bill is worked out from it. Where the plan counts visits, a card on a
location's Website tab shows what the site reported in the last 30 days: a sentence with the total,
then a table by assistant, one by day (newest first, with which assistants each day's visits came
from) and one by page landed on (the ten with the most, and the visits to pages past the fiftieth
of their day counted together). Under them it always says what the count leaves out and that it
can be padded. A day is a day in UTC. Nothing in it is generated: on sample data and for a test
organization it shows only what a line really reported. The card then gives the owner the line to
copy, says where it goes in WordPress, Wix, Squarespace and Shopify, and opens their site so that
the page can say the day the line answered from it. An owner or admin can replace the key, after a
confirm: the line already on the site then counts nothing until the new one is pasted, and what was
counted stays. The operator reading an account sees the counts, the line and the check and cannot
replace the key. On a plan that does not count visits the card says so and, for the owner, links to
the plans; it shows no line, counts nothing more, and still shows what was counted in the last 30
days while a plan counted it.

Scans start from the "Run scan" button or from a daily schedule, and run on a queue. A scheduled
scan emails its result to the organization's owners. When a subscription starts, the owners are thanked by email once. The same queue carries the steps of an
announced price change or reduction in a plan's limits, and the daily run queues the reminders, the
moves and the reductions on their day. Account settings shows anyone in the organization a
reduction that is coming and when.

### Shareable audits

An **audit** is a one-off report for a business that has not signed up: up to five prompts, each
asked several times (five by default) on every assistant that is set up. The page shows a score,
how often the business was named, who was named instead, and the sources the assistants cited. It
is read at `/audit/<token>`, with no sign-in; holding the link is the permission. A link stops
working 30 days after it is made, or when it is revoked.

Only the owner of the deployment can make one, from the command line (see
[Commands](#commands)). There is deliberately no endpoint, public or signed-in, that creates an
audit. It costs real money, prompts x samples x assistants answers, and refuses to run on sample
data or on the default tuning.

[docs/architecture.md](docs/architecture.md) covers the scan flow, how an alert is raised and
cleared, how an audit runs, how a connection's sign-in is kept, how an action is proposed and
carried out, how a draft is asked for and written, how a visit from an assistant is counted, the
tenancy model, the limits a Worker imposes, and the known gaps.

## Stack

| Layer | Choice |
| --- | --- |
| Web | React 19, Vite, TypeScript, React Router, TanStack Query, qrcode.react (draws the code to print) |
| API and jobs | One Cloudflare Worker: Hono for HTTP, a Cron Trigger to schedule scans, a Queue to run them |
| Hosted pages | A second Cloudflare Worker, the Pages Worker, that serves hosted pages on answer subdomains and nothing else; plain HTML, no secret |
| Assistants | OpenAI's Responses API and Anthropic's Messages API (through its SDK), both with web search for a scan; Claude also writes drafts, with no tools |
| Data and auth | Supabase (Postgres with row-level security, email sign-in) |
| Email | Resend |
| Payments | Stripe (Checkout, the billing portal and webhooks), taking live payments |
| Tooling | pnpm workspaces, Biome, Vitest |

## Layout

```
apps/
  api/          The Worker. src/index.ts exports fetch, scheduled and queue.
  web/          The React app. Its build output is served by the Worker as static assets.
                public/line.js is the line a business pastes into its own site, served beside the
                app (public/_headers sets its cache and cross-origin headers).
  pages/        The Pages Worker (`nearcited-pages`). Serves hosted pages on answer subdomains and
                nothing else, and holds no secret ([ADR 0019](docs/adr/0019-hosted-pages-are-served-by-a-worker-of-their-own.md)).
  e2e/          Playwright tests that drive the app and Worker in a browser, in mock mode.
packages/
  shared/       Zod schemas for every wire type, plus the logic that decides whether a business
                was named and which phone numbers an answer gave for it, the visibility score,
                the rule-based recommendations, the audit, cited-source and on-page check logic,
                the action plan, the alert rules, the structured business details block, the
                draft rules (which tasks have a draft, what one is written from, and the check on
                what it states), the listing rules (which sites a task asks for a listing on,
                and the check on an address pasted for one), the request an owner sends a
                customer to ask for a review and the words on the card they print with its
                code, which assistant a visit to a business's site came from, the line an owner pastes for a
                location's key, and the checks on
                what a form accepts (phone, website, postal code, country).
  db/           Tests that run the migrations in in-process Postgres and attack the policies.
supabase/
  migrations/   Schema, row-level security, and the SQL functions the Worker calls.
scripts/        integration-db.sh prepares a plain Postgres for the store integration test.
                create-audit.mjs creates and revokes shareable audits.
                bootstrap-private.mjs and sync-main.mjs manage the private companion checkout.
                prepare-tuning.mjs writes the tuning file the Worker bundles.
                hosted-pages-setup.sh walks the owner through the Cloudflare setup for hosted pages, once.
                local-env.mjs writes the two local env files from `supabase status`, and makes
                the key connections are sealed with.
private/        The private companion, when checked out. Ignored here; its own repository.
docs/           architecture.md: how a scan flows, the tenancy model, and known gaps.
                adr/: decisions that are hard to reverse, and why they were made.
                agents/: where the agent skills find the issue tracker, labels and domain docs.
.agents/skills/ Agent skills, as installed. Codex reads these.
.claude/skills/ The same skills, generated for Claude Code. Do not edit.
.claude/agents/ Specialist agents. .codex/agents/ is the generated copy for Codex.
.github/        CI and deploy workflows, Dependabot config, pull request template.
AGENTS.md       The rules a change has to follow. CLAUDE.md imports it.
```

## Run it locally

Needs Node 26, pnpm 10, and Docker (for the local Supabase stack).

```sh
pnpm install

# 1. Start Supabase. This applies supabase/migrations and prints the URL and keys.
pnpm dlx supabase start

# 2. Write both apps' env files from the example files and the keys `supabase status` reports,
#    and make this machine's key for sealing connections.
pnpm local:env

# 3. Build the web app once. The Worker's config points at apps/web/dist.
pnpm build

# 4. Run the Worker (port 8787) and Vite (port 5173) together.
pnpm dev
```

Open http://localhost:5173 and sign in with any email address. Locally the sign-in link is not
sent anywhere; read it in the mail catcher at http://127.0.0.1:54324.

With `PROVIDER_MODE=mock` (or in a test organization), "Run scan" returns generated results within a few seconds and the
app shows a banner saying so. To fire the daily schedule by hand:

```sh
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

## Configuration

The Worker reads its settings from `vars` in `apps/api/wrangler.jsonc`. Locally,
`apps/api/.dev.vars` overrides them; in production, secrets are set with `wrangler secret put`.

| Name | Secret | What it is |
| --- | --- | --- |
| `SUPABASE_URL` | no | The Supabase project URL. |
| `SUPABASE_PUBLISHABLE_KEY` | no | Used with the caller's own token, so row-level security applies. |
| `SUPABASE_SECRET_KEY` | yes | Bypasses row-level security. Only the scheduler, the scan worker and the Stripe webhook use it. |
| `PROVIDER_MODE` | no | Exactly `mock` serves generated data. Any other value is live. |
| `APP_URL` | no | Where the web app is served. The line a business pastes into its site loads its script from here. |
| `COMMIT` | no | Optional. The commit a deployment was built from, shown in the operator's view. The deploy workflow sets it. |
| `EMAIL_FROM` | no | The sender of scan reports. |
| `EMAIL_REPLY_TO` | no | Optional. Where a reply to a scan report goes. Without it, replies go to `EMAIL_FROM`. |
| `OPENAI_API_KEY` | yes | Optional. In live mode, scans check ChatGPT when it is set and skip that surface when it is not. |
| `ANTHROPIC_API_KEY` | yes | Optional. The same, for Claude. It also writes drafts on real data, with instructions for the kind of draft from the private tuning; without the key, or without the instructions, none is written and no task is offered one. |
| `RESEND_API_KEY` | yes | Optional. Without it, scheduled scans finish without sending a report, nobody is emailed when a connection breaks or told what was done for them, a price change cannot be announced, and no action can be approved (unless the deployment serves sample data, or the organization is a test one). |
| `STRIPE_SECRET_KEY` | yes | Optional. A Stripe secret key (a test-mode one outside production). Needed with the next one before anyone can subscribe. |
| `STRIPE_WEBHOOK_SECRET` | yes | Optional. The signing secret of the webhook endpoint registered at Stripe, which points at `/api/stripe/webhook`. |
| `WORDPRESS_LOCAL_ORIGIN` | no | Optional, and only on a developer's machine: the one origin of a WordPress run there for testing, such as `http://localhost:8099`, which the Worker may then reach over http. Never set on a deployment. |
| `CLOUDFLARE_HOSTNAMES_TOKEN` | yes | Optional. A Cloudflare API token that may create and remove custom hostnames on the zone below, and nothing else. Without it and the zone ID, no answer subdomain is offered, except on sample data, where nothing is registered anywhere. |
| `CLOUDFLARE_ZONE_ID` | no | The Cloudflare zone answer subdomains are registered on as custom hostnames: `nearcited.com`'s. Set in `wrangler.jsonc`. |
| `CONNECTIONS_KEY` | yes | Optional. The key a connection's sign-in is sealed with: 32 random bytes in base64 (`openssl rand -base64 32`). Without it nothing can be connected. Changing it makes every sign-in already kept unreadable. `pnpm local:env` makes one for the local machine. |

The web app reads two values at build time, from `apps/web/.env.local` or the environment. Both
are safe to ship to the browser.

| Name | What it is |
| --- | --- |
| `VITE_SUPABASE_URL` | The same project URL. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | The same publishable key. |

The Pages Worker has two settings, `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, in `vars` in
`apps/pages/wrangler.jsonc`, which point at production. Neither is secret. Locally,
`apps/pages/.dev.vars` points them at the local stack instead, so `pnpm --filter @nearcited/pages
dev` reads the local database.

None of these files is committed. `apps/api/.dev.vars.example`, `apps/web/.env.example` and
`apps/pages/.dev.vars.example` are the templates.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Worker and web app with reload. The Pages Worker is not part of it: `pnpm --filter @nearcited/pages dev` runs it on port 8788. |
| `pnpm check` | Lint, typecheck, test and build. Run before pushing. |
| `pnpm lint` / `pnpm format` | Biome check / fix |
| `pnpm typecheck` | `tsc` in every package |
| `pnpm test` | Every unit test, including the row-level security tests |
| `pnpm build` | Build the web app, which also writes `apps/web/dist/third-party-licenses.md` ([License](#license)) |
| `pnpm e2e` | End-to-end tests in a browser (needs `supabase start` and the env files; `pnpm check` does not run them) |
| `pnpm smoke` | Smoke test against a deployment (`E2E_APP_URL`, `E2E_SUPABASE_URL`, `E2E_SUPABASE_PUBLISHABLE_KEY`, `TEST_ACCOUNT_EMAIL`, `TEST_ACCOUNT_PASSWORD`) |
| `pnpm test-account:create` | Make the deployment's test account and grant it the `test` platform role; safe to run again (needs `SUPABASE_SECRET_KEY`, `TEST_ACCOUNT_EMAIL`, `TEST_ACCOUNT_PASSWORD`) |
| `pnpm local:env` | Write `apps/api/.dev.vars`, `apps/web/.env.local` and `apps/pages/.dev.vars` from the examples and `supabase status`, with a newly made `CONNECTIONS_KEY` (`--force` replaces existing files, and so makes a new key) |
| `pnpm billing:check` | Ask Stripe and the deployment whether billing is set up as the app expects (Tax active with a registration, the portal set to cancel only, the webhook registered with the events the app acts on and answering 400 to an unsigned request, each paid plan's prices matching, every recorded subscription existing under the key). Reads only; exits 1 when a check fails (needs `STRIPE_SECRET_KEY` and `SUPABASE_SECRET_KEY`) |
| `pnpm cf:deploy` | Build, then `wrangler deploy` for the Worker, then for the Pages Worker |
| `scripts/hosted-pages-setup.sh` | A wizard for the Cloudflare setup hosted pages need, run once by the owner after a deploy (see [Deploy](#deploy)) |
| `pnpm db:types` | Generate TypeScript types from the local Supabase database |
| `pnpm --filter @nearcited/api test` | One package's tests (`api`, `web`, `shared`, `pages` or `db`) |
| `npm run bootstrap:private` | Clone the private companion into `private/` (maintainers) |
| `npm run sync:main` | Fast-forward `main` here and in `private/` |
| `npm run audit:create -- --name ... --city ... --prompt ...` | Create a shareable audit and queue it (owner only; see below) |
| `npm run audit:revoke -- <link or token>` | Make an audit's link stop working |
| `pnpm test:scripts` | Tests for the scripts in `scripts/` |
| `pnpm sync:agents` | Regenerate `.claude/skills` and `.codex/agents` from their sources |
| `pnpm sync:agents:check` | Fail if a generated copy is stale |

`audit:create` takes `--name` and `--city` (required), `--region`, `--country` (default `US`),
`--website`, `--samples` (1 to 5, default 5) and `--prompt` once for each of 1 to 5 prompts. It
prints the link. It needs `SUPABASE_SECRET_KEY`, `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in the environment, and reads the Supabase URL, the app URL and the queue
name from `apps/api/wrangler.jsonc`. Keep the values out of files in this repository; for
example, run it under `op run` with an env file of 1Password references. `billing:check` is run
the same way; it reads the deployment address and Supabase project from the same file. The operator can make the
same audit from the Audits section of the operator page, with no keys to hand.

## API

Every route is under `/api`. All except `/api/health`, `/api/audits/:token`, `/api/plans`,
`/api/visits` and `/api/stripe/webhook` need a Supabase
access token in the `Authorization: Bearer` header. Requests run in Postgres as that user, so a row in someone else's
organization reads as missing and returns 404. Payloads are defined in
`packages/shared/src/schemas.ts`.

| Method and path | What it does |
| --- | --- |
| `GET /api/health` | Liveness check. No sign-in needed. |
| `GET /api/audits/:token` | A shareable audit, for anyone holding its token. 404 if the token is unknown, revoked or past its 30 days. Never cached and not indexed. |
| `GET /api/plans` | The price list: every plan on sale, cheapest first, with its prices in US cents, its limits and its allowances. Needs no sign-in. A signed-in member also gets the plan their organization is on if it has been taken off sale. |
| `POST /api/visits` | What the line on a business's own site sends. No sign-in: the key in the body names the location, and the site comes from the request's `Origin` header, never from the body. Takes `{ key, referrer, tag, path }` for a visit that arrived from an assistant, or `{ key, check: true }` for its owner checking the line is there. The route works out the assistant from `referrer` and `tag`, and `record_visit()` counts the visit only for a page on the location's own website, on a plan that includes visits, within a day's ceilings (1,000 visits, under 50 pages). A body over 4,096 characters, or not that shape, is ignored. Always 204 with no body, whatever became of it. |
| `POST /api/stripe/webhook` | Stripe reporting on a subscription. No sign-in: the signature on the request is checked against `STRIPE_WEBHOOK_SECRET` (400 `invalid_signature` if it fails), the subscription is read back from Stripe, and the organization's plan is made to agree with it. The one route that uses the Worker's secret key on a request. 503 `billing_unavailable` when Stripe is not set up. |
| `GET /api/me` | The signed-in user, their platform role (`operator`, `test` or none) and their organizations. |
| `GET /api/operator/overview` | The operator's view: totals, what needs attention (an organization held for an untold action included), every organization (test ones apart) and what the deployment runs. 404 to anyone who is not the operator. |
| `GET /api/operator/spend` | What the providers were paid in this calendar month (UTC) and the two before: a total, each organization, audits, and deleted organizations, in US dollars, with any model that has no rate named and left out. 404 to anyone who is not the operator. |
| `GET /api/operator/accounts` | A funnel of how far accounts got, and every account with its stage; test accounts are listed and not counted. 404 to anyone who is not the operator. |
| `GET /api/operator/plans` | Every plan, on sale or not, with its `organizations`, `subscribers`, `monthly_cents`, `price_change` (the open announcement with how many were `told` and `moved`, or null) and `limit_change` (the open reduction with how many organizations were `told` and the names of those `not_told`, or null); test organizations are left out. 404 to anyone who is not the operator. |
| `POST /api/operator/plans/:key/impact` | How many organizations a set of plan settings (`PlanSettingsSchema`) would reach and how many prompts it would set aside. Changes nothing. 404 to anyone who is not the operator. |
| `PUT /api/operator/plans/:key` | Sets a plan's name, on-sale flag, limits, allowances and emailed report, re-applies it to every organization on it, and records the change. Not its prices. Takes an optional `reduce_on` date. Raises, the name and the on-sale flag are saved at once; on a plan with subscribers what is lowered (an allowance taken away or made smaller included) is announced for `reduce_on` instead, and on a plan nobody pays for it is made at once. A kind of allowance this build does not know is put back as it was. 404 to anyone who is not the operator, 409 `needs_notice` for a reduction on a plan with subscribers without `reduce_on`, 409 `limit_reached` for a day less than 30 days out, 422 for a value out of range or a kind of allowance that does not exist, 503 `billing_unavailable` for an announcement without `RESEND_API_KEY`. |
| `DELETE /api/operator/plans/:key/limit-change` | Calls the plan's announced reduction off before its day and tells everyone who was told. 404 to anyone who is not the operator or when there is none. |
| `PUT /api/operator/plans/:key/prices` | Sets what a plan is sold at from now: `price_cents` and `extra_location_price_cents` (nullable), each at least a dollar. Makes two new prices at Stripe (a price cannot be edited), then calls `operator_set_plan_prices()`, which keeps the pair in `plan_prices`, puts it on the plan and records the change. Touches no subscription: current subscribers keep the price they pay. Answers the plan. 404 to anyone who is not the operator or for an unknown plan, 409 `free_plan`, 409 while a price change is announced, 422 `no_change` or a value out of range, 503 `billing_unavailable` when Stripe is not set up. |
| `GET /api/operator/audits` | Every shareable audit, with its link only while it is neither revoked nor expired. 404 to anyone who is not the operator. |
| `POST /api/operator/plans/:key/price-change` | Announces the plan's present prices to its current subscribers. Takes `effective_on`, a date. Emails each organization's owners (one queue message each) and moves each subscription at its next renewal from that day. Answers the change, 201. 404 to anyone who is not the operator or for an unknown plan, 409 `limit_reached` for a price rise less than 30 days out, 409 when one is already open, 503 `billing_unavailable` without Stripe or `RESEND_API_KEY`. |
| `DELETE /api/operator/plans/:key/price-change` | Calls the plan's open announcement off before its day and tells everyone who was told. 404 to anyone who is not the operator or when there is none. |
| `POST /api/operator/audits` | Makes a shareable audit and queues one message per prompt. Takes `business_name`, `city`, `prompts` (1 to 5) and optionally `website`, `region`, `country_code`, `samples` (1 to 5). 404 to anyone who is not the operator, 409 where scans return sample data, 422 for a bad value. |
| `GET /api/operator/organizations/:organizationId` | One organization, for the operator to read through its pages. 404 to anyone who is not the operator. |
| `PUT /api/operator/organizations/:organizationId/limits` | Sets an organization's four limits (locations, prompts per location, manual scans a month, days between scans) and its allowances, and records the change. A kind of allowance this build does not know is put back as it was. 404 to anyone who is not the operator, 422 for a value out of range or a kind of allowance that does not exist. |
| `POST /api/organizations` | Create an organization; the caller becomes its owner. The name needs a letter. 409 when the account already has one. |
| `PATCH /api/organizations/:organizationId` | Rename an organization. Owners and admins only; anyone else reads it as missing and gets 404. The name needs a letter. |
| `PUT /api/organizations/:organizationId/assistants` | Sets which assistants the organization is checked on, from ChatGPT and Claude, as many as its plan covers. Owner only: 404 to anyone else. 409 with the reason when the choice is not one the plan allows. |
| `GET /api/organizations/:organizationId/locations` | List an organization's locations. |
| `POST /api/organizations/:organizationId/locations` | Add a location. The phone is stored as E.164 in the location's country, the website with `https://`, and the postal code, country, place ID, name, city and `what_we_do` (what the owner says the business does, optional, at most 600 characters) are checked; a bad value answers 422. |
| `GET /api/organizations/:organizationId/account` | What Account settings shows: `manual_scans_used` this month, `allowance_use` (how much of each counted allowance is used this month, by kind; a kind with none used is absent) and `limit_change` (`lowered`, the limits going down with their `from` and `to`, and the day `at`, or null) for anyone who can read the organization, and `billing` (`available`, `subscribed`, `status`, `has_customer`, `locations` paid for, `renews_at`, `paying` (the prices the subscription is billed at and its `monthly_cents`, which may be older than the plan's present price), `pending`, a change waiting for the period's end, read live from Stripe, and `price_change`, the `monthly_cents` and day (`at`) an announced change will move it to, absent once moved) for its owner alone. `billing` is null for a member and for the operator. 404 to a stranger. |
| `POST /api/organizations/:organizationId/checkout` | Starts a subscription. Takes `plan_key` and optionally `locations`; answers `{ url }`, Stripe's checkout page. Changes no plan: the plan moves when the webhook reports the payment. Owner only: 404 to anyone else, the operator included. 409 for a test organization or one already subscribed, 422 `plan_unavailable` for a plan that cannot be bought, 503 `billing_unavailable` when Stripe is not set up. |
| `POST /api/organizations/:organizationId/billing-portal` | Answers `{ url }`, Stripe's account pages, where the owner changes the payment method, reads invoices, pays a failed invoice or cancels. Owner only: 404 to anyone else. 409 `no_subscription` for an organization that never subscribed; 503 `billing_unavailable` when Stripe is not set up. |
| `POST /api/organizations/:organizationId/subscription/preview` | What changing to `plan_key` (and optionally `locations`) would do: `kind` (`upgrade` or `downgrade`, decided on the server from the plans' prices), the new `monthly_cents`, `due_now_cents` and `effective_at`. Changes nothing. Owner only: 404 to anyone else, the operator included. 503 `billing_unavailable` when Stripe is not set up. |
| `PUT /api/organizations/:organizationId/subscription` | Makes that change, same body and answer. An upgrade (a higher monthly price, or the same) is made at Stripe now and the prorated difference charged; a downgrade is scheduled at Stripe for the end of the paid period and charges nothing. Changes no plan here: the plan moves when the webhook reports it. Owner only, 404 otherwise. 402 `payment_declined` when the card is refused (nothing changed), 409 `no_subscription`, 409 `payment_due` when the subscription is not `active`, 422 `no_change`, 422 `plan_unavailable`, 503 `billing_unavailable`. |
| `DELETE /api/organizations/:organizationId/subscription/pending` | Drops a waiting downgrade; 204. Owner only, 404 otherwise. |
| `GET /api/organizations/:organizationId/connections` | What the Connections page shows: the organization's `connections`, removed ones included, newest first; `available`, the kinds that can be connected here now (empty without `CONNECTIONS_KEY`, and without a kind the organization's allowances leave out); and `can_manage`, whether the caller is its owner or an admin. Never a sign-in. For anyone who can read the organization, the operator included. 404 to a stranger. |
| `POST /api/organizations/:organizationId/connections` | Connects an account. Takes `kind` (`sample`; a `wordpress` one and a `hosted_pages` one are connected from a location, below, and answer 422 `connect_from_location` here). The Worker seals the sign-in before it is stored; answers the connection, 201, without it, and queues its first sync. Owner or admin only: 404 to anyone else, the operator included. 422 `connection_unavailable` for a kind not offered here, which includes one its allowances leave out, 503 `connections_unavailable` without `CONNECTIONS_KEY`. |
| `POST /api/locations/:locationId/wordpress/check` | Asks the location's website, with no sign-in, whether it is a WordPress whose REST index offers application passwords. Answers `verdict` (`ready`, `not_wordpress`, `passwords_off`, `unreachable` or `no_website`), `authorize_url` and `site_name`. Owner or admin only: 404 to anyone else, the operator included. 409 `hosted_pages_connected` where the location's pages are hosted. |
| `POST /api/locations/:locationId/wordpress` | Connects the location's WordPress site with what WordPress handed back after the owner approved: `site_url`, `user_login` and `password`. The Worker signs in, checks the site is the location's website and the account can publish pages, seals the sign-in, keeps the connection made from this location and queues its first sync; answers the connection, 201, never the password. Owner or admin only: 404 to anyone else, the operator included. 422 `not_this_site`, `refused` or `cannot_publish`, 502 `unreachable`, 409 `already_connected`, 503 `connections_unavailable` without `CONNECTIONS_KEY`, 422 `connection_unavailable` where the plan does not include it, 409 `hosted_pages_connected` where the location's pages are hosted. |
| `GET /api/locations/:locationId/hosted-pages` | The location's hosted pages for its Website tab: `barred` (why it cannot have any now: `not_included`, `unavailable`, `no_website` or `wordpress`; null otherwise), `can_manage`, and `subdomain`, its answer subdomain with the name, the target its record points at, what the name last pointed at, when it was registered and when it went live, whether the home page links to it, and when the wait for the record ends. Never anything the worker keeps for itself. For anyone who can read the location. |
| `POST /api/locations/:locationId/hosted-pages` | Sets up the location's answer subdomain. Takes `label`, one word that goes in front of the website's domain; answers the subdomain, 201, and queues the worker's first check. Owner or admin only: 404 to anyone else, the operator included. 422 `connection_unavailable` where the plan does not include it, `no_website`, `bad_label`, or `in_use` for a name that already points somewhere; 503 `hosted_pages_unavailable` where the deployment cannot register one; 409 `wordpress_connected`, `already_connected`, or `taken` for a name another connection holds. |
| `DELETE /api/connections/:connectionId` | Asks for a connection to be removed: it becomes `removing` and the worker is queued to take back the access and delete the sign-in, after which it is `removed`. Answers the connection. Asking again changes nothing recorded. Owner or admin only: 404 to anyone else, the operator included. |
| `PUT /api/connections/:connectionId/locations/:locationId` | Says which of the things a connection reaches is a location's, replacing what was said before. Takes `external_id`; answers the match, and queues a sync so the worker can propose actions for the location. Owner or admin only: 404 to anyone else, the operator included, and for a location of another organization. 422 `not_matched_by_hand` for an answer subdomain, which belongs to the location it was set up for. 409 `limit_reached` with the reason for a choice the account does not reach, one that is another location's, a location that already has an account of the same kind, or a connection that is not working; 422 for a blank `external_id`. |
| `DELETE /api/connections/:connectionId/locations/:locationId` | Takes a location's match away; 204. Owner or admin only: 404 to anyone else, or when there is none. |
| `GET /api/locations/:locationId/actions` | A location's actions, newest first, at most 100 in all: `waiting` (those waiting for a yes) and `record` (the rest, including any being carried out), and `held`, true while nothing more is carried out for the organization because its owners have not been told of an action. Each says what it would do, what was there when it was proposed (until it may be kept no longer, and then the day it was dropped, `seen_dropped_at`), its text and whether a rule or a model wrote it, who approved or declined it and when, and how it ended. For anyone who can read the location, the operator included. 404 to a stranger. |
| `GET /api/organizations/:organizationId/actions/waiting` | How many actions wait for a yes at each of the organization's locations, as an object by location ID; a location with none is absent. 404 to a stranger. |
| `POST /api/actions/:actionId/approve` | A member's yes. Takes an optional `text`, 1 to 5,000 characters, which replaces what was proposed and is kept beside it, for a kind that allows it. Records the yes and queues the worker to carry the action out; answers the action. Any member of the location's organization: 404 to anyone else, the operator included. 409 `limit_reached` with the reason when it is no longer waiting or the plan has no more of its kind this month; 422 for a bad `text`, and 422 `not_editable` for a `text` sent for a kind that is approved as proposed; 503 `actions_unavailable` without `RESEND_API_KEY`, unless the deployment serves sample data or the organization is a test one. |
| `POST /api/actions/:actionId/decline` | A member's no. Takes an optional `reason`, up to 200 characters. Answers the action. Any member of the location's organization: 404 to anyone else, the operator included. 409 `limit_reached` when it is no longer waiting; 422 for a longer `reason`. |
| `POST /api/actions/:actionId/take-back` | Asks to have an action that was done taken back: a new action, already approved by the caller, that points at it (`takes_back`) and puts back what the first replaced, or removes what it added. Queues the worker; answers the new action, 201. Any member of the location's organization: 404 to anyone else, the operator included. 409 `limit_reached` for an action that is not done, one whose record of what it replaced was dropped, one with another waiting or on its way for the same thing, or one a later action has changed; 503 `actions_unavailable` as for the yes. |
| `POST /api/actions/:actionId/retry` | Asks for a failed action again: a new action, already approved by the caller, that points at the one that failed; queues the worker. Answers the new action, 201. Any member of the location's organization: 404 to anyone else, the operator included. 409 `limit_reached` for an action that did not fail, when another for the same thing is waiting or on its way, or when the plan has no more of its kind this month; 503 `actions_unavailable` as for the yes. |
| `POST /api/alerts/:alertId/dismiss` | A member's dismissal of an alert: it leaves the location page, and a drop is raised again only once it has ended and begun afresh. Records who and when; answers the alert. Dismissing one already dismissed or cleared changes nothing. Any member of the location's organization: 404 to anyone else, the operator included. Alerts are raised and cleared only by the worker, when a scan finishes. |
| `POST /api/locations/:locationId/tasks/:taskId/draft` | A member's ask for a draft of one task, the first or another. Records the ask and queues the worker, which writes it and takes one from the month; answers the draft as asked, 202 (`status` `asked`, and the `text` last written, if any, which stays until the new one lands). Asking while one is being written is the same ask. Only a member of the location's organization asks: anyone else, the operator included, gets 404, whatever the task. 409 `no_draft` for a task with no wording to write, 409 `what_we_do_missing` until the location has said what the business does, 409 `limit_reached` when the plan includes no drafts or the month's are used, 503 `drafts_unavailable` on real data where this build has no instructions for the task's kind of draft (they come with the private tuning) or the deployment has no `ANTHROPIC_API_KEY` (a task is not offered a draft there, so only a request made by hand reaches this); sample text, for a deployment in mock mode or a test organization, is never refused for it. |
| `PUT /api/locations/:locationId/listings/:site` | A member gives the address of the business's own page on a site, the first time or in place of the one before. Takes `url`. Only its shape is checked and nothing is opened: it must be a page on that site or a subdomain of it, over https (an `http://` address, or one pasted without its start, is read as https), not the site's front page, and at most 500 characters once kept without the part after `#`. For `google.com` what is given is the review link Google gives a business, not a page: an address on `g.page` or on `google.com` or a subdomain of either, other than a front page, a search address (the path `/search`) or anything on `business.google.com`, with a sentence that says where the link is. Answers the listing (`site`, `url`, `set_by_email`, `set_at`). `site` is the name on the list of known sites, such as `bbb.org` or `google.com`, and only a site that lets a business ask for reviews has listings: any other name is 404. Any member of the location's organization: 404 to anyone else, the operator included. 409 `limit_reached` when the location already holds listings on 50 other sites, 422 `validation_failed` with a sentence for an address that is not such a page. |
| `DELETE /api/locations/:locationId/listings/:site` | A member takes the listing away; 204. 404 when there is none, for a site no task asks for a listing on, and to anyone who is not a member of the location's organization, the operator included. |
| `GET /api/locations/:locationId/line` | A location's line, for anyone who can read the location, the operator included: `{ line, html, can_replace }`, where `line` is its key, when the key was made and the last day (UTC) the line answered a check from the site, `html` is the line to paste (built from `APP_URL`) and `can_replace` is whether the caller is an owner or an admin. 404 to anyone else. |
| `POST /api/locations/:locationId/line/key` | An owner or an admin gives the location a new site key through `replace_site_key()`. The old key then belongs to nobody, so the line on the site counts nothing until the new one is pasted; what was counted stays, and the new key has answered no check. Answers the same shape as the read above. 404 to anyone who is not an owner or an admin of the location's organization, a plain member and the operator included. |
| `GET /api/locations/:locationId/visits` | A location's visits from assistants over the last 30 days (UTC, today included), added up in the database by `location_visits()`: `{ since, days, pages, other_pages }`. `days` is the count for each day and assistant that had any, `pages` the ten paths with the most visits, and `other_pages` the visits to pages past the fiftieth of their day, which are counted together. For anyone who can read the location, the operator included; 404 to anyone else. It is what the location's site reported: nothing is generated, on sample data or for a test organization. |
| `PUT /api/locations/:locationId/tasks/:taskId/page` | A member says where the page for a page task is, the first time or in place of the one before. Takes `url`. Only its shape is checked and nothing is opened: https, a page on the location's own website or a subdomain of it, not its home page, at most 500 characters once kept without the part after `#`; 422 otherwise. Answers the page (`recommendation_id`, `url`, `set_by_email`, `set_at`). Any member of the location's organization: 404 to anyone else, the operator included, and for a task that is not a page task. |
| `DELETE /api/locations/:locationId/tasks/:taskId/page` | A member takes the page's address away; 204. 404 when there is none, and as above. |
| `GET /api/locations/:id` | One location with its queries, latest scan, rates over recent scans, the sites those answers cited, the surfaces being checked, recommendations, the latest website check, the action plan, the owner's tasks (each with `draft_kind`, the kind of draft that can be written for it now, `note` for a task about a page somebody wrote and `listing` for one about a directory or a review site that does not let a business ask for reviews, in either case only while the task is still to do and only where this deployment can write one (sample data, which is a deployment in mock mode or a test organization, writes every kind; real data only a kind the build has instructions for, with `ANTHROPIC_API_KEY` set), and otherwise null, and its `draft` once one has been asked for; and `listing`, `{ site, url, review_url }` for a task about asking customers for reviews on a site that has listings, with `url` the business's own page there (on `google.com`, the review link Google gave) or null until a member gives it, and `review_url` where a customer writes a review, null until there is a listing and on a site whose form address is not known, and null for every other task), where the organization's month of drafts stands (`drafts`: `allowed`, null when the plan includes none, `used`, and `resets_on`, the first of next month in UTC), the connected accounts it is matched to (`connections`), its open alerts (`alerts`: not cleared, not dismissed, and, for a drop, not about a prompt since retired) its page tasks (`page_tasks`: a page to publish for each prompt no answer named the business for, with the counts of answers before the task was marked done and since, its `draft_kind` and `draft` as a task has them, and where the page is once a member said), and the fix for a page with no structured business details (`details_fix`: whether a member marked it done, whether a scan has looked since, and how many answers cited the business's website before the mark and since; null until the check has found them missing). |
| `PATCH /api/locations/:id` | Replace a location's details with a whole location body, as when adding one; a field left out goes back to blank or its default, except `what_we_do`, which stays as it is when the body leaves it out (a blank one clears it), so a page opened before the field existed cannot wipe it. The same checks as adding. |
| `POST /api/locations/:id/activate` | Brings a location the plan paused back into use. Takes `instead_of`, the location in use that is paused in its place, when the plan has no room; 409 with the reason without one. 404 to a non-member. |
| `DELETE /api/locations/:id` | Delete a location and its history. |
| `POST /api/locations/:id/queries` | Add a prompt or keyword to track; the text needs letters (three for a prompt). Adding one that was retired restores it. |
| `PATCH /api/queries/:id` | Retire a tracked query, or restore it. Its results are kept. |
| `PATCH /api/recommendations/:id` | Mark a recommendation open, done or dismissed (`status`), and/or say its work was done or undone (`acted`, a boolean; also how a member marks the structured business details as on the page). 409 `limit_reached` for `acted` on a task an action did: that mark stays. |
| `GET /api/locations/:id/scans` | The last 30 scans for a location. |
| `POST /api/locations/:id/scans` | Queue a manual scan. 409 if one is already under way, which the database enforces. |
| `GET /api/scans/:id` | One scan with its results. |

## Data model

The migrations in `supabase/migrations/` define everything.

| Table | Holds |
| --- | --- |
| `organizations` | The tenant. Every other row belongs to one. Holds its usage limits (locations, active prompts per location, manual scans a calendar month) and its plan settings (which plan it is on, whether a report is emailed, how many days apart it is scanned, on which surfaces, and its allowances). |
| `platform_roles` | What an account is to the product as a whole (`operator` or `test`). A user reads only their own row, the operator reads all; rows are written with the secret key. An organization made by a `test` account is flagged `is_test` and scans on generated data. |
| `memberships` | Which users belong to an organization, as `owner`, `admin` or `member`. |
| `locations` | A business at an address, with what its owner says it does in a few sentences (`what_we_do`, at most 600 characters). How often it is scanned is its organization's plan's to say. |
| `tracked_queries` | The prompts and keywords checked for a location. A retired one is kept, with its results, but not scanned. |
| `scans` | One run for a location: its trigger, status, whether it ran on sample data, the score over the window it closed, and the check of the location's website it made. |
| `scan_results` | One row per query and surface: named or not, position, who else was named, and the phone numbers the answer gave for the business (`phones`, in international form, read as the scan finishes since only an excerpt of the answer is kept). |
| `recommendations` | What a scan suggested, whether the user has dealt with it, when a member said they did the work, or an action did it (`acted_at`, which no scan changes), and the action that did it (`acted_by_action`, which a member cannot clear). |
| `alerts` | Something measured that changed at a location in a way its owner would want to know, kept from the scan that raised it. Its kind (`drop`; a first sighting, `competitor` or `site`; or `phone`, a number the answers give for the business that is not the one on file), for a drop the prompt and surface it is about, the counts it rests on (`facts`), when it began (`since`) and the scan that raised it; whether that scan ran on sample data (`sample_data`), since sample and real alerts are kept apart. The Worker clears it, with a reason (`named_again` or `not_tracked` for a drop, `old_news` for a first sighting, `no_longer_given`, `now_on_file` or `not_tracked` for a phone number), when a later scan shows it has ended or it is no longer news; a member dismisses it, which records who, as the address they had then, and when, and does not clear it (a dismissed phone number is never cleared, so it is never raised again). `subject` is the Worker's bookkeeping, so one alert is current for a thing. `told_at` and `cleared_told_at` are when the organization's owners were emailed that it was raised, and that it ended (only for one they had been told of); no route sends them. Read by whoever can read the location and by the operator; written by no API role directly, only by the Worker's `complete_scan()` and, for a dismissal, `dismiss_alert()`, which answers a member of the location's organization alone, and its secret key alone writes the two told columns. The Worker alone calls `seen_before()`, which reads what a location's earlier scans named and cited, so that a first sighting is said of the whole record. Deleted with its location. |
| `audits` | A shareable audit: the business, its prompts, the results as each prompt finishes, and its token, expiry and revocation. Belongs to no organization; only the operator can read it through the API. |
| `operator_actions` | What the operator changed or made, one row per action, with who and what: an organization's limits before and after, a plan's settings or prices before and after, or the audit made. Written only by the function that does it; only the operator can read it through the API. |
| `plans` | What is on sale: a monthly price for the locations a plan includes, a price for each extra location, its limits and its allowances. Read by everyone; written by no API role. An organization's `plan_key` names its plan, or is null when its limits were set by hand. |
| `allowance_kinds` | The kinds of work a plan can include, each counted (a number a month for each location) or not (included or not). A plan's or an organization's allowances may name only these, and the database refuses any other. Two exist: `drafts`, counted, which every paid plan includes and the free plan does not (the migration `20261012180000_drafts_on_plans.sql` set the numbers the plans started with, and gave an organization already on one its plan's, leaving a test organization's and any other limit an operator set for it), and `visits`, included or not, which every paid plan includes and the free plan does not (the migration `20261013220000_visits_shown.sql` put it on the paid plans and gave it to an organization already on one, leaving a test organization, which already had it, and any other limit an operator set for it). Read by everyone; written by no API role. |
| `allowance_use` | How much of each counted allowance an organization has used in a calendar month (UTC). Read by the organization's members and the operator; written only by the Worker, through `claim_allowance()` and `release_allowance()`. |
| `plan_prices` | Every pair of prices a plan has been sold at (the plan's price and its extra-location price, in cents, with the Stripe price IDs). The newest is also on the plan's row. A subscription is matched to its plan by any of them. Read by anyone signed in, not by a visitor; written by no API role. |
| `price_changes` | One announcement per plan: the price version subscribers move to, the day it takes effect, and when it was reminded, called off or completed. Read by anyone signed in; written by no API role, only by the operator's functions. |
| `price_change_notices` | One row per organization in an announcement: when it was told, reminded, told it was called off, moved, or skipped. Read by the operator; written only by the Worker. |
| `limit_changes` | One announced reduction per plan: what goes down (each limit's, and each allowance's, `from` and `to`), the day it is made, and when it was reminded, called off or completed. Read by anyone signed in; written by no API role, only by the operator's functions and the Worker's. |
| `limit_change_notices` | One row per organization in an announcement: when it was told, reminded, told it was called off. Read by the operator; written only by the Worker. |
| `subscriptions` | An organization's Stripe customer and subscription IDs and the status Stripe last reported. Also the subscription its owners were last thanked for by email. Written only by the Worker, from the webhook; no API role can write it. The operator reads it directly, an owner through `billing_state()`. |
| `connections` | An organization's standing sign-in to an outside account: its kind (`sample`, `wordpress` or `hosted_pages`), a label, the location a WordPress one was made from until its first sync matches it (`for_location`), and its status (`working`, `broken`, `paused`, `removing` or `removed`). Records who connected it and who asked for its removal, as the addresses they had then, and when, and whether it was removed because someone asked or because its plan had not included it for thirty days (120 for an answer subdomain) or, for an answer subdomain, it never started working, or its location was removed (`removal_reason`: `asked`, `plan`, `unclaimed` or `location`). A broken one records why (`refused` or `failing`), when, and how many days in a row a sync has failed; a paused one records since when. Also when its owners were told it broke and when they were reminded. Also when the Worker last read it (`last_synced_at`) and what its sign-in reaches, as that sync found it (`choices`, a list of `id` and `label`; cleared on removal). The row stays after removal, as the record. Read by the organization's members and the operator; written by no API role directly, only through `create_connection()` and `request_connection_removal()`, which answer an owner or admin alone, and the Worker's `record_connection_sync()`, `record_connection_failure()`, `expire_paused_connections()` and `finish_connection_removal()`, and `fit_connections_to_plan()`, which pauses and restores them when an organization's allowances are set. |
| `connection_locations` | Which of a connection's choices is a location's: one account of a kind for a location, and one location for each thing an account reaches. Read by whoever can read the location and by the operator; written by no API role directly, only through `match_connection_location()` and `unmatch_connection_location()`, which answer an owner or admin of the connection's organization alone. Deleted when the connection's removal finishes. |
| `answer_subdomains` | An answer subdomain, one per connection of the `hosted_pages` kind and one per location: its location (removed with the location), the hostname, the target its record must point at (a name of the connection's own under `pages.nearcited.com`), what the name last pointed at, when the worker last checked, when it was registered and when it went live, whether the home page links to it, and the Cloudflare ID of its custom hostname and when the owners were told it was live and when they were told it was paused (`pause_told_at`), which the worker keeps to itself. A hostname is held by one live connection at a time. Read by the organization's members and the operator, on every column but those; written by no API role directly, only through `create_answer_subdomain()` (an owner or admin of the location's organization alone, which also makes the connection and refuses a location without a website), and the Worker's `record_answer_subdomain_check()`, `answer_subdomains_to_check()`, `expire_unclaimed_answer_subdomains()` and `answer_subdomains_paused_untold()`. `create_connection()` refuses the `hosted_pages` kind and a WordPress connection for a location whose pages are hosted; `finish_connection_removal()` lets the name go; deleting the location removes its subdomain. |
| `hosted_pages` | A page served on an answer subdomain: its connection and location, the page task and action it came from, its address (`slug`, one live page per address on a subdomain), title, the copy as approved (at most 20,000 characters), when it was published and when it was taken back (the row stays, so its address answers that it is gone). Read by the location's members and the operator; no API role writes it directly, and a caller who is not signed in reads nothing from the table. Anyone reads a live page only through `hosted_page(host, path)`, which the Pages Worker calls with the publishable key and which answers only for a live answer subdomain, with what the page shows anyway, or, for a subdomain paused more than thirty days, where to send the visitor instead (the location's website). Written only by the Worker, through `publish_hosted_page()` and `take_back_hosted_page()`, for an approved or taking-back action of the `hosted_page` kind. |
| `hosted_page_fetches` | How often a known fetcher read a hosted page on a day: the page, its location, the day (UTC), the fetcher (one of ten the table's check names, the same as `PAGE_FETCHERS`) and a count of 1 to 1,000; one row for a page, a day and a fetcher. Read by the location's members and the operator; a caller who is not signed in reads nothing and no API role writes it. Counted only by `record_page_fetch()`, which the Pages Worker calls with the publishable key: it takes its own day, counts only a live page on a live answer subdomain and a known fetcher, stops at 1,000 a day for a page and fetcher, and tells the caller nothing. Anyone can claim to be a fetcher, so the count can be padded and nothing is worked out from it. `location_page_fetches()` adds it up for a location, as the caller. |
| `connection_secrets` | A connection's sign-in, sealed by the Worker. Row-level security is on with no policy and no grant to any API role, the operator included: only the Worker reads it, and the row is deleted when a removal finishes. |
| `connection_kind_allowances` | The allowance an organization needs for a kind of connection; a kind not listed needs none, and the sample kind needs none, `wordpress` needs the `wordpress` allowance and `hosted_pages` the `hosted_pages` one. Row-level security is on with no policy and no grant to any API role, the operator included: only the database's own functions read it. |
| `actions` | What the product does outside itself for a location: what it would do, what was there when it was proposed, the text and whether a rule or a model wrote it, and its status (`proposed`, `approved`, `done`, `failed`, `declined` or `lapsed`). Records who approved or declined it, as the address they had then, and when; the text as approved, when a member changed it; how it ended, with the reason for a failure; the failed action it was asked for again from (`retry_of`), and the done action it takes back (`takes_back`). `told_at` and `waiting_told_at` are when the organization's owners were told it had been carried out, and that it was waiting for a yes. What it replaced is dropped once its kind says it may be kept no longer, and when is recorded (`seen_dropped_at`). Five more columns are the Worker's bookkeeping, and no route sends them: `subject` and `basis`, so that one action is open for a thing and a declined one is not proposed again until what it rests on changes; `recommendation_id`, the task it does the work of; `seen_until`, the day what it replaced may be kept until; and `allowance_month`, the month whose allowance it holds one of. Read by whoever can read the location and by the operator; written by no API role directly, only through `approve_action()`, `decline_action()`, `retry_action()` and `take_back_action()`, which answer a member of the location's organization alone, and the Worker's `propose_action()`, `claim_action()` (which refuses an action while `organization_held()`, Worker only, says its owners have gone 36 hours untold of one), `finish_action()` (which gives back what was taken from the allowance when the action ends undone, marks the task when it is done and clears it when a take-back is), `lapse_actions()` and `drop_expired_seen()`, and its secret key alone writes the two told columns. Deleted with its location. |
| `action_kind_terms` | What each kind of action is held to: the allowance it takes from, if any, and how many days what it replaced may be kept, if limited. Row-level security is on with no policy and no grant to any API role, the operator included: only the database's own functions read it. |
| `sample_listings` | What the sample account's listings say (an opening line): the outside world for the sample kind of action, which has none. Row-level security is on with no policy and no grant to any API role, the operator included: only the Worker reads or writes it. |
| `drafts` | Wording written for one of a location's tasks (a recommendation): one row for a task, and asking again replaces what it holds. Where the ask in hand stands (`status` `asked`, `written` or `failed`; who asked, as the address they had then, and when; why the last ask wrote nothing, as `failure`), and the draft last written, which stays while another is being written and when that fails: its `kind` (`note`, `listing` or `page`), its `text` (up to 4,000 characters), when it was written, whether it is sample text (`sample_data`), and the model that wrote it, null for sample text, which no route sends. `writing_since`, `attempts` and `allowance_month` are the Worker's bookkeeping, and no route sends them: whether a worker is on it, which try this is, and the month whose allowance it holds one of. Read by whoever can read the location and by the operator; written by no API role directly, only through `ask_draft()`, which answers a member of the location's organization alone (the operator and the Worker get no row), and the Worker's `claim_draft()`, which takes one from the month's allowance, and `finish_draft()`, which keeps what was written or gives the allowance back when nothing was. Deleted with its task and with its location. |
| `prompt_pages` | Where the page for one of a location's page tasks is, as a member gave it: one row for a task (`recommendation_id`, unique), an https address of at most 500 characters, who set it (as the address they had then) and when. That it is on the location's own website is the API's to check, and nothing opens it. Read by whoever can read the location and by the operator; written by no API role directly, only through `set_prompt_page()` and `remove_prompt_page()`, which answer a member of the location's organization alone and, for the first, only for a `page:` recommendation (the operator and the Worker get no row). `action_id`, when the page is one the product published: the action that did it, which keeps the link until that action is taken back (taking it back deletes the row). `keep_published_page()` writes that row and is called by the Worker alone; it keeps https addresses of at most 500 characters only, and `set_prompt_page()` clears `action_id`, since an address a member gives is theirs. Deleted with its task and with its location. |
| `listings` | The address of a location's own page on a site, as a member gave it (on `google.com`, the review link Google gives a business): one row for a location and a site, kept for the location and not for the task that asked for it. `site` is the name on the list of known sites in lower case (`bbb.org`, never `www.bbb.org`), `url` is an https address of at most 500 characters, and who set it (as the address they had then) and when are kept. A location holds at most 50. The database holds to the address's form and the count; that the site is one a task asks for a listing on, and that the address is a page on it (on `google.com`, a link of Google's), are the API's to check, and nothing opens the address. Read by whoever can read the location and by the operator; written by no API role directly, only through `set_listing()` and `remove_listing()`, which answer a member of the location's organization alone (the operator and the Worker get no row, and a call to remove one answers false). Deleted with its location. |
| `visit_lines` | A location's line: the `key` the line on its own site carries (32 characters of hex, made with the location by a trigger, and no secret, since it is in the site's source), when it was made (`key_made_at`, which an owner or admin replacing the key resets) and the last day (UTC) the line answered a check from the location's own site (`checked_on`). Read by whoever can read the location and by the operator; written by no API role directly: a trigger makes it with the location, and only `check_visit_line()`, which answers anyone holding the key, and `replace_site_key()`, which gives the location a new key (and a new `key_made_at`, with `checked_on` cleared) and answers an owner or an admin of the location's organization alone, change it. Deleted with its location. |
| `visits` | The visits from an assistant that a location's own site reported: one row for a location, a day (UTC), an assistant (`chatgpt`, `gemini`, `perplexity`, `copilot` or `claude`) and a page, with how many (`count`). The page is a path of at most 200 characters without what follows a question mark, or empty for the visits to every page past the fiftieth of a day, which are counted together. No row is a visit: there is no time of day and nothing about the visitor. Read by whoever can read the location and by the operator; no caller who is not signed in can read it, and no API role writes it directly, only `record_visit()`, which answers anyone holding a location's key. A location can hold up to 255 rows a day, so the counts are read added up and never row by row, by `location_visits()`: a plain function that runs as the caller, so it adds up only what the caller may read (a member's own location, or everything for the operator) and is callable by no one who is not signed in. Deleted with its location. |
| `provider_usage` | What the providers used for a scan or audit prompt, or for writing a draft, per surface and model: calls, input, cached input and output tokens, searches. A draft's use names the draft and the organization and no surface, which is null. Outlives the scan, audit, draft or organization it describes. Written only by the Worker; only the operator can read it through the API. `GET /api/operator/spend` prices it and the operator's view shows it, a draft's under its organization. |

Usage limits are enforced by database triggers, so they hold for the API and for anyone calling
the database directly. Going over one returns 409 `limit_reached` with a message that names the
limit and its value.

Row-level security policies on every table are the authorization layer. Signed-in users can
insert one kind of scan row, a queued manual scan for a location they can see; results, scores,
recommendations and alerts are written only by the worker, through `complete_scan()`. A member may
change two things on a recommendation and nothing else: its status, and whether its work was done
(not once an action did it). The one thing a member may do to an alert is dismiss it, and the one
thing a member may do to a draft is ask for it. The two things a member may do to a listing are give
it and take it away, each through a function. A visit from an assistant is counted by
`record_visit()` for whoever holds the location's site key, signed in or not, and no member writes
the count; it is read added up, by `location_visits()`, as the signed-in caller. Only an owner or an
admin can give the location a new key, through `replace_site_key()`.

`audits` is the exception to "every row belongs to an organization". Its table is closed to
signed-in and anonymous users alike, except that the operator can read it; the Worker and the owner's script use the secret key, and a
reader gets one audit only by its token, through the `get_audit()` function.

## Tests

- **`packages/shared`**: name matching, mention detection, scoring, recommendation rules, input
  validation, the tuning schema (a file without the draft settings included), its defaults and prompt rendering, audits, cited sources, the
  on-page check, the action plan, the structured business details block (what it states, what it leaves out, and that no detail can close its script element) and the fix for a page without it (unmarked, marked, and the answers that cited the business's website before and since), and the alert rules (when a drop, a first sighting or a phone number is raised and when it clears), and which phone numbers an answer gives for the business, and the draft rules (which tasks have a draft and of which kind, which of those a task is offered where only some kinds can be written, what one is written from, the check for a number, web address or email address in a draft that nobody gave, and where a month of drafts stands), and the listing rules (which sites a task asks for a listing on, Google among them; which pasted addresses are kept, which are changed to https and which are refused, and for Google which are taken as its review link; and which tasks carry one), and the request an owner sends a customer (its wording, that it asks for no good review and offers nothing, the name each review site goes by, held to the list of sites a task asks for reviews on, and the business's name tidied of stray spaces and not closed with a full stop twice), and the words on the card an owner prints (the business's name, the site named, how to use the code, and that it asks for no good review and offers nothing), and which assistant a visit came from (the site the browser names decides, a tag only where none is named, no search counts, and what the line sends is a visit or a check and nothing else), the line an owner pastes for a key (one script tag, loaded from where the product is served) and the address that opens the website on file as a check (none where what is on file is not an address).
- **`packages/db`**: applies the real migrations to in-process Postgres (PGlite) and checks, as
  different users, that one organization cannot read or write another's rows, that users cannot
  forge scan results or grant themselves a platform role, that worker-only functions and the `audits`, `provider_usage`, `connection_secrets`, `connection_kind_allowances`, `sample_listings` and `action_kind_terms` tables are closed to them, that only an owner or admin can connect, match or remove an account, that only an owner or admin of a location's organization can set up its answer subdomain, that a name is held by one connection and a location publishes to one place, that the worker's columns of an answer subdomain are unreadable to members and the operator and no API role writes it, that a connection breaks and is paused as it should, that only a member of a location's organization can approve, decline or ask again for an action and only the worker can propose or carry one out, that an organization is held once its owners have gone 36 hours untold of an action, that what an action replaced is dropped on its day, that a task an action did stays marked, that an action of a counted kind takes from the month's allowance once and gives it back unless the thing is done, that only the worker can ask that of an organization and a stranger is told nothing of a location's, that only the worker raises or clears an alert, reads what a location's earlier scans named and cited, or keeps that its owners were told of an alert, and only a member of a location's organization can dismiss one, that a result sent without phone numbers is kept with none, that only a member of a location's organization can ask for a draft (not the operator, not the worker) and only the worker can take one from the month's allowance or keep what was written, that a draft takes one from the month once and gives it back when nothing was written, that the draft from before stays while another is written or fails, that only the worker records what a draft used (for no surface; the operator's spend counts it and it outlives the draft), that only a member of a location's organization can give or take away a listing (not the operator, not the worker), that a location holds one listing for a site and no more than 50, that a listing is only an https address, that every location has a line from the moment it is made, that a visit is counted for whoever holds the key and only for a page on the location's own site, on a plan that includes visits, for an assistant the shared list names, with a path cut at a question mark and a length, within a day's ceilings on visits and on pages, that a check is noted and counts nothing, that only an owner or an admin can replace a location's key (a plain member, the operator, the worker and a caller who is not signed in get nothing), that the new key has answered no check, the old one counts nothing and what it counted stays, and that no API role writes the counts or calls what decides a visit, that a location's visits are read added up, by day and assistant and by page (the ten with the most, the visits kept under no page apart), over the days asked for and no more than a year, for a member of its organization and the operator and with nothing for anyone else, and that a caller who is not signed in may not ask, and that the operator reads every organization and changes only an organization's limits or a plan's settings or prices, each through one function that records it (announcing and calling off a price change or a reduction included). A further test runs every migration before the one that puts drafts on the plans, makes an organization on each plan, runs that one, and checks what each plan and organization then holds: each paid plan its number and the free plan none, an organization already on a plan its plan's number, and a test organization's number and a limit set for one organization left as they were. Another does the same for the migration that puts visits on the paid plans: each paid plan has them beside what it had and the free plan does not, an organization already on a plan has them and its visits are counted, a test organization and the rest of what an organization had are left as they were, and an organization gets them by joining a plan and loses them by leaving it. No Docker needed. It
  also checks `private/tuning.json` against the tuning schema where that file exists.
- **`apps/api`**: every route against an in-memory store, the scan runner (success, retry,
  permanent failure, reporting, scoring with given weights, refusing live scans on default tuning),
  the ChatGPT and Claude providers against responses in the shape the real APIs return, the
  scheduler, reading every row of a list that reaches across organizations a page at a time (the
  helper against a stand-in server: a server that answers with fewer rows than asked, a list that
  shrinks meanwhile, a page that fails), actions (proposing after a sync, a member's yes and no, carrying one out once, trying again, lapsing, telling the owners, holding back while they are untold, dropping what they replaced, marking a task, and counting against an allowance), alerts (raising a drop, a first sighting or a phone number, keeping each answer's numbers with its result, clearing them, reading the whole record only when a scan holds something that might be new, keeping a dismissed one from being raised again, leaving sample data apart, and telling the owners once in the scan report, or not telling them when the report goes to nobody), drafts (asking, which records the ask and writes nothing; refusing a task with no wording, a location that has not said what the business does, a plan with none and real data; writing sample text once and counting it, for a note and for a listing's description against the one month; throwing away a draft that states what nobody gave, and not counting one that was not kept; writing it again in place of the first; recording what each write used, kept or not; refusing real data where the build has no instructions for the task's kind of draft or no key, and offering a task a draft only where one could be written (every kind on sample data, and on real data only a kind with instructions and a key); and queueing again an ask nobody is writing), listings (giving one, which keeps the address a browser would follow and takes the place of the one before; refusing an address that is not a page on the site, and on Google one that is not its review link; the tasks that carry one; taking it away; who the routes answer; and the bound on how many a location holds), the Claude draft writer against recorded responses (what it is sent, with the instructions for the kind it is asked for, set out one detail to a line and with no tools, and what it reports having used), visits (`POST /api/visits` for a caller who is not signed in: the assistant worked out from what the visit carried and not taken from the body, the site taken from `Origin`, the same 204 whatever became of the visit, a body that is too long ignored, the ceilings, and a check that counts nothing; and a location's line, read by anyone who can read the location with the line to paste built from `APP_URL` and whether the caller may replace the key, and replaced by an owner or an admin and by no one else, after which the old key counts nothing and the new one counts on top of what was kept; and a location's visits, added up for the last thirty days, with the pages that had the most listed and the visits to the rest of a day's pages said apart, empty before anything is reported, a 404 for anyone else and a sign-in asked for), billing (checkout, the portal and the Stripe webhook, against a stand-in for Stripe), the audit runner, the site fetch (what it refuses and how it follows redirects), and
  the mock providers.
- **`apps/pages`**: the Pages Worker's front door against a stand-in database: a page as plain HTML (the name linking to the site, the copy as text, the closing line, the structured details), a taken-back page, a page never there, the list, `robots.txt`, the sitemap, the IndexNow key file, a host that is not served, the zone's own names handed on, http sent to https, methods that write refused, and the database being unreadable. `hosted_page()` itself is attacked in `packages/db`.
- **`apps/web`**: the logic that lays results out as a grid, the logic behind the chart of the
  score over time, the logic behind the audit page, the logic that fills the location edit form,
  the locations table's summary figures, the onboarding suggestions, the location page's tabs, what
  the Connections page and its sidebar link show, what the Actions tab says of each action, what a task says when an action did it, what a task's card offers for its draft and what the page says of the month's drafts and of who wrote one, what a task shows of the business's listing and the words it asks for one in, Google's steps to its review link included, what a task hands its owner to ask customers with (nothing for a task that asks for no listing or has none kept, else the review form where its address is known and otherwise the listing) and the words round the request, how the code to print is drawn (black on white with clear space round it), where the card for a site is (inside the account being read), what the card is made from (nothing for a site with no link kept) and the name the picture is saved under, and what the structured details' card says before a scan has looked and after, and where an organization stands with having visits counted (its plan includes them, another plan does, or none on sale does), how a location's visits are laid out for its page (by assistant, the one with the most first; by day, newest first, with who each day's visits came from; a day marked only once it has reached the most counted in a day; an assistant this build does not know named as the database names it), the words round the counts (the singular for one visit, what the count leaves out and that it can be padded, claiming no cause, and the most counted in a day as the database holds it), the day the line last answered, the words around the line and the four site builders' steps, and the line a business pastes into its site (`apps/web/public/line.js`, run against stand-in pages: it reports a visit from each assistant on the product's list, which the test holds to the shared list, and nothing for any other visit, sends the host and the path and nothing around either, counts an arrival once, does nothing in a frame or without a key, reports a check and never a visit for it, and keeps nothing in the browser).
- **`apps/e2e`**: `pnpm e2e` drives the real web app and Worker in Chromium against the local
  Supabase stack, in mock mode: sign-in by the emailed link, onboarding through the first scan, the
  location page, account settings, connecting a sample account, matching a location to it and removing it, approving a proposed action with its text changed and declining another, a drop shown on the Overview and in the locations table and then dismissed, a business named for the first time shown with a link to the answers, a listing pasted on a review task, refused when it is on another site, then copied, changed and removed, Google's review link asked for with the steps to it, refused when it is a search address, then kept and copied, a request to send handed over once the link is kept, copied whole and ending on the link, on the site the task is for and with its review form where that is known, taken away with the listing, offered for no site that forbids asking and none whose kind is unknown, and shown to the operator with nothing to change, the link drawn as a code that a QR reader (jsQR, which had no part in drawing it) reads back as that link, from the task, from the picture saved and from the card as it prints, and for the longest address a listing may have, the card page being the card alone on paper and offering none for a site with no link kept, the code and the card shown to the operator inside the account being read, saving a code marking nothing done, a phone number the answers give shown and dismissed as the business's own, the structured business details offered where a page has none, copied, marked done, kept with the location and taken back, a draft asked for once the business has said what it does, written, copied and written again, a listing's description written, and none offered on the free plan, which says so and links to the plans that list drafts, or for a task whose work is asking customers for reviews, one offered with the month's number for the locations covered on a plan that includes them, the operator's view and reading through an account, the public pages, the licence file served beside the app, the line a business pastes into its site served with its cache and cross-origin headers, a made-up site carrying the line and visited as if from an assistant (the browser is allowed to reach the product on this machine from a site that is public to it; a visit from ChatGPT, one out of ChatGPT's app by its tag and one from Perplexity are counted for the page they landed on; none is counted for a search, a typed address, a reload or the next page of the site, nor for a copy of the line on another site or on a plan that leaves visits out; nothing sent holds the address a visitor came from or what follows a question mark; and a check is noted without counting a visit), the card that hands the line over (copied, shown with where it goes, checked from a made-up site until the page says the day it answered, and the line as copied then counts a visit), the key replaced after a confirm so that the line with the old key counts nothing and the new one does, a location with no website asked for it first, an owner on a plan without visits told so with the way to the plans (the price list showing visits on each paid plan and not on the free one), what was counted still readable after a plan stops counting while the line adds nothing more, what the site reported shown by assistant, by day and by page with what the count leaves out and that it can be padded, a day that reached the most counted in a day said to have, the visits to pages past the fiftieth of a day counted together, and the operator shown a customer's line and counts with no way to replace its key, and two phone-sized runs, one of them fitting the counts and the line. It starts the Worker
  and web app itself, or reuses them if `pnpm dev` is up. The licence file and the line are read from the
  Worker, which serves the web app as it was last built, so run `pnpm build` first if the Worker was
  already running. `pnpm smoke` is a separate run against a
  real deployment: it signs in as the test account, refuses to go on unless that account's
  organization is a test one, then adds a location and a prompt, runs a scan (generated data), reads
  the results and deletes the location.
- **`scripts`**: `pnpm test:scripts` runs the tests for the private-companion, tuning,
  local-env, audit-creation, test-account, billing-check and branch-sync scripts.

### Integration tests

`apps/api/test/supabase-store.integration.test.ts` runs the real Supabase store against Postgres
and PostgREST, which is what a Supabase project is underneath. It also reads each list that
reaches across organizations one row to a page and checks that it is the list the whole read gives.
It is skipped unless `POSTGREST_URL` is set. CI runs it; to run it yourself, start Postgres and PostgREST, then:

```sh
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres scripts/integration-db.sh
POSTGREST_URL=http://127.0.0.1:3000 POSTGREST_JWT_SECRET=<the secret PostgREST was started with> \
  pnpm --filter @nearcited/api exec vitest run test/supabase-store.integration.test.ts
```

PostgREST must connect as `authenticator` (password `postgres`) with `anon` as its anonymous role.
The `integration` job in `.github/workflows/ci.yml` is a working example.

## Deploy

1. Create a Supabase project and apply the migrations: `pnpm dlx supabase link`, then
   `pnpm dlx supabase db push`. Both need a Supabase access token (`SUPABASE_ACCESS_TOKEN`) and
   the project's database password (`SUPABASE_DB_PASSWORD`). Under Authentication, URL
   Configuration, set the site URL to your deployed URL and add `<that URL>/**` to the redirect
   URLs, or the emailed sign-in link will not return to the app.
2. Create the queues:
   ```sh
   cd apps/api
   pnpm exec wrangler queues create nearcited-scans
   pnpm exec wrangler queues create nearcited-scans-dlq
   ```
3. In `apps/api/wrangler.jsonc`, set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `APP_URL` and
   `EMAIL_FROM`. To serve it on your own domain, set `routes` to that domain with
   `custom_domain`; the domain's DNS has to be on the same Cloudflare account. `EMAIL_FROM`
   has to be an address on a domain verified with Resend.
4. Deploy. From the repo root, with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` set in
   the environment: `pnpm cf:deploy`. It deploys the Worker, then the Pages Worker
   (`nearcited-pages`, from `apps/pages`), whose `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in
   `apps/pages/wrangler.jsonc` are set to the same project's, and which holds no secret. The
   Cloudflare API token needs permission to edit Workers and Queues.
5. Set the secrets on the Worker the deploy created, from `apps/api`:
   ```sh
   pnpm exec wrangler secret put SUPABASE_SECRET_KEY
   pnpm exec wrangler secret put RESEND_API_KEY   # optional: emailed reports and notices
   pnpm exec wrangler secret put OPENAI_API_KEY   # optional: live ChatGPT checks
   pnpm exec wrangler secret put ANTHROPIC_API_KEY   # optional: live Claude checks and drafts
   pnpm exec wrangler secret put STRIPE_SECRET_KEY   # optional: subscriptions, with the next
   pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET
   pnpm exec wrangler secret put CLOUDFLARE_HOSTNAMES_TOKEN   # optional: answer subdomains; may create and remove custom hostnames on the zone only
   pnpm exec wrangler secret put CONNECTIONS_KEY   # optional: connecting accounts; `openssl rand -base64 32` makes one
   ```
   Until `SUPABASE_SECRET_KEY` is set, the app serves and sign-in works, but no scan can run.
   Without `CONNECTIONS_KEY` nothing can be connected. Without `CLOUDFLARE_HOSTNAMES_TOKEN`, no
   answer subdomain is offered on real data. Changing it later makes every sign-in
   already kept unreadable, so keep a copy of the value.

Hosted pages need one more step, once, after a deploy that includes the Pages Worker:
`scripts/hosted-pages-setup.sh`, a wizard that you run and that walks you through the Cloudflare
dashboard. It adds the fallback origin record, turns on custom hostnames (Cloudflare for SaaS), adds
the wildcard record owners' records point at, adds a route with no Worker on `nearcited.com/*` and a
route on `*/*` for `nearcited-pages`, in that order, and makes the API token for
`CLOUDFLARE_HOSTNAMES_TOKEN` and sets it on the Worker. The Pages Worker's deploy makes no routes,
so deploying it changes no traffic until the setup is done.

`.github/workflows/deploy.yml` does step 4 on demand. It reads its credentials from the 1Password
`Nearcited` vault at run time, so GitHub holds one secret, `OP_SERVICE_ACCOUNT_TOKEN`, for a
service account that can read only that vault. The vault items it expects are named at the top
of that file.

The same workflow can smoke-test what it deployed. To set that up: add a 1Password item `Smoke test`
to the vault with the test account's `username` (an email) and `password`; run
`pnpm test-account:create` with `SUPABASE_SECRET_KEY`, `TEST_ACCOUNT_EMAIL` and
`TEST_ACCOUNT_PASSWORD` in the environment; then set the repository variable `SMOKE_TEST` to `on`.

`PROVIDER_MODE` in `apps/api/wrangler.jsonc` is `live`, so the deployed Worker runs real checks.
Exactly `mock` serves generated data instead, which is what `.dev.vars.example` sets for local
development. Any other value means live. A live build needs the private
tuning file, so the deploy has to run where `private/` is checked out, which the workflow does.
Without the file, live scans fail with a message saying so. With it, a live scan checks each
surface whose key is set (ChatGPT with `OPENAI_API_KEY`, Claude with `ANTHROPIC_API_KEY`) and skips the rest; with
no key set at all, scans fail with "No data provider is configured". A draft is another matter:
Claude writes it, so it needs `ANTHROPIC_API_KEY` and, in the private tuning, instructions for its
kind. Without either, on a live deployment, no task is offered a draft and asking for one by hand
answers 503 `drafts_unavailable`, except for a test organization, whose drafts are sample text.

## Repository automation

- **CI** (`.github/workflows/ci.yml`) runs on every pull request and on `main`. Its four jobs are
  the required checks: `Lint, typecheck, test, build`, `Store against Postgres and PostgREST`,
  `Verify generated agent config`, and `End-to-end in a browser`, which runs `pnpm e2e` against a
  local Supabase stack.
- **`main` is protected by a ruleset.** Changes arrive by pull request with the required checks
  passing on an up-to-date branch and review threads resolved. Force pushes and deleting the
  branch are blocked. CodeQL alerts block the merge, and Copilot reviews each push.
- **Dependabot** (`.github/dependabot.yml`) checks npm and GitHub Actions versions every day at
  05:00 US Eastern. Minor and patch updates arrive as one pull request per ecosystem; majors
  arrive separately. Dependabot alerts and security updates are on.
- **Secret scanning with push protection** and **private vulnerability reporting** are on. See
  [SECURITY.md](SECURITY.md) for how to report a problem.
- **Deploy** (`.github/workflows/deploy.yml`) is manual. When the repository variable `SMOKE_TEST`
  is `on`, a second job, `Smoke test the deployment`, runs `pnpm smoke` against the result.

## Private companion

Some of the product is kept out of this repository: provider prompts, sampling and scoring
values, pricing, and anything about a real customer. It lives in a separate private repository
that maintainers check out at `private/`, which this repository ignores.

Nothing here needs it. A public clone installs, passes `pnpm check` and runs on sample data
without it.

The one thing the build takes from it is `private/tuning.json`: prompt wording, score weights and
the instructions a draft is written from, as data. All the code that uses those values is here,
with placeholder defaults in `packages/shared/src/tuning.ts`. Wrangler runs
`scripts/prepare-tuning.mjs` before every dev session and deploy, which bundles the private file
when it is present and the defaults when it is not. Live scans refuse to run on the defaults, so a
build without the private file cannot store placeholder results as measurements, and no draft is
written on real data from the placeholder instructions. A tuning file without the draft settings
still loads and writes none. The reasoning is in
[docs/adr/0001-private-tuning-as-data.md](docs/adr/0001-private-tuning-as-data.md).

Maintainers with access restore it with one command, which reads the repository's location from
1Password (the `op` CLI, signed in) and clones it with the GitHub CLI:

```sh
npm run bootstrap:private
npm run sync:main        # fast-forward main in both checkouts; refuses a dirty tree
```

`npm run bootstrap:private -- --url <owner/name or GitHub URL>` skips 1Password.

## Working with coding agents

The repository is set up for Claude Code and Codex.

- [`AGENTS.md`](AGENTS.md) holds the rules a change has to follow. Codex reads it directly, and
  [`CLAUDE.md`](CLAUDE.md) imports it for Claude Code.
- The agent skills are from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT; see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)) and are pinned in `skills-lock.json`. Among
  them: `/triage`, `/to-spec`, `/to-tickets`, `/implement`, `/tdd`, `/diagnosing-bugs`,
  `/code-review`, `/grill-me` and `/improve-codebase-architecture`. `/ask-matt` picks one for you.
- Four more skills are written for this repository: `/ship` checks a branch against the rules in
  `AGENTS.md`, refreshes the docs and opens the pull request; `/end-session` records what a
  session learned and cleans up; `/handoff` and `/lets-go` pass a session between machines.
- `.agents/skills/` is the installed source. `.claude/skills/` is generated from it by
  `pnpm sync:agents`, and CI fails if the two differ.
- `docs-updater` (`.claude/agents/docs-updater.md`, generated for Codex in `.codex/agents/`) keeps
  these documents true to the code. `/ship` and `/end-session` both run it.
- `docs/agents/` tells the skills where issues live (GitHub Issues and a project board), which
  triage labels to use, and where the glossary and decision records go.

To add or update a skill:

```sh
npx skills add mattpocock/skills -a codex -s <name> --copy -y   # or: npx skills update -p -y
pnpm sync:agents
```

## What is not built

- **Most real data providers.** ChatGPT and Claude are implemented (`chatgpt.ts` and
  `claude.ts` in `apps/api/src/providers/`). Perplexity, Gemini and the three Google surfaces
  are not;
  `apps/api/src/providers/live.ts` has notes on what each needs.
- **Closing an account.** An owner can cancel a subscription on Stripe's pages, which puts the
  organization back on the free plan. There is no way for an owner to delete the organization
  ([#104](https://github.com/jwh3times/Nearcited/issues/104)).
- **Inviting teammates.** The schema and policies support members and roles; there is no API or
  screen for it.
- **Switching organizations.** A user in several organizations always sees the first.
- **Most kinds of allowance.** A plan and an organization carry allowances, and the operator can set
  them, and the database counts use of one against its number. Four kinds exist, `drafts`,
  `visits`, `wordpress` and `hosted_pages`. Every paid plan includes `drafts` and `visits`, Pro and Enterprise
  include `wordpress` and `hosted_pages`, and the free plan none; `drafts` is counted, and the others are included or
  not and have no number. The `wordpress` and `hosted_pages` kinds of connection name an allowance, and no kind of
  action does, so nothing else is held to one
  ([#133](https://github.com/jwh3times/Nearcited/issues/133)).
- **Visits beyond the last 30 days.** The card shows the last 30 days of the visits a site reported.
  Older counts are kept and shown nowhere, and a day is a day in UTC, since a location holds no time
  zone. How the line's reading is limited (the builders' menus, what each assistant sends) is in
  the known gaps of [docs/architecture.md](docs/architecture.md).
- **Most kinds of draft.** There are three: the note to the author of a page, the description for
  a listing, and the copy for a page on the business's own site. The product publishes that page only on a
  connected WordPress site, on approval; elsewhere the owner does it and says where it is. A task about asking
  customers for reviews has no draft, since the product writes nothing to a business's customers.
  A real draft needs instructions for its kind in the private tuning, so a deployment writes none
  on real data until it has them, and one that has them for a note and not for a listing writes
  only notes and offers no task a listing's description; without them only sample text is written,
  for a deployment in mock mode and a test organization.
- **A review-form link on every review site.** A task about asking customers for reviews links
  straight to the review form on bbb.org and trustpilot.com, the two sites whose form address was
  read on their own pages. On the other review sites it links to the listing. On Google it gives the
  review link the owner pasted from Google's own steps; no page of Google's that could be read says
  how its form's address is made from a place ID, so none is built from the one a location holds.
  Nothing looks for a listing or a review link or opens one, so an address is only checked for its
  form, and Google's help does not show what its link looks like, so what is taken for one is where
  accounts of it put it.
- **Who fetched a hosted page, beyond a user agent.** Fetches are counted by the word a fetcher's
  user agent carries, for ten known fetchers, and the page task shows the last 30 days. A fetcher that
  names itself otherwise, or not at all, is not counted, and one that is not who it says is.
- **Anything that works from a connection.** An owner or admin can connect a sample account or a
  location's WordPress site, or set up an answer subdomain, and remove any of them. Beyond the WordPress site itself (its one
  choice) and the front page it reads before proposing, nothing reads anything from an account. A
  page task's copy is also published on an answer subdomain. The
  things published to a WordPress site are the business details block on a home page that is a
  page and a page task's copy as a new page; the owner still puts anything else on their site
  themselves. There is no other real kind
  of connection (a Google profile, a customer source). The other thing done through a connection is
  the sample kind of action, which sets the opening line of a made-up listing. The sample kind never fails and needs no allowance;
  a WordPress connection breaks when the site refuses its password and pauses when a plan stops
  including it. Signing in
  again to a connection that refused its sign-in, without removing it, is not built: it is removed
  and connected again.
- **Most real kinds of action.** Three are built: the business details on a WordPress home page, a
  page task's copy published as a new page there, and the same copy served on an answer subdomain
  ([ADR 0014](docs/adr/0014-only-the-worker-carries-out-an-action.md) and
  [ADR 0018](docs/adr/0018-on-a-business-site-the-product-changes-only-what-it-made.md)). All take
  from an allowance that counts nothing, and nothing limits how long what they replaced is kept.
  A page is not proposed where a page already sits at the address its title makes, and one
  that is taken back goes to WordPress's trash. A site whose front page shows the latest posts is offered nothing, and a page builder or caching
  plugin may keep the block from showing. The sample kind is given 30 days to keep what it
  replaced, so that dropping can be seen, and does no task's work.
- **A comparison of the structured details with what is on file.** The on-page check passes for a
  JSON-LD block that names this business and gives an address. What else the block says, such as a
  phone number or street address, is not compared with what is on file, so one that differs
  passes. Opening hours are not held, so the block has none.
- **An alert about a wrong address.** A drop, a business named for the first time, a site read for
  the first time and a phone number the answers give that is not the location's are built, shown
  on the Overview tab, counted on the locations table and emailed to the owners in the scan
  report. The address an answer gives is not compared, and there is no plan to: an answer gives
  part of one, abbreviated differently each time.

More detail, and the open product questions, in [docs/architecture.md](docs/architecture.md).
What is planned, in order, is in [Build order](https://github.com/jwh3times/Nearcited/issues/15).

## Contributing and security

Issues are welcome; outside pull requests are not being accepted yet. See
[CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately, as described in
[SECURITY.md](SECURITY.md).

## License

Copyright (C) 2026 Jerry Holland.

Nearcited is free software: you may use, modify and share it under the terms of the
[GNU Affero General Public License, version 3](LICENSE). If you let other people use a modified
version over a network, that license requires you to offer them its source. It comes with no
warranty.

The packages the web app is built from keep their own licences, which ask that their notice go
wherever a copy does. So the web build writes `third-party-licenses.md` into `apps/web/dist`, with
one section for each package the bundle includes: its name, version, licence identifier and the
licence's text. The Worker serves it with the rest of the build, at `/third-party-licenses.md` and
without signing in, and a comment in the app's `index.html` says where it is. The build also keeps,
in the bundled JavaScript, the short licence notices those packages carry in their own code, which
a minified build would otherwise drop; some name code inside a package that its licence file does
not. Both cover the web app's bundle, which is what a browser is sent, and not the Worker's own
packages, which run on the server.
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) covers the files kept in this repository under
their own licence.
