---
name: ship
description: Ship the current branch — check it against the project rules, refresh the docs it made stale, run pnpm check, push, and open or update the PR. Use when a feature branch is ready for review, or when the user says "ship it", "open a PR", or "push this".
---

# Ship

Take the current branch from "code is done" to "PR is open with every required
check able to pass".

**Announce at start:** "I'm using the ship skill to open a PR for this branch."

`main` accepts changes only by pull request, on a branch that is up to date with
it, with four checks green: `Lint, typecheck, test, build`,
`Store against Postgres and PostgREST`, `Verify generated agent config`, and
`End-to-end in a browser`. This
repository has no version file and no changelog; the PR body is the record of the
change.

## Steps

### 1. Preconditions: stop if any fail

- **On a branch.** If on `main`, stop and offer to create one
  (`git switch -c <topic>`).
- **Clean working tree.** `git status --porcelain`. If anything is uncommitted,
  stop and ask the user whether to commit it.
- **`gh` authenticated.** `gh auth status` succeeds.
- **Up to date with `main`.** `git fetch origin`, then
  `git merge-base --is-ancestor origin/main HEAD`. If it fails, merge or rebase
  `origin/main` now: the ruleset refuses to merge a branch that is behind, and
  conflicts are cheaper before the docs pass than after.

### 2. Review the diff against the rules

Read the whole branch diff, since commit messages leave things out:

```bash
base=$(git merge-base origin/main HEAD)
git diff --stat "$base"..HEAD
git diff "$base"..HEAD
```

`AGENTS.md` holds the rules. Walk the diff once for each trigger below and fix
what is missing, or stop and tell the user when the fix is a design decision.

