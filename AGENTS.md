# Nearcited

The engineering contract for every coding agent in this repository. `CLAUDE.md` imports this file;
Codex reads it directly. Project rules live here and nowhere else.

Local-visibility tracker: two Cloudflare Workers, the main one (Hono API, cron, queue consumer)
with the React app it serves as static assets and the Pages Worker (`apps/pages`) that serves
hosted pages on businesses' answer subdomains, and Supabase for Postgres and auth. Read
`docs/architecture.md` before changing how scans run or how data is accessed.

## Commands

- `pnpm check`: lint, typecheck, test, build. Must pass before a change is done.
- `pnpm format`: apply Biome fixes.
- `pnpm --filter @nearcited/<api|web|shared|pages|db> test`: one package's tests.
- `pnpm dev`: Worker on 8787, Vite on 5173.
- `pnpm e2e`: browser tests; needs `supabase start` and the env files. `pnpm check` skips them.
- `pnpm smoke`: the smoke test against a deployment; needs `E2E_*` and `TEST_ACCOUNT_*` set.
- `pnpm billing:check`: ask Stripe and the deployment whether billing is set up as the app
  expects. Reads only; needs `STRIPE_SECRET_KEY` and `SUPABASE_SECRET_KEY` in the environment.
- `pnpm test-account:create`: make the deployment's test account (needs the Supabase secret key).
- `pnpm local:env`: write `apps/api/.dev.vars`, `apps/web/.env.local` and `apps/pages/.dev.vars`
  from `supabase status`.
- `npm run bootstrap:private`: clone the private companion into `private/` (maintainers only).
- `npm run sync:main`: fast-forward `main` here and in `private/`. Refuses a dirty tree.
- `pnpm sync:agents`: regenerate `.claude/skills` and `.codex/agents` after changing anything in
  `.agents/skills` or `.claude/agents`.

## Private companion

`private/` is gitignored here and is a separate, confidential repository for authorized
maintainers. A public clone does not have it, and everything in this repository must install,
pass `pnpm check` and run in mock mode without it.

- **What lives there:** provider prompt text, sampling and score weights; pricing, vendor quotes
  and what anything the product does was measured to cost; anything naming a real customer or
  prospect; security review findings; deployment runbooks. `private/README.md` is its index and
  says what each file owns. Read it before working there.
- **A provider's published rate is public; what was measured is not.** A document here may quote
  what a vendor charges for a model or a search. It never says what a check, a draft or any other
  piece of work was measured to use or to cost, or how models and settings compared on cost, and
  a recorded response in a test carries made-up usage numbers, not the call's own.
- **Nothing from `private/` is copied into this repository**, including into issues, pull
  requests, commit messages and docs. A public document may say a private one exists.
- **This repository never names the private one.** Its locator lives in 1Password and
  `scripts/bootstrap-private.mjs` reads it at run time. Keep it out of every tracked file.
