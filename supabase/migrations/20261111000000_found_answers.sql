-- "How did you find us?" on the way from a review request to the review form (issue #148,
-- docs/adr/0033-a-found-answer-is-counted-on-the-way-to-the-review-form.md).
--
-- The link in a review request is the product's own, signed, and carries the request's action and
-- the review form. Its route has no sign-in and reads nothing: it queues the worker, which counts
-- here. What is kept is a count for a location, a month and an answer, and nothing about who
-- answered: the only thing tied to a request is that it was answered, never what, and it goes with
-- the request. The answers are never added to the visits from assistants, and nothing is worked out
-- from them: anyone holding a link can tap anything. Beside them, for the operator, the deployment's
-- monthly count of how many opened the question and how many went on to the form.
--
-- The Worker deployed before this migration is not touched by it: it writes none of these tables,
-- calls none of these functions, and export_organization() gains a list its schema leaves out.

-- How many customers gave each answer at a location in a month, as the location's time zone has
-- it. Written only by record_found_answer().
create table public.found_answers (
  location_id uuid not null references public.locations (id) on delete cascade,
  -- The first day of the month.
  month date not null check (extract(day from month) = 1),
  answer text not null check (
    answer in ('assistant', 'search', 'someone_they_know', 'been_before', 'something_else', 'skipped')
  ),
  -- Which assistant, for an assistant answer, as the shared list names them (`FOUND_ASSISTANTS`),
  -- or none where the customer did not say.
  assistant text check (
    assistant in ('chatgpt', 'gemini', 'perplexity', 'copilot', 'claude', 'other')
  ),
  count integer not null check (count > 0),
  -- Made up for a request that went to nobody: a test organization's, or on sample data.
  sample_data boolean not null default false,
  check (answer = 'assistant' or assistant is null),
  unique nulls not distinct (location_id, month, answer, assistant, sample_data)
);

comment on table public.found_answers is
  'How many customers who followed a review request gave each answer to "How did you find us?" at a location in a month. Never added to visits. Written only by record_found_answer().';

-- A member reads their locations' counts, and the operator reads every one. Nobody writes one but
-- record_found_answer(), which only the worker calls, and a caller who is not signed in reads none.
alter table public.found_answers enable row level security;
revoke all on public.found_answers from public, anon, authenticated;
grant select on public.found_answers to authenticated;
grant all on public.found_answers to service_role;

create policy "Members read their locations' found answers"
  on public.found_answers for select to authenticated
  using (public.can_access_location(location_id));

create policy "The operator reads found answers"
  on public.found_answers for select to authenticated
  using ((select public.is_operator()));

-- The review requests whose found answer was counted, so that one request counts once. Says
-- nothing of what was answered, and goes with the request. No API role reads it.
create table public.found_answered (
  action_id uuid primary key references public.actions (id) on delete cascade,
  answered_at timestamptz not null default now()
);

comment on table public.found_answered is
  'The review requests whose found answer was counted, and nothing of what it was. Worker only.';

alter table public.found_answered enable row level security;
revoke all on public.found_answered from public, anon, authenticated;
grant all on public.found_answered to service_role;

-- For the deployment by month (UTC): how many opened the question and how many went on to the
-- form, answering or not. Whether the question costs reviews is read from these (ADR 0033). They
-- belong to no organization. The operator reads them, and nobody else.
create table public.found_question_counts (
  month date primary key check (extract(day from month) = 1),
  opened integer not null default 0 check (opened >= 0),
  went_on integer not null default 0 check (went_on >= 0)
);

comment on table public.found_question_counts is
  'How many opened "How did you find us?" and how many went on to the review form, for the deployment by month. Written only by record_found_opened() and record_found_answer().';

alter table public.found_question_counts enable row level security;
revoke all on public.found_question_counts from public, anon, authenticated;
grant select on public.found_question_counts to authenticated;
grant all on public.found_question_counts to service_role;

create policy "The operator reads the found question's counts"
  on public.found_question_counts for select to authenticated
  using ((select public.is_operator()));

-- Counts an opening of the question, for the deployment this month. Worker only.
create function public.record_found_opened()
returns void
language sql security definer set search_path = ''
as $$
  insert into public.found_question_counts (month, opened)
  values (date_trunc('month', now() at time zone 'UTC')::date, 1)
  on conflict (month) do update set opened = public.found_question_counts.opened + 1;
$$;

revoke execute on function public.record_found_opened() from public, anon, authenticated;
grant execute on function public.record_found_opened() to service_role;

-- Counts a found answer for a review request, by its action. Unless `sample`, it counts once more
-- for the deployment this month as going on to the form, whatever became of the answer. The first
-- time for the action only, it counts the answer for the action's location in the location's
-- month, as sample data where `sample`. Says what became of it: `counted`, `already`, where the
-- request was answered before, or `gone`, where there is no such review request. Worker only.
create function public.record_found_answer(
  action uuid,
  answer text,
  assistant text,
  sample boolean
)
returns text
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  loc uuid;
  zone text;