| The diff…                               | Must also contain                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| touches `supabase/migrations/`          | Only **new** files; an edit to a migration already on `main` is a stop. A new table has policies, a `revoke`, explicit grants, and a non-member test in `packages/db/test/rls.test.ts`. The Worker deployed before the migration still works after it. Where the migration drops or renames something that Worker uses, the PR body says to deploy first and migrate second.                |
| writes a limit, `allowances`, `plan_key`, `paused_by_plan` or `set_aside_by_plan` | Only through `apply_plan()` (worker only) or the operator's function. No request path writes them, and nothing gives an account a second organization. |
| touches connections, `connection_secrets` or `apps/api/src/connections/` | A sign-in sealed before it is stored, and read only by the worker: no policy or grant on `connection_secrets`, no read of it but `getConnectionSecret`, and no route, wire type or log line that carries a sign-in, sealed or not. Whatever needs the sign-in runs from the queue, not on a request. Only an owner or admin connects or removes, and a non-member test covers both tables. A WordPress site's application password is still sent only over https to that site's own host and never on through a redirect (`signedIn`), and `WORDPRESS_LOCAL_ORIGIN` is not set on a deployment. An answer subdomain is still registered to be served only once its record points at that connection's own target (`checkAnswerSubdomain`), and a name is still held by one connection at a time. |
| touches actions or `apps/api/src/actions/` | Proposing and carrying out only in the worker: no request path proposes, writes through a connection, or reads a sign-in. A request records a yes or a no through `approve_action()`, `decline_action()`, `retry_action()` or `take_back_action()`, which answer only a member of the location's organization, never the operator. Carrying out still reads what is there before it writes, and writes nothing when it is already so or has changed. Owners are still told of every action: `claim_action()` still refuses an organization held for an untold action, a yes is still refused where no notice could be sent, and an action is marked told only when the email went, the organization is a test one, or the deployment is on sample data with no email to send with. An action is counted against its allowance only in `claim_action()` and given back only in `finish_action()`, which is also the only thing that marks a task done by an action; no member path clears that mark. On a business's own site an action changes only the block the product marked as its own, compares only that block before it writes, and is approved as it is proposed unless its kind is in `EDITABLE_ACTION_KINDS`; a take-back is made only by `take_back_action()`. What an action read from outside is kept only in `seen`, which `drop_expired_seen()` drops on its day. A new kind of action has a handler in `HANDLERS`, a row in `action_kind_terms` and a non-member test. |
| touches alerts, `alerts` or `apps/api/src/routes/alerts.ts` | Raised and cleared only by the worker, through `complete_scan()`; a request only dismisses, through `dismiss_alert()`, which answers only a member of the location's organization, never the operator. What raises an alert and what clears it stay separate conditions: nothing clears a drop because its rule stopped firing over the window, or by age; a first sighting is cleared only as `old_news`, when the scan that raised it leaves the window; and a dismissed alert stays current until the worker clears it. "For the first time" is still said of the whole record, read through `listSeenBefore` (`seen_before()`, worker only), never of the window alone, and only written answers count. A phone number is read in `analyzeObservation`, never by a provider, kept on the result (`scan_results.phones`) and counted over the window, and a dismissed phone alert is never cleared. Its sentences are composed by rule from the facts on the row and say what was seen, never what to do; no model writes one. Owners are told once, in the scan report, and an alert is marked told (`markAlertsTold`) only when `notify` answered that the report went to someone; no request path writes `told_at` or `cleared_told_at`. |
| adds a kind of work a plan includes     | A row in `allowance_kinds` and an entry in `ALLOWANCE_KINDS`, in the same change, and no new column on `plans`. Taking it away from a paid plan, or lowering its number, goes through the announced reduction. The forms still send only the kinds they know, and the API still puts back the rest. A kind of connection that needs an allowance names it in `connection_kind_allowances` and `CONNECTION_KIND_ALLOWANCES`, in the same change. |
| adds or changes a payload               | The schema in `packages/shared/src/schemas.ts`, changed first, with snake_case field names, and both the API and the web client parsing through it.                                                    |
| adds a `Store` method                   | The Supabase implementation, the in-memory one in `apps/api/test/memory-store.ts`, and a line in `apps/api/test/supabase-store.integration.test.ts`. A read that reaches across organizations goes through `every` in the Supabase store (`apps/api/src/store/paging.ts`), ordered by a key no two rows share: the API answers with at most 1,000 rows and no error.                                                   |
| adds a route                            | `c.get("store")` for data access. `createAdminClient` appears only in `apps/api/src/index.ts` and in the payment provider's webhook in `apps/api/src/app.ts` (`docs/adr/0007-the-payment-webhook-acts-as-the-worker.md`); anywhere else it bypasses row-level security, so stop. A non-member request is tested and returns 404.  |
| adds or changes a provider              | A provider that returns an `Observation` and nothing else, registered only when its key is present, with recorded-response tests and no network. Matching stays in `analyzeObservation`.               |
| touches drafts, `drafts`, `apps/api/src/drafts/` or `packages/shared/src/drafts.ts` | Written only by the worker: a request records the ask through `ask_draft()`, which answers only a member of the location's organization, never the operator, and queues it. No request path writes `drafts`, takes from the month or calls a writer, and reading a page writes nothing. The worker still reads the task, the page and the location off what is on file. A writer is given the kind of draft and `DraftGiven`, and nothing else: nothing from the answers, and nothing about the business a location does not hold. Every draft still passes `factsNobodyGave` before it is kept, is written at most twice for one ask, and is not kept when it fails twice. The month is taken from only in `claim_draft()`, once for an ask, and given back only in `finish_draft()` when nothing was written. Sample text is `sample_data`, names no model, and is labelled as nobody's writing. A real draft is written only with instructions from the private tuning: `liveDraftKinds` is empty on the default tuning, the writer has no tools, and the route still refuses real data where there is no key or no instructions for the kind. What the writing used is recorded after every write, kept or not, for the organization and no surface. A new kind of draft is in `DRAFT_KINDS`, in the check on `drafts.kind`, and has sample text; its instructions are a field in `DraftsTuningSchema` with a placeholder default, and the real ones go in `private/tuning.json`. |
| touches visits, `visits`, `visit_lines`, `apps/web/public/line.js` or `packages/shared/src/visits.ts` | Counted only by `record_visit()`, which answers anyone holding the site's key and trusts nothing it is told: the day is its own, the page is on the location's own website, the plan includes visits, and the day's ceilings on visits and on pages are inside the function. The route works out the assistant with `assistantOf`, takes the site from where the browser says the post came from and never from the body, and answers the same whatever became of the visit. No row is a visit: only a count for a day, a location, an assistant and a page, with no time of day and nothing about the visitor. The line sends nothing for a visit that did not come from an assistant, never the address a visitor came from or what follows a question mark, sets no cookie and keeps nothing in the browser. Its list of assistants is the same as `ASSISTANT_REFERRERS`, and the check on `visits.assistant` names the same ones. No score, alert, task or bill is worked out from the count. `visits` and `visit_lines` have no policy or grant for a caller who is not signed in, and nothing else counts a visit. A key is replaced only by `replace_site_key()`, which answers an owner or an admin of the location's organization and no one else (the operator, a plain member and the worker get no row); the old key then counts nothing and what was counted stays. The key is shown only through `GET /api/locations/:locationId/line`, to whoever can read the location. The counts are read only added up, through `location_visits()`, which runs as the caller and is not granted to `anon`; nothing generated is shown as a count, on sample data or for a test organization. What the line collects is in the privacy policy. |
| touches closing or exporting an account, `closings`, `request_closing()`, `export_organization()` or `apps/api/src/closing.ts` | Closed only by the worker: a request records the ask through `request_closing()`, which answers only an owner of the organization and refuses the operator, a test account, a test organization and a name that is not the organization's, and queues it. No request path deletes an organization or a sign-in. The worker still cancels the subscription, removes each connection the way an owner's removal does (waiting for Cloudflare to let a subdomain go, not for a WordPress site), deletes the organization, then the sign-in, then sends one email, writing each step on the closing's record so a retry carries on. An organization being closed is still out of its members' reach (`is_org_member()`, `has_org_role()`, `can_access_location()`, `can_access_scan()`), unscanned, and held. `closings` has no policy or grant for an API role, keeps the addresses only until the email has gone and the fingerprint only thirty days, and the fingerprint is still checked in `create_organization()`. `export_organization()` answers only an owner, never the operator, as one value, and never holds a sign-in, the operator's record of changes or what providers were paid. |
| touches stronger models, tiers, `stronger_surfaces`, a price version's stronger price, `cellKey` or the tuning's `stronger` blocks | A request still only changes the subscription at the provider: `stronger_surfaces` is written by `apply_plan()` alone, from the lines the webhook read back, and none is kept on a plan without the `stronger_models` allowance. The stronger price is still part of the price version, an amount for each location paid for with a provider price for each assistant, and a dearer one or one no longer sold still counts as going up when announced. Each stronger line still counts the locations paid for, the included ones as well, and moves in the same change as they do. Stronger is still refused on an assistant the organization is not checked on, one the tuning has no `stronger` block for, and a test organization. Each result and drop still keeps its tier, and the score and the alerts still share `cellKey`, so a change of tier starts the cell again in both. |
| touches `apps/pages`, `hosted_pages`, `hosted_page_fetches`, `hosted_page()` or `record_page_fetch()` | The Pages Worker holds no secret, reads only through `hosted_page()` and writes only a count through `record_page_fetch()`, with the publishable key; no other table, no other write, nothing of the app, and no hosted page served from the main Worker. `hosted_page()` answers only for a live answer subdomain and gives only what the page shows anyway; `hosted_pages` and `hosted_page_fetches` have no policy or grant for a caller who is not signed in and no write from an API role. `record_page_fetch()` trusts nothing it is told: its own day, a live page, a known fetcher, a ceiling a day. Nothing is kept about a fetch but the count, nothing is worked out from it, and `PAGE_FETCHERS` and the check on `hosted_page_fetches.fetcher` name the same fetchers. It hands on any request for `nearcited.com` or a subdomain of it. A page is plain HTML: no script but the structured details, no cookie, image or tracking, every word written as text, and nothing of Nearcited's but a generator tag. |
| adds or changes the structured details  | A block composed by rule from the location's own details (`packages/shared/src/structured-details.ts`): a detail not on file is left out and named in `missing`, never filled in, and no model writes any of it. |
| adds a prompt, weight or sampling value | A field and placeholder default in `TuningSchema`, passed to the code as an argument. The real value goes in `private/tuning.json`, never in this diff. No web file imports a value from the tuning module.          |
| touches `PROVIDER_MODE` or the banner   | Mock mode still requires exactly `"mock"`, the sample-data banner still shows while it is on, and live scans still refuse the default tuning.                                                                                                      |
| touches sample data, `is_test` or `platform_roles` | A test organization's scans are still generated, recorded as `sample_data`, shown under the banner, and never reach a real provider, a site or an inbox. Nothing a request can do writes `platform_roles` or `organizations.is_test`. |
| touches billing, `subscriptions` or the webhook | The webhook still verifies the signature before reading the body, acts only on the subscription read back from the provider, and is the only caller of `applyPlan` on a request. No request path writes `subscriptions`. Checkout, the account pages and the subscription change routes answer only an organization's owner, and decide upgrade or downgrade on the server. A price is never edited in place: a change makes new prices and keeps the old ones in `plan_prices`, so a subscription still matches its plan. Nothing but `runPriceChangeStep` changes what a running subscription is billed at, and the thirty-day notice check stays per organization. Nothing lowers a paid plan's limits or allowances but an announced reduction made by `apply_limit_change()`; `operator_set_plan()` refuses to on a plan with subscribers. |
| changes any `package.json` dependencies | A licence that combines with AGPL-3.0-only (MIT, ISC, BSD, Apache-2.0, MPL-2.0 pass; anything else is a stop until checked), and an updated `pnpm-lock.yaml`.                                          |
| touches `.agents/skills/` or `.claude/agents/` | Regenerated `.claude/skills/` and `.codex/agents/` (step 4 runs the sync).                                                                                                                      |
| mentions prompts, weights, pricing, a vendor quote, what something was measured to use or cost, or a real business | None of it. That content lives in `private/` (see "Private companion" in `AGENTS.md`); move it there and leave at most a note that it exists. A provider's published rate is public and may stay; a recorded response in a test carries made-up usage numbers. The private repository's name appears nowhere in the diff. |
| adds any file                           | No secrets and no real customer or prospect data: the repository is public. `.dev.vars` and `.env.local` stay untracked.                                                                               |