- **Commit and push the two repositories independently.**
- If `private/` is absent and the task needs it (writing a provider's prompts, pricing a plan),
  stop and ask the user to run `npm run bootstrap:private`.
- **The only thing the build takes from it is `private/tuning.json`**, a data file of prompt
  wording and score weights (`docs/adr/0001-private-tuning-as-data.md`). All code stays here.
  No source file imports from `private/`.

## Rules

- **Row-level security is the authorization layer.** Request handlers use the store from
  `c.get("store")`, which acts as the signed-in user. Never call `createAdminClient` on a request
  path; it bypasses the policies. The one exception is the payment provider's webhook, on the
  terms in `docs/adr/0007-the-payment-webhook-acts-as-the-worker.md`: do not add a second.
- **A subscription changes a plan only through the webhook.** Checkout and the account pages are
  the provider's. An owner's request may start a checkout, or change the subscription at the
  provider (an upgrade now, a downgrade at the end of the paid period), and writes nothing here.
  The webhook verifies the signature, reads the subscription back from the provider and calls
  `applyPlan`. `subscriptions` has no write path from a request, and whether a change is an
  upgrade is worked out on the server from the prices, never taken from the request.
- **A subscriber's price goes up only after they were told.** Setting a plan's price changes it
  for new subscribers; current ones keep the price version they joined at until an announced
  change moves them (`docs/adr/0008-a-price-change-reaches-subscribers-by-announcement.md`).
  `runPriceChangeStep` moves a subscription to a higher price only when its owners were sent the
  announcement at least thirty days before, checked per organization. Do not add another path
  that changes what a running subscription is billed, and never edit a price in place. The two
  that stronger models add are the only exceptions, and neither bills more
  (`docs/adr/0021-a-stronger-model-is-a-line-of-the-plans-price.md`): a switch of assistant moves
  a stronger line to the new one for the same price (`followAssistantSwitch`), and the day a
  reduction takes stronger models off a plan takes the lines off without charging
  (`fitSubscription`).
- **What a paying subscriber gets goes down only after they were told.** On a plan with
  subscribers a lower limit, or an allowance taken away or made smaller, is announced for a day
  at least thirty days out and made on that day by `apply_limit_change()`, which only the worker
  calls (`docs/adr/0009-a-reduction-is-announced-like-a-price-rise.md`). `operator_set_plan()`
  refuses to lower anything there on the spot. Raising a limit, and anything on a plan nobody
  pays for, still happens at once. Do not add a path that lowers a paid plan's limits or
  allowances without the announcement.
- **The operator can read every row** (`docs/adr/0004-the-operator-reads-through-policies.md`), so
  a query must filter by what it means, never by what the caller happens to see. "This user's
  organizations" is `my_organizations()`, not `select` from `organizations`. The operator gets
  `select` policies only: do not add one that writes. What the operator changes goes through a
  function that answers only the operator, changes only what it names and records the change in
  `operator_actions` (`docs/adr/0005-the-operator-changes-limits-through-one-function.md`).
- **New table: policies, explicit grants and a non-member test in `packages/db`, in the same
  change.** Supabase grants everything in `public` to every API role by default, so a table
  without a `revoke` is open.
- **Migrations are append-only.** Add a new file in `supabase/migrations`; do not edit one that
  has been applied anywhere.
- **A migration leaves the running Worker working.** It is applied before the deploy, so the
  Worker from before it must still work against the database after it. Add a new column first
  and drop the old one later, once no deployed code reads it. A change that drops something its
  own code has just stopped using says in the pull request that it is deployed first and
  migrated second.
- **An organization's limits come from its plan.** `apply_plan()`, which only the worker calls,
  copies them from the plan, and the operator's limits editor changes them through its function.
  Nothing on a request path writes a limit, `allowances`, `plan_key`, `paused_by_plan`,
  `set_aside_by_plan` or `stronger_surfaces`. An account has one organization:
  `create_organization()` refuses a second.
- **A stronger model is a line of the subscription, and the tier is kept on each result.** An
  owner's request changes what the subscription pays for at the provider and writes nothing here;
  the webhook reads it back and `apply_plan()` sets which assistants are on Stronger, none on a plan
  without the `stronger_models` allowance
  (`docs/adr/0021-a-stronger-model-is-a-line-of-the-plans-price.md`). Its price is part of the
  plan's price version, one amount for each location paid for with a provider price of its own for
  each assistant, so it rises only by an announced price change, and each stronger line counts the
  locations paid for and moves with them
  (`docs/adr/0022-a-stronger-model-is-charged-for-each-location.md`). Which model Stronger is lives
  in the tuning's `stronger` blocks, and an assistant with none is sold none. A result and a drop
  keep the tier they were asked on, and a tier is part of the cell for the score and the alerts
  alike (`cellKey`, `packages/shared/src/scoring.ts`): keep the two agreeing. A test organization is
  always Standard.
- **A kind of work a plan includes is an allowance, not a new column.** It is one row in
  `allowance_kinds` and one entry in `ALLOWANCE_KINDS` (`packages/shared/src/allowances.ts`), added
  in the same change (`docs/adr/0012-a-plans-allowances-are-one-set.md`). A form shows and sends
  only the kinds its build knows, and the API puts back the ones it does not: keep that, or the
  Worker running while a migration adds a kind will drop it. A kind of connection that needs an
  allowance names it in `connection_kind_allowances` and `CONNECTION_KIND_ALLOWANCES`
  (`packages/shared/src/schemas.ts`), added in the same change.
- **A connection's sign-in is sealed by the Worker and read only by the worker.** It is sealed
  before it is stored (`apps/api/src/connections/seal.ts`) and kept in `connection_secrets`, which
  no API role reads (`docs/adr/0013-a-sign-in-is-sealed-by-the-worker.md`). A request may write
  one, through `create_connection()`, and never reads one: whatever needs the sign-in runs from
  the queue, and no route or wire type carries it, sealed or not. Do not add a policy or a grant
  on `connection_secrets`, and do not read it anywhere but `getConnectionSecret`, which only the
  worker calls. A WordPress site's application password is sent only over https to that site's
  own host, and never on through a redirect (`signedIn`, `apps/api/src/connections/wordpress.ts`):
  keep both. `WORDPRESS_LOCAL_ORIGIN` lifts them for one origin on a developer's own machine and
  is never set on a deployment. An answer subdomain has no sign-in: its owner's DNS record is the
  say-so, and it points at a target of that connection's own, so the worker registers a name to
  be served only once its record points at that target (`checkAnswerSubdomain`,
  `apps/api/src/connections/index.ts`). Keep that, or an account that made the subdomain first
  could put its pages on someone else's domain, and keep a name held by one connection at a time.
- **Only the worker proposes an action, and only the worker carries one out.** A request records a
  member's yes or no (`approve_action()`, `decline_action()`, `retry_action()`) and queues the
  worker (`docs/adr/0014-only-the-worker-carries-out-an-action.md`). `carryOutAction`
  (`apps/api/src/actions/index.ts`) reads what is there before it writes: already as the action
  would make it is done, and no longer what the member was shown is out of date, and neither
  writes. Do not carry an action out on a request path, do not write through a connection
  anywhere else, and keep the read before the write. An organization's owners are told of every
  action within 48 hours: `claim_action()` refuses an organization one of whose actions has gone
  36 hours untold, and a yes is refused where no notice could be sent (`requireNotice`). Keep
  both, and mark an action told only when the email went, for a test organization, or on sample
  data with no email to send with. A kind of action has a row in `action_kind_terms`: the
  allowance it takes from, and how many days what it replaced may be kept. `claim_action()` takes
  from the month and `finish_action()` gives it back when the thing was not done and marks the
  task the action did: count an action nowhere else, and add no path by which a member clears a
  task an action marked, but taking that action back. What an action read from outside is kept in `seen` and nowhere else, so
  that `drop_expired_seen()` can drop it on its day. On a business's own site an action adds or
  changes only what the product made, marked as its own, and compares only that part before it
  writes (`docs/adr/0018-on-a-business-site-the-product-changes-only-what-it-made.md`): never
  edit the owner's text, menus, themes or plugins. A change composed by rule is approved as it
  is (`EDITABLE_ACTION_KINDS`). Taking back is a new action made only by `take_back_action()`,
  which a member asks for, and it removes only what the action put there. Standing permission is
  a yes given in advance, and only `propose_action()` applies it, as an action is made;
  `claim_action()` checks it again and puts back to waiting what it no longer covers
  (`docs/adr/0025-standing-permission-is-checked-where-an-action-is-approved-and-carried-out.md`).
  It is given and ended only through `give_standing_permission()` and
  `end_standing_permission()`, which answer an owner or admin and no one else, the operator
  included, and it ends at a take-back of something done under it and when the plan stops
  including it. Keep both checks, never apply it to an action that `always_asks`, and add no
  other path that approves an action without a member.
- **Only the worker raises or clears an alert, and an alert is kept, not worked out again.**
  `complete_scan()` writes the alerts a scan raises and clears (`deriveAlerts`,
  `packages/shared/src/alerts.ts`). A request only dismisses one, through `dismiss_alert()`, which
  answers a member of the location's organization and no one else, the operator included
  (`docs/adr/0015-an-alert-is-kept-not-worked-out-again.md`). What raises an alert and what clears
  it are separate conditions: never clear a drop because its rule stopped firing over the window,
  and never by age. A first sighting is news, not a state: it is cleared as `old_news` when the
  scan that raised it leaves the window, and by nothing else. "For the first time" is said of the
  whole record, read through `listSeenBefore` (`seen_before()`, worker only), never of the window
  alone, and only written answers count. A phone number the answers give is read in
  `analyzeObservation`, never by a provider, and kept on the result (`scan_results.phones`), since
  a scan keeps only an excerpt of an answer; it is counted over the window, and a dismissed phone
  alert is never cleared, so that number is not raised again. A dismissed alert stays current
  until the worker clears it, so the same thing is not raised twice. An alert is composed by rule
  from the facts on its row, says what was seen and never what to do, and no model writes one. An
  alert is told to the owners once, in the report a scheduled scan emails, and marked told
  (`markAlertsTold`) only when the report went to someone: one that failed, or had nobody to go
  to, leaves it for the next. Nothing on a request path writes `told_at` or `cleared_told_at`.
- **Only the worker writes a draft, and a draft states nothing nobody gave.** A request records a
  member's ask (`ask_draft()`, which answers a member of the location's organization and no one
  else, the operator included) and queues the worker
  (`docs/adr/0016-the-worker-writes-a-draft.md`). `writeDraft` (`apps/api/src/drafts/index.ts`)
  reads the task, the page and the location off what is on file, so nothing a request said
  decides what a draft is written from. That is `DraftGiven` (`packages/shared/src/drafts.ts`) and
  nothing else: do not give a writer anything from the answers, or anything about the business a
  location does not hold. Every draft passes `factsNobodyGave` before it is kept, whatever wrote
  it, and one that fails twice is not kept. A writer only writes: it returns text, reports what
  each call used, and decides nothing. It is given no tools. A real draft is written only where
  the private tuning has instructions for its kind (`liveDraftKinds`, `apps/api/src/drafts/claude.ts`):
  the default tuning's are a placeholder, as its prompts are, so keep that too. What the writing
  used is recorded after every write (`recordUsage`, for the organization and no surface), kept
  or not. `claim_draft()` takes from the month and `finish_draft()` gives it back when nothing
  was written: count a draft nowhere else. Sample text is kept as `sample_data`, names no model
  and is never called a model's. Nothing on a request path writes `drafts`, and a draft is not
  written by opening a page.