begin
  if record_found_answer.answer is null or (
    record_found_answer.assistant is not null and record_found_answer.answer <> 'assistant'
  ) then
    raise exception 'Only an assistant answer names an assistant.' using errcode = '22023';
  end if;
  select a.location_id, coalesce(l.time_zone, 'UTC') into loc, zone
  from public.actions a
  join public.locations l on l.id = a.location_id
  where a.id = record_found_answer.action and a.kind = 'review_request';
  if not found then
    return 'gone';
  end if;
  if not sample then
    insert into public.found_question_counts (month, went_on)
    values (date_trunc('month', now() at time zone 'UTC')::date, 1)
    on conflict (month) do update set went_on = public.found_question_counts.went_on + 1;
  end if;
  insert into public.found_answered (action_id) values (record_found_answer.action)
  on conflict do nothing;
  if not found then
    return 'already';
  end if;
  insert into public.found_answers as f (location_id, month, answer, assistant, count, sample_data)
  values (
    loc, date_trunc('month', now() at time zone zone)::date, record_found_answer.answer,
    record_found_answer.assistant, 1, sample
  )
  on conflict (location_id, month, answer, assistant, sample_data)
  do update set count = f.count + 1;
  return 'counted';
end;
$$;

revoke execute on function public.record_found_answer(uuid, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.record_found_answer(uuid, text, text, boolean) to service_role;

-- A location's found answers over the six months shown, this one included, in the location's time
-- zone, of sample data or not, as the caller reads them: none for anyone who cannot read the
-- location. A month is written `YYYY-MM`.
create function public.location_found_answers(location uuid, sample boolean)
returns table (month text, answer text, assistant text, count integer)
language sql stable security invoker set search_path = ''
as $$
  select to_char(f.month, 'YYYY-MM'), f.answer, f.assistant, f.count
  from public.found_answers f
  join public.locations l on l.id = f.location_id
  where f.location_id = location_found_answers.location
    and f.sample_data = location_found_answers.sample
    and f.month >= (date_trunc('month', now() at time zone coalesce(l.time_zone, 'UTC'))
                    - interval '5 months')::date
  order by f.month, f.answer, f.assistant nulls first;
$$;

revoke execute on function public.location_found_answers(uuid, boolean) from public, anon;
grant execute on function public.location_found_answers(uuid, boolean)
  to authenticated, service_role;

-- export_organization() carries the organization's found answers. Otherwise as before.
create or replace function public.export_organization(org uuid)
returns jsonb
language sql
stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'version', 1,
    'exported_at', now(),
    'organization', (
      select to_jsonb(r) from (
        select id, name, max_locations, max_queries_per_location, max_manual_scans_per_month,
          scan_every_days, surfaces, stronger_surfaces, is_test, emails_report, allowances,
          plan_key, created_at
        from public.organizations where id = o.id
      ) r
    ),
    'subscription_status', (
      select s.status from public.subscriptions s where s.organization_id = o.id
    ),
    'members', coalesce((
      select jsonb_agg(
        jsonb_build_object('email', u.email, 'role', m.role, 'joined_at', m.created_at)
        order by m.created_at, m.role, u.email
      )
      from public.memberships m
      left join auth.users u on u.id = m.user_id
      where m.organization_id = o.id
    ), '[]'),
    'locations', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from (
        select id, organization_id, name, website, phone, address_line, city, region,
          postal_code, country_code, google_place_id, latitude, longitude, point_source,
          geocoded_from, primary_category, what_we_do, time_zone, paused_by_plan, last_scanned_at,
          created_at
        from public.locations where organization_id = o.id
      ) r
    ), '[]'),
    'prompts', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from (
        select q.id, q.location_id, q.kind, q.text, q.is_active, q.set_aside_by_plan, q.created_at
        from public.tracked_queries q
        join public.locations l on l.id = q.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'scans', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from (
        select s.id, s.location_id, s.status, s.trigger, s.visibility_score, s.error,
          s.sample_data, s.tiers, s.created_at, s.started_at, s.finished_at
        from public.scans s
        join public.locations l on l.id = s.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'answers', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.sampled_at, r.id) from (
        select x.id, x.scan_id, x.tracked_query_id, x.surface, x.shown, x.mentioned, x.position,
          x.competitors, x.cited_urls, x.answer_excerpt, x.phones, x.tier, x.sampled_at
        from public.scan_results x
        join public.scans s on s.id = x.scan_id
        join public.locations l on l.id = s.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'tasks', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from (
        select t.id, t.location_id, t.scan_id, t.rule, t.title, t.detail, t.status, t.acted_at,
          t.acted_by_action, t.created_at
        from public.recommendations t
        join public.locations l on l.id = t.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'alerts', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.raised_at, r.id) from (
        select a.id, a.location_id, a.kind, a.tracked_query_id, a.surface, a.tier, a.facts, a.since,
          a.scan_id, a.raised_at, a.cleared_at, a.clear_reason, a.dismissed_at,
          a.dismissed_by_email
        from public.alerts a
        join public.locations l on l.id = a.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'drafts', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.asked_at, r.id) from (
        select d.id, d.location_id, d.recommendation_id, d.status, d.asked_by_email, d.asked_at,
          d.failure, d.kind, d.text, d.written_at, d.sample_data
        from public.drafts d
        join public.locations l on l.id = d.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'actions', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.proposed_at, r.id) from (
        select a.id, a.location_id, a.kind, a.connection_id, a.summary, a.seen,
          a.seen_dropped_at, a.proposed_text, a.written_by, a.status, a.proposed_at, a.lapses_at,
          a.due_at,
          a.approved_by_email, a.approved_at, a.approved_text, a.declined_by_email,
          a.declined_at, a.decline_reason, a.done_at, a.failed_at, a.failure, a.lapsed_at,
          a.lapse_reason, a.retry_of, a.takes_back, a.approved_under, a.approved_under_by_email,
          a.approved_under_at, a.always_asks
        from public.actions a
        join public.locations l on l.id = a.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'standing_permissions', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.given_at, r.id) from (
        select s.id, s.kind, s.given_by_email, s.given_at, s.ended_at, s.ended_by_email,
          s.end_reason, s.ended_by_action
        from public.standing_permissions s where s.organization_id = o.id
      ) r
    ), '[]'),
    'invitations', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id) from (
        select i.id, i.organization_id, i.email, i.role, i.invited_by_email, i.created_at,
          i.sent_at, i.expires_at, i.ended_at, i.outcome
        from public.invitations i where i.organization_id = o.id
      ) r
    ), '[]'),
    'connections', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.connected_at, r.id) from (
        select c.id, c.organization_id, c.kind, c.label, c.status, c.connected_by_email,
          c.connected_at, c.removed_by_email, c.removal_requested_at, c.removed_at,
          c.broken_reason, c.broken_at, c.paused_at, c.removal_reason, c.last_synced_at,
          c.choices,
          coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'location_id', cl.location_id, 'external_id', cl.external_id,
                'external_label', cl.external_label, 'matched_at', cl.matched_at
              )
              order by cl.matched_at, cl.location_id
            )
            from public.connection_locations cl where cl.connection_id = c.id
          ), '[]') as matches
        from public.connections c where c.organization_id = o.id
      ) r
    ), '[]'),
    'listings', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.set_at, r.site) from (
        select g.location_id, g.site, g.url, g.set_by_email, g.set_at
        from public.listings g
        join public.locations l on l.id = g.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'page_addresses', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.set_at, r.recommendation_id) from (
        select p.location_id, p.recommendation_id, p.url, p.set_by_email, p.set_at, p.action_id
        from public.prompt_pages p
        join public.locations l on l.id = p.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'visits', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.day, r.location_id, r.assistant, r.path) from (
        select v.location_id, v.day, v.assistant, v.path, v.count
        from public.visits v
        join public.locations l on l.id = v.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'hosted_pages', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.published_at, r.id) from (
        select h.id, h.location_id, n.hostname, h.slug, h.title, h.copy, h.published_at,
          h.taken_back_at
        from public.hosted_pages h
        join public.locations l on l.id = h.location_id
        left join public.answer_subdomains n on n.connection_id = h.connection_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'page_fetches', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.day, r.hosted_page_id, r.fetcher) from (
        select f.hosted_page_id, f.location_id, f.day, f.fetcher, f.count
        from public.hosted_page_fetches f
        join public.locations l on l.id = f.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'site_fetches', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.day, r.location_id, r.fetcher, r.path) from (
        select f.location_id, f.day, f.fetcher, f.path, f.count, f.sample_data
        from public.site_fetches f
        join public.locations l on l.id = f.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    'analytics_visits', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.day, r.location_id, r.assistant, r.path) from (
        select a.location_id, a.day, a.assistant, a.path, a.count, a.sample_data
        from public.analytics_visits a
        join public.locations l on l.id = a.location_id
        where l.organization_id = o.id
      ) r
    ), '[]'),
    -- The receipt address is written out whole, as the shared package's receiptAddress() writes
    -- it: a subaddress of the receipts mailbox.
    'review_requests', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.address_made_at, r.connection_id) from (
        select s.connection_id, s.location_id,
          'receipts+' || s.receipt_address || '@nearcited.com' as receipt_address,
          s.address_made_at, s.site, s.reply_to, s.released_at
        from public.review_request_settings s
        where s.organization_id = o.id
      ) r
    ), '[]'),
    'found_answers', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.month, r.location_id, r.answer, r.assistant) from (
        select f.location_id, to_char(f.month, 'YYYY-MM') as month, f.answer, f.assistant,
          f.count, f.sample_data
        from public.found_answers f
        join public.locations l on l.id = f.location_id
        where l.organization_id = o.id
      ) r
    ), '[]')
  )
  from public.organizations o
  where o.id = org
    and exists (
      select 1 from public.memberships m
      where m.organization_id = o.id and m.user_id = (select auth.uid()) and m.role = 'owner'
    );
$$;