**Done when:** every row whose trigger matches the diff has been checked, and each
gap is fixed or reported.

### 3. Refresh the docs the diff made stale

Dispatch the `docs-updater` agent in **fix** mode, scoped to this branch's diff
(`"$base"..HEAD`), and tell it what step 2 changed. It owns the table of which
document holds which fact. Where the harness cannot dispatch an agent, read
[`.claude/agents/docs-updater.md`](../../../.claude/agents/docs-updater.md) and
follow it yourself.

A pure refactor or test change usually owes no doc edit; the agent's report
saying so is a complete result.

**Done when:** the agent's report is in hand, and each drift it could not
resolve from code is fixed or carried into step 7.

### 4. Checks: refuse to push if any fail

```bash
pnpm sync:agents      # regenerate .claude/skills, so the agent config check passes
pnpm format           # Biome fixes, including the files the steps above edited
pnpm check            # lint, typecheck, every unit test, build
```

`pnpm check` is the first required CI job, minus the Worker bundle check, and takes
well under a minute. Add the bundle check when the diff touches `apps/api`:

```bash
pnpm --filter @nearcited/api exec wrangler deploy --dry-run --outdir dist
```

The store integration test needs Postgres and PostgREST and runs in CI. When the
diff touches `apps/api/src/store/` or a migration, say in the report that this
test is the one that covers it and that it has not run locally, unless
`POSTGREST_URL` is set and you ran it.