- **A visit is counted for whoever holds the site's key, and nothing rests on the count.** The
  line on a business's site reports a visit with no sign-in, and `record_visit()` is the only
  thing that counts one
  (`docs/adr/0017-a-visit-is-counted-for-whoever-holds-the-site-key.md`). The key is in the
  site's source, so the function trusts nothing it is told: the day is its own, the page must be
  on the location's own website, and a location counts a bounded number of visits a day under a
  bounded number of pages. Keep those bounds inside the function, since anyone can call it. The
  route works out the assistant from what the visit carried (`assistantOf`,
  `packages/shared/src/visits.ts`), takes the site from where the browser says the post came
  from, and answers the same whatever became of the visit. Nothing is kept about a visitor: a
  count for a day, a location, an assistant and a page, and never a row for a visit, a time of
  day or an address. The line (`apps/web/public/line.js`) sends nothing for a visit that did not
  come from an assistant, sets no cookie and keeps nothing in the browser: keep all three. Its
  list of assistants is a copy of the shared one, and the database names them too
  (`visits.assistant`): add one in all three. The count can be padded by anyone who reads the
  key, so no score, alert, task or bill is worked out from it. Do not open `visits` or
  `visit_lines` to a caller who is not signed in, and do not count a visit on any other path. A
  key is replaced only by `replace_site_key()`, which answers an owner or an admin of the
  location's organization and no one else, the operator included: the old key then belongs to
  nobody and what was counted stays. Do not add another path that changes a key.
