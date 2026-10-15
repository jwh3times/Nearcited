# Security

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Please do not open a public issue for a security problem.

Include what you did, what you expected, and what happened instead. A request you can replay
or a failing test is the most useful thing you can send.

There is no bug bounty.

## What counts most

Nearcited is multi-tenant, and tenant isolation is enforced by Postgres row-level security
(see `docs/architecture.md`). The reports that matter most are:

- Reading or changing another organization's locations, queries, scans, results or
  recommendations.
- Acting as the operator without the role. The operator may read every organization, and may
  change only an organization's limits and a plan's settings and prices, each through a function
  that records it. Without the role, each of these is a report:
  - reading another organization's rows, the `audits`, `provider_usage` or `operator_actions`
    tables, or a row from `usage_by_month()`, which adds up `provider_usage`;
  - calling `operator_accounts()`, which lists every account's email and sign-in times;
  - calling `operator_set_limits()`, `operator_set_plan()` or `operator_set_plan_prices()`;
  - announcing or calling off a price change (`operator_announce_price_change()`,
    `operator_call_off_price_change()`) or a reduction in a plan's limits
    (`operator_announce_limit_change()`, `operator_call_off_limit_change()`);
  - writing `plan_prices`, `allowance_kinds`, `price_changes`, `price_change_notices`,
    `limit_changes` or `limit_change_notices`;
  - making an audit through `operator_create_audit()`.
- Changing what an organization's plan allows from a member's request: calling `apply_plan()`,
  `fit_to_plan()` or `fit_connections_to_plan()`, or writing a limit, `allowances`, `plan_key`,
  `paused_by_plan` or `set_aside_by_plan` directly.
- Using up or clearing an organization's allowance: writing `allowance_use` as a signed-in user, or
  calling `claim_allowance()`, `release_allowance()` or `allowance_has_room()` as anyone but the
  worker. Also getting an action of a counted kind proposed, approved or carried out past the
  month's number, or a draft asked for or written past it.
- Reading a connection's sign-in, sealed or not, by any path: `connection_secrets` has no policy
  and no grant for any API role, the operator included, and no route, response or log line carries
  a sign-in. The same goes for the `CONNECTIONS_KEY` that seals it.
- Connecting, matching or removing an account as anyone but the organization's owner or an admin:
  calling `create_connection()`, `match_connection_location()`,
  `unmatch_connection_location()` or `request_connection_removal()` for an organization the caller
  is not an owner or admin of, matching a location of another organization, or writing
  `connections` or `connection_locations` directly, or reading or writing
  `connection_kind_allowances`, which no API role reaches. Also calling
  `finish_connection_removal()`, which deletes a sign-in, `expire_paused_connections()`, which
  starts removing them, or `record_connection_sync()`, `record_connection_failure()` or
  `connections_due_for_sync()`, as anyone but the worker.
- Connecting a WordPress site as anyone but an owner or an admin of the location's organization,
  through `POST /api/locations/:locationId/wordpress` or `create_connection()` with a
  `from_location`: a plain member, the operator and a caller who is not signed in must get
  nothing, and a `from_location` that is not a location of the same organization must make no
  connection. `POST /api/locations/:locationId/wordpress/check` is held to the same callers.
  Also the application password WordPress hands back appearing in any response, log line or
  stored place but the sealed sign-in, sent anywhere but over https to the site's own host, or
  sent on through a redirect; and the requests made to a location's website, which must stay on
  public addresses with each redirect checked (`WORDPRESS_LOCAL_ORIGIN` is for a developer's own
  machine and is never set on a deployment).
- The return page, `/wordpress/return`: the address WordPress sends the owner back to carries a
  user name and a new application password. They must be taken off the address before the app
  draws, believed only with the state the same tab kept, posted once, and never sent on in a
  `Referer` (the page is served with `Referrer-Policy: no-referrer`). Getting the product to
  connect a site on a forged return is a report.
- Answering an action as anyone but a member of its location's organization: calling
  `approve_action()`, `decline_action()`, `retry_action()` or `take_back_action()` for a location
  the caller is not a member of, the operator included, or writing `actions` directly.
- Proposing or carrying out an action as anyone but the worker: calling `propose_action()`,
  `claim_action()`, `finish_action()`, `lapse_actions()` or `drop_expired_seen()`, or getting a
  request to propose one, carry one out or write through a connection. Also reading or writing
  `sample_listings` or `action_kind_terms`, which no API role reaches.
- Raising or clearing an alert as anyone but the worker, or dismissing one as anyone but a member
  of its location's organization: writing `alerts` directly, calling `complete_scan()`, or calling
  `dismiss_alert()` for a location the caller is not a member of, the operator included. Also
  calling `seen_before()`, which returns what any location's earlier scans named and cited, as
  anyone but the worker.