The end-to-end tests drive the app in a browser and are a required check. They need
the local Supabase stack, so `pnpm check` does not run them. When the diff touches
`apps/web`, a route the web app calls, or `apps/e2e`, run them before pushing, which
is quicker than waiting for CI to say no:

```bash
pnpm e2e              # needs `supabase start`, and `pnpm local:env` once
```

Where the stack is not running, say in the report that CI is what will run them.

If any command is red, stop and report.

### 5. Commit what the steps above changed

```bash
git add -A
git commit -m "<what the docs or generated files now say>"
```

Commit subjects here are plain sentences in the imperative ("Add the location
edit form"), with no type prefix. Skip the commit when steps 2 to 4 changed
nothing.

### 6. Push and open or update the PR

```bash
git push -u origin "$(git branch --show-current)"
gh pr list --head "$(git branch --show-current)" --state open --json number -q '.[0].number'
```

- **No PR**: `gh pr create --base main`, with the body following
  `.github/pull_request_template.md`: What changed, How it was checked, and the
  Before merging checklist ticked from what steps 2 and 4 actually established.
- **PR exists**: `gh pr edit <number>` to refresh the body.

Write `Closes #N` in the body for each issue the branch finishes, so the merge
closes it and the [project board](https://github.com/users/jwh3times/projects/10) moves it to Done. A branch that closes
no issue is worth one line in the report: either the work was untracked, or an
issue should exist.

### 7. Report

Give the user: the PR URL; the issues it closes; what step 2 found and fixed or
left for them; which docs changed; and the state of the checks, saying which ran
locally and which only CI covers. CodeQL and the Copilot review also report on
the PR and can block the merge.

`/ship` covers this repository only. When the same work changed `private/`,
commit and push there separately (`git -C private status`), and say in the
report whether that is done. The PR body does not mention it.

Merging is the user's call. `/ship` stops at "PR open".