- **The Pages Worker serves hosted pages and nothing else, and holds no secret.** It reads only
  through `hosted_page()`, which anyone may call with the publishable key and which answers only
  for a live answer subdomain, with only what the page shows anyway, and writes only a count
  through `record_page_fetch()`, which anyone may call too and which trusts nothing it is told:
  the day is its own, the page must be live and the fetcher a known one, and a day's count stops
  at a ceiling (`docs/adr/0019-hosted-pages-are-served-by-a-worker-of-their-own.md`). Do not give
  it the secret key, another table, another write, or anything of the app; do not serve hosted
  pages from the main Worker. Nothing is kept about a fetch but that count, for a day, a page and
  a fetcher, and nothing is worked out from it: anyone can claim to be a fetcher. Its list of
  fetchers (`PAGE_FETCHERS`), the check on `hosted_page_fetches.fetcher` and the one in
  `record_page_fetch()` name the same ones: add one in all three. It hands on any request for a
  name of the zone's own (`nearcited.com` and its subdomains) untouched. A hosted page is plain HTML: no script but the structured details, no
  cookie, image or tracking, every word written as text, and nothing of Nearcited's but a
  generator tag. Keep all of that.
- **Only the worker closes an account.** A request records an owner's ask through
  `request_closing()`, which answers an owner of the organization and no one else, refuses the
  operator, a test account and a name that is not the organization's, and queues the worker
  (`docs/adr/0020-the-worker-closes-an-account.md`). `closeAccount` (`apps/api/src/closing.ts`)
  cancels the subscription, removes every connection the way an owner's removal does, deletes the
  organization, then the owner's sign-in, then sends one email, writing each step on the closing's
  record so a retry carries on. Do not delete an organization or a sign-in anywhere else. From the
  ask the organization is out of its members' reach and the worker's schedule: keep that in the
  helpers every policy reads. `closings` is read by no API role, keeps the addresses only until
  the email has gone, and keeps the fingerprint of the owner's email only thirty days, which
  `create_organization()` checks so that closing is not a way to a second free first scan.
  Everything an organization holds is downloaded only through `export_organization()`, which
  answers only an owner, and never holds a sign-in, the operator's record of changes or what the
  providers were paid.