- Asking for a draft as anyone but a member of its location's organization, or writing one as
  anyone but the worker: calling `ask_draft()` for a location the caller is not a member of, the
  operator included, writing `drafts` directly, or calling `claim_draft()` or `finish_draft()` as
  anyone but the worker. Also getting a request to write a draft, or to decide what one is written
  from.
- Giving a location's listing on a site, or taking it away, as anyone but a member of the
  location's organization: calling `set_listing()` or `remove_listing()` for a location the caller
  is not a member of, the operator included, or writing `listings` directly. Also getting one kept
  that is not an address over https, or getting the product to open one.
- Giving the address of a page task's page, or taking it away, as anyone but a member of the
  location's organization: calling `set_prompt_page()` or `remove_prompt_page()` for a location the
  caller is not a member of, the operator included, or for a task that is not a page task, or
  writing `prompt_pages` directly. Also getting one kept that is not an address over https, or
  getting the product to open one.
- Changing a business's site beyond the block the product marked as its own: an action that edits,
  removes or reads past the `<!-- nearcited:details -->` block, or that writes to a page when the
  block on it is no longer what the member was shown. Also getting text of a member's or a
  caller's choosing into that block: approving with a `text` for a kind that is approved as
  proposed (`not_editable`), or having `carryOutAction` write an `approved_text` for one.
- Taking back what an action did, or keeping what it replaced past its day: clearing a task an
  action marked done, or writing `recommendations.acted_by_action`, as a signed-in user; or finding
  a copy of what an action replaced anywhere but `seen`, which `drop_expired_seen()` clears once
  its `seen_until` has passed.
- Getting an action carried out for an organization that is held, or marked told when its owners
  were not: calling `organization_held()` as anyone but the worker, writing `told_at` or
  `waiting_told_at`, approving a real action where no email could tell its owners, or learning from
  `location_held()` anything about a location the caller cannot read.
- Getting `choose_assistants()` or `activate_location()` to act on an organization the caller
  does not belong to.
- Getting a second organization on one account, or deleting or moving an organization.
- Writing scan results, scores or recommendations as a signed-in user. Only the worker should be
  able to.
- Granting yourself a platform role, or marking an organization as a test one.
- Calling a worker-only database function through the public API.
- Getting past token verification on `/api/*`.
- Forging the payment webhook: getting `/api/stripe/webhook` to act on a request Stripe did not
  sign, or on a replayed or reordered one. It needs no sign-in and uses the Worker's secret key,
  so the signature is its only guard. The same applies to `claim_subscription_start()`, which only the worker may call.
- Getting a plan without paying for it, or keeping one after the subscription ended: changing an
  organization's plan, limits or allowances, or writing `subscriptions`, as a signed-in user. Checkout and
  the billing portal are for an organization's owner only.
- Lowering a paid plan's limits or allowances without the announcement: through
  `operator_set_plan()`, or by calling `apply_limit_change()` as anyone but the worker.
- Moving a subscription to a higher price without its owners having been told at least thirty
  days before.
- Counting a visit that `record_visit()` should refuse, or learning anything from `POST /api/visits`.
  The route needs no sign-in and the site key is in the site's source, so the checks inside the
  function are the only guard: a visit for a page that is not on the location's own website, for a
  plan that does not include visits, for a day other than today, past a location's day of 1,000
  visits under 50 pages, or for an assistant that is not listed. Also the route saying whether a
  key is somebody's, a table or function behind it reachable by a caller who is not signed in
  (`visits` and `visit_lines` have no grant for one; `new_site_key()`, `site_host()`,
  `counts_visits()` and `give_location_a_line()` are callable by neither `anon` nor
  `authenticated`), writing either
  table other than through `record_visit()`, `check_visit_line()` and `replace_site_key()`, or
  finding anything about a visitor kept with a count. Posting made-up visits within those bounds,
  with a key read from a site, is known: the count can be padded and nothing is worked out from it.
- Replacing a location's site key as anyone but an owner or an admin of its organization, through
  `replace_site_key()` or `POST /api/locations/:locationId/line/key`: a plain member, the operator,
  the worker, a member of another organization and a caller who is not signed in must get nothing,
  and the key must not change. Also reading a location's line, through
  `GET /api/locations/:locationId/line`, as someone who cannot read the location.
- Reading another organization's visit counts, through `location_visits()` or
  `GET /api/locations/:locationId/visits`. The function runs as the caller, so row-level security
  decides what it adds up, and it is granted to signed-in users and the service role and not to
  `anon`. A member of another organization must get nothing from it, and a caller who is not
  signed in must not be able to call it.
- Reading a shareable audit without its link, or after it was revoked or expired; listing audits;
  or creating one. `/api/audits/:token` is the one route that gives out an organization's data
  with no sign-in, and the token in the link is the only key to it. `/api/plans` needs no sign-in
  either: it is the price list, and holds nothing that belongs to a tenant.

## Supported versions

Only the current `main` branch.