- **`packages/shared/src/schemas.ts` defines every wire type.** Change the schema first, then the
  API and the client. Field names stay snake_case end to end.
- **All database access goes through the `Store` interface** (`apps/api/src/store/types.ts`). A
  new method needs the Supabase implementation, the in-memory one in `apps/api/test`, and a line in
  the integration test. The Pages Worker's two calls, to `hosted_page()` and
  `record_page_fetch()`, are the only access outside it.
- **A list that reaches across organizations is read a page at a time.** The database's API
  answers a request with at most 1,000 rows and says nothing when it leaves the rest out, so a
  list read in one request is right until it is long and then short without an error. In the
  Supabase store such a read goes through `every` (`readEvery`, `apps/api/src/store/paging.ts`),
  asked for in an order no two rows share, and oldest first where the rows have a time they were
  made, so a row made meanwhile lands past the end. A list that belongs to one organization
  or one location is bounded by its plan and needs none, except a location's visits, which no plan
  bounds: they are read added up, by `location_visits()`, and never row by row. A work list the
  schedule reads again at its next run, and takes only the first of, may stay as it is.
- **Providers only fetch.** They return an `Observation`; `analyzeObservation` in the shared
  package decides what it means. Do not put matching logic in a provider. That holds for a Google
  check (`apps/api/src/providers/dataforseo.ts`) as for an assistant's.
- **Only the worker writes a location's point, and Google is checked only where a plan allows
  it.** `latitude`, `longitude`, `point_source` and `geocoded_from` are written by the worker
  alone, through `setLocationPoint` after the scan runner looks the address up
  (`docs/adr/0023-google-results-are-bought-and-checked-from-one-point.md`); the
  `guard_location_point` trigger keeps them as they were for any other writer. Nothing on a
  request path writes them, and nothing a request sends decides where a check is made from. A scan
  checks the Google surfaces only where an organization's allowances include `google_results`
  (`coveredSurfaces`, `packages/shared/src/google.ts`), never because `surfaces` names them, and
  only when `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` and `MAPBOX_TOKEN` are all set. A location
  that cannot be placed is not checked on Google. Keep all three. A Google search that showed
  nothing is kept as such (`scan_results.shown`), decided in `analyzeObservation` and never by a
  provider, and counts nowhere: whatever counts checks asks `isCounted`, so it raises, counts
  toward and clears nothing
  (`docs/adr/0024-a-search-that-showed-nothing-is-kept-and-not-counted.md`).
- **NearcitedBot obeys robots.txt, and reads only pages an answer cited.** Every page it reads,
  through `apps/api/src/site/fetch.ts`, is asked for only after that host's `robots.txt`, read as
  RFC 9309 says (`robotsAllows`, `packages/shared/src/robots.ts`): the group naming `NearcitedBot`,
  else `*`, except on a location's own site, where only a group naming it counts (an audit's site is
  read as anyone else's); a `robots.txt` that faults or does not answer shuts everything
  (`docs/adr/0027-nearcitedbot-obeys-robots-txt-and-reads-only-pages-an-answer-cited.md`). Besides
  the business's own home page, it reads only the cited-page check's pages: for up to three open
  directory tasks no member dismissed, the page the answers cited most for the site
  (`citedPagesToRead`), once a scan, within `CITED_PAGE_REQUESTS`, never off the task's site, and
  never on sample data, for a test organization or for an audit. What it found is kept on the scan
  (`scans.cited_pages`), composed by rule, never the page, and only the phone is ever called
  different. Do not add another page NearcitedBot reads, a read that skips `robots.txt`, or a
  retry of a cited page.
- **Structured details carry only what a location holds.** A detail not on file is left out, never
  filled in, and no model writes any of it (`packages/shared/src/structured-details.ts`).
- **Tuning is data, and its real values are private.** A new prompt, weight or sampling value
  starts as a field and a placeholder default in `TuningSchema` (`packages/shared/src/tuning.ts`);
  the real value goes in `private/tuning.json`. Code takes the tuning as an argument. Only the
  Worker entry point imports `apps/api/src/tuning.ts`, and the web app imports nothing from the
  tuning module but types, because its bundle is public.
- **Mock data must never pass as real.** `PROVIDER_MODE` is mock only when it is exactly `"mock"`,
  and the UI shows a banner while it is. Keep both. For the same reason live scans refuse to run on
  the default tuning (`liveScansUnavailable`); keep that too. A test organization's scans are
  generated in any deployment (`docs/adr/0003-platform-roles-and-test-accounts.md`): they are
  recorded as `sample_data` and shown under the same banner, so code that asks "is this sample
  data?" asks about the organization as well as the deployment.
- **Platform roles are set only with the secret key.** `platform_roles` and
  `organizations.is_test` have no write path from a request. Do not add one.
- **A person joins an organization only by accepting an invitation to their own address, and an
  organization always keeps an owner.** No API role writes `memberships`: `create_organization()`
  adds its maker, `accept_invitation()` adds the person signed in with the address an owner
  invited, and `change_member_role()`, `remove_member()` and `leave_organization()` change or
  remove one, each refusing a change that would leave no owner
  (`docs/adr/0026-a-person-joins-an-organization-only-by-accepting-an-invitation.md`). Invitations
  are written only by `invite_member()`, `send_invitation_again()` and `cancel_invitation()`, which
  answer an owner and no one else, the operator included; at most twenty wait at once, and one is
  sent at most once an hour. Accepting is refused while the person belongs to another
  organization, and to the operator and a test account. The invitation's email is sent by the request, and never for a test organization.
  Do not add a policy or grant that writes `memberships` or `invitations`, a link that joins by
  itself, or another way into an organization.
- **The code is AGPL-3.0-only and the repo is public.** A new dependency must be under a license
  that can be combined with it; MIT, ISC, BSD, Apache-2.0 and MPL-2.0 are fine, anything else
  needs checking first. Outside pull requests are not merged (see `CONTRIBUTING.md`).
- No secrets in the repo. Local values go in `apps/api/.dev.vars` and `apps/web/.env.local`, both
  gitignored.

## Agent skills

The skills come from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, see
`THIRD_PARTY_NOTICES.md`) and are pinned in `skills-lock.json`.

- **`.agents/skills/` is the source.** The skills installer writes there and Codex reads it.
  `.claude/skills/` is a generated copy for Claude Code; each generated `SKILL.md` says so on its
  second line. Never edit `.claude/skills/` by hand.
- **After installing, updating or editing a skill, run `pnpm sync:agents` and commit the result.**
  CI runs `pnpm sync:agents:check` and fails if the copy is stale.
- **Install or update with the installer**, so the lock file stays right:
  `npx skills add mattpocock/skills -a codex -s <name> --copy -y`, or `npx skills update -p -y`.
- **Four skills are this repository's own** and are not in the lock file: `ship` (rule check, doc
  refresh, `pnpm check`, PR), `end-session` (record what a session learned, then clean up),
  and `handoff` with `lets-go` (pass a session to another machine through the Proton Drive
  Handoffs folder). Edit them in `.agents/skills/`. When a project rule, a required check or a
  document's job changes, update `ship` to match.
- `scripts/sync-agents.mjs` and its test are shared verbatim with other repositories. Do not edit
  them here.
- **Agents run the other way: `.claude/agents/*.md` is the source** and `.codex/agents/*.toml` is
  generated by the same sync. There is one, `docs-updater`, which holds the table of which
  document owns which fact. Run it, or read its file and follow it, whenever a change touches a
  route, table, environment variable, command, scan behaviour, CI check or project rule. `/ship`
  and `/end-session` both call it.

### Issue tracker

Issues live in GitHub Issues, through the `gh` CLI: public work in `jwh3times/Nearcited`,
confidential work in the private companion's tracker. Every open issue from both is on the
Nearcited project board (project 10), whose `Stage` and `Gate` fields carry the sequencing. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five default labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
`wontfix`), all of which exist in the tracker. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `docs/adr/` at the repo root holds the decision records and one `GLOSSARY.md`
at the root holds the settled terms. See `docs/agents/domain.md`.
